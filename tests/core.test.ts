import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  ProjectMemory,
  ProjectMemoryError,
  parseNoteFile,
  serializeNote,
  writeNoteFile,
  type CaptureInput,
  type NoteType,
} from "../src/index.ts";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

function fixture(): { cwd: string; memory: ProjectMemory } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-test-"));
  fs.writeFileSync(path.join(cwd, "state.yaml"), "milestones:\n  P0: complete\n");
  fs.writeFileSync(path.join(cwd, "SPEC.md"), "# Canonical Spec\n");
  const memory = new ProjectMemory(cwd);
  memory.init({ project_id: "fixture", canonical_state_file: "state.yaml" });
  return { cwd, memory };
}

function input(type: NoteType, suffix: string = type): CaptureInput {
  const defaults: Record<NoteType, Partial<CaptureInput>> = {
    deferred_work: {
      trigger: {
        mode: "all",
        conditions: [{ kind: "milestone", key: "P0", operator: "equals", value: "complete" }],
      },
      priority: "P1",
    },
    decision: {},
    open_question: {},
    assumption: {},
    risk: {},
    idea: {},
  };
  return {
    type,
    title: `Title ${suffix}`,
    summary: `Summary ${suffix}`,
    rationale: `Rationale ${suffix}`,
    next_action: `Next ${suffix}`,
    source_refs: [{ kind: "manual", ref: `test://${suffix}` }],
    ...defaults[type],
  };
}

function expectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof ProjectMemoryError && error.code === code);
}

test("uninitialized projects fail closed on read and retrieval paths", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-uninitialized-"));
  const memory = new ProjectMemory(cwd);
  expectCode(() => memory.read("PM-IDE-0001"), "MISSING_CONFIG");
  expectCode(() => memory.search({}), "MISSING_CONFIG");
  expectCode(() => memory.taskStartRetrieval(), "MISSING_CONFIG");
});

test("six note types capture, exact dedup, search, and index rebuild", () => {
  const { cwd, memory } = fixture();
  const ids: string[] = [];
  for (const type of ["deferred_work", "decision", "open_question", "assumption", "risk", "idea"] as NoteType[]) {
    const receipt = memory.capture(input(type));
    assert.equal(receipt.status, "created");
    ids.push(receipt.id);
  }
  assert.equal(new Set(ids).size, 6);

  const merged = memory.capture({
    ...input("deferred_work"),
    source_refs: [{ kind: "manual", ref: "test://second-source" }],
  });
  assert.equal(merged.status, "merged");
  assert.equal(merged.id, ids[0]);
  assert.equal(merged.note.source_refs.length, 2);

  assert.equal(memory.search({ includeTerminal: false }).length, 6);
  const idea = memory.search({ type: "idea" })[0]!;
  memory.close(idea.note.id, { status: "archived", status_reason: "not pursuing" });
  assert.equal(memory.search({ type: "idea" }).length, 0);
  assert.equal(memory.search({ type: "idea", includeTerminal: true }).length, 1);

  fs.rmSync(path.join(cwd, ".project-memory", "index"), { recursive: true, force: true });
  const report = memory.reconcile({ fixIndex: true });
  assert.equal(report.index.rebuilt, true);
  assert.equal(report.index.notes_indexed, 6);
  assert.ok(fs.existsSync(path.join(cwd, ".project-memory", "index", "notes.json")));
});

test("Project Memory notes cannot elevate themselves to canonical or source authority", () => {
  const { memory } = fixture();
  expectCode(
    () =>
      memory.capture({
        ...input("idea", "authority-canonical"),
        authority: "canonical",
      } as unknown as CaptureInput),
    "INVALID_INPUT",
  );
  const captured = memory.capture(input("idea", "authority-memory"));
  assert.equal(captured.note.authority, "memory");
  expectCode(
    () => memory.update(captured.id, { authority: "source" } as unknown as Parameters<ProjectMemory["update"]>[1]),
    "INVALID_INPUT",
  );
  assert.equal(memory.read(captured.id)!.note.authority, "memory");
});

test("accepted decisions need evidence and secrets fail closed", () => {
  const { memory } = fixture();
  expectCode(() => memory.capture({ ...input("decision", "accepted-no-proof"), status: "accepted" }), "INVALID_INPUT");
  const accepted = memory.capture({
    ...input("decision", "accepted-with-proof"),
    status: "accepted",
    acceptance_evidence: "User accepted in test://accepted-with-proof at 2026-08-29T10:00:00Z",
  });
  assert.equal(accepted.note.status, "accepted");
  expectCode(
    () =>
      memory.capture({
        ...input("risk", "secret"),
        summary: "token=supersecretvalue123456",
      }),
    "POLICY_VIOLATION",
  );
});

test("triggers use configured canonical state and unknown dependencies stay unresolved", () => {
  const { memory } = fixture();
  const due = memory.capture(input("deferred_work", "due"));
  const unresolved = memory.capture({
    ...input("deferred_work", "dependency"),
    trigger: {
      conditions: [{ kind: "dependency", key: "PM-QUE-9999", operator: "status_in", value: ["answered"] }],
    },
  });
  const state = memory.loadCanonicalState();
  assert.ok(state);
  const evaluation = memory.evaluateTriggers(state);
  assert.deepEqual(evaluation.due.map((item) => item.id), [due.id]);
  assert.deepEqual(evaluation.unresolved.map((item) => item.id), [unresolved.id]);
});

test("promote requires approval, mutates canonical text once, reads back, and replays idempotently", () => {
  const { cwd, memory } = fixture();
  const captured = memory.capture(input("idea", "promote"));
  const opts = {
    approved: true,
    promotion_id: "promotion-001",
    target: { kind: "spec" as const, path: "SPEC.md" },
    insertBlock: "## Accepted memory item\n\nThis text was explicitly approved.",
  };
  expectCode(() => memory.promote(captured.id, { ...opts, approved: false }), "INVALID_INPUT");
  const first = memory.promote(captured.id, opts);
  assert.equal(first.status, "promoted");
  const canonical = fs.readFileSync(path.join(cwd, "SPEC.md"), "utf8");
  assert.match(canonical, /Accepted memory item/);
  assert.match(canonical, new RegExp(`project-memory-derived-from: ${captured.id}`));

  const replay = memory.promote(captured.id, opts);
  assert.equal(replay.status, "replayed");
  const after = fs.readFileSync(path.join(cwd, "SPEC.md"), "utf8");
  assert.equal(after.match(/Accepted memory item/g)?.length, 1);

  const competing = memory.capture(input("idea", "competing-promote"));
  const beforeConflict = fs.readFileSync(path.join(cwd, "SPEC.md"), "utf8");
  expectCode(
    () =>
      memory.promote(competing.id, {
        approved: true,
        promotion_id: "promotion-002",
        target: { kind: "spec", path: "SPEC.md" },
        insertBlock: "## Unauthorized competing replacement",
      }),
    "CONFLICT",
  );
  assert.equal(fs.readFileSync(path.join(cwd, "SPEC.md"), "utf8"), beforeConflict);
  assert.equal(memory.read(competing.id)!.note.status, "captured");
  assert.equal(memory.read(competing.id)!.note.promotion.status, "not_promoted");

  assert.equal(memory.search({ id: captured.id })[0]!.note.promotion.status, "promoted");
  assert.equal(memory.search({ type: "idea" }).length, 1);
  assert.equal(memory.reconcile().issues.filter((issue) => issue.severity === "error").length, 0);
});

test("reconcile detects half-done promotion and supersedes cycles", () => {
  const { memory } = fixture();
  const first = memory.capture(input("idea", "cycle-a"));
  const second = memory.capture(input("idea", "cycle-b"));
  memory.update(first.id, { relations: { supersedes: [second.id] } });
  memory.update(second.id, { relations: { supersedes: [first.id] } });

  const firstFile = memory.read(first.id)!;
  firstFile.note.promotion = {
    status: "promoting",
    target: { kind: "spec", ref: "SPEC.md", path: "SPEC.md" },
    promotion_id: "interrupted-1",
    promoted_at: null,
    backlink: null,
    backlink_verified: false,
  };
  writeNoteFile(firstFile.file, firstFile.note, firstFile.body);

  const codes = new Set(memory.reconcile({ fixIndex: true }).issues.map((issue) => issue.code));
  assert.ok(codes.has("HALF_DONE_PROMOTE"));
  assert.ok(codes.has("SUPERSEDES_CYCLE"));
});

test("project boundaries reject canonical state and promote targets outside cwd", () => {
  const { cwd, memory } = fixture();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-outside-"));
  fs.writeFileSync(path.join(other, "OUT.md"), "outside");
  expectCode(
    () => new ProjectMemory(cwd).init({ project_id: "fixture", canonical_state_file: path.join(other, "OUT.md") }),
    "INVALID_INPUT",
  );
  const captured = memory.capture(input("idea", "outside"));
  expectCode(
    () =>
      memory.promote(captured.id, {
        approved: true,
        promotion_id: "outside-1",
        target: { kind: "spec", path: path.join(other, "OUT.md") },
        content: "no",
      }),
    "INVALID_INPUT",
  );
});

test("symlinked memory, state, note, and promote paths cannot escape the project", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-symlink-outside-"));

  const rootProject = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-symlink-root-"));
  fs.symlinkSync(outside, path.join(rootProject, ".project-memory"), "dir");
  expectCode(() => new ProjectMemory(rootProject).init({ project_id: "root-link" }), "INVALID_INPUT");
  assert.equal(fs.existsSync(path.join(outside, "config.yaml")), false);

  const configProject = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-symlink-config-"));
  fs.mkdirSync(path.join(configProject, ".project-memory"));
  const outsideConfig = path.join(outside, "outside-config.yaml");
  fs.writeFileSync(outsideConfig, "schema_version: 1\nproject_id: outside\ncreated_at: never\n");
  fs.symlinkSync(outsideConfig, path.join(configProject, ".project-memory", "config.yaml"));
  expectCode(() => new ProjectMemory(configProject).config(), "INVALID_INPUT");

  const noteProject = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-symlink-note-"));
  const noteMemory = new ProjectMemory(noteProject);
  noteMemory.init({ project_id: "note-link" });
  const ideas = path.join(noteProject, ".project-memory", "notes", "ideas");
  fs.rmSync(ideas, { recursive: true });
  fs.symlinkSync(outside, ideas, "dir");
  expectCode(() => noteMemory.capture(input("idea", "symlink-note")), "INVALID_INPUT");
  assert.equal(fs.readdirSync(outside).some((name) => name.startsWith("PM-IDE-")), false);

  const stateProject = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-symlink-state-"));
  const outsideState = path.join(outside, "outside-state.yaml");
  fs.writeFileSync(outsideState, "milestones:\n  P0: complete\n");
  fs.symlinkSync(outsideState, path.join(stateProject, "state.yaml"));
  expectCode(
    () => new ProjectMemory(stateProject).init({ project_id: "state-link", canonical_state_file: "state.yaml" }),
    "INVALID_INPUT",
  );

  const targetProject = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-symlink-target-"));
  const outsideTarget = path.join(outside, "outside-target.md");
  fs.writeFileSync(outsideTarget, "outside canonical bytes");
  fs.symlinkSync(outsideTarget, path.join(targetProject, "SPEC.md"));
  const targetMemory = new ProjectMemory(targetProject);
  targetMemory.init({ project_id: "target-link" });
  const captured = targetMemory.capture(input("idea", "symlink-target"));
  expectCode(
    () =>
      targetMemory.promote(captured.id, {
        approved: true,
        promotion_id: "symlink-target-1",
        target: { kind: "spec", path: "SPEC.md" },
        insertBlock: "must not escape",
      }),
    "INVALID_INPUT",
  );
  assert.equal(fs.readFileSync(outsideTarget, "utf8"), "outside canonical bytes");
  assert.equal(targetMemory.read(captured.id)!.note.status, "captured");
});

test("symlinked derived indexes and backlinks are rejected without reading or modifying outside files", () => {
  const { cwd, memory } = fixture();
  memory.capture(input("idea", "derived-symlink"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-derived-symlink-"));
  const poisonIndex = path.join(outside, "poison-index.json");
  fs.writeFileSync(poisonIndex, '{"notes":[{"id":"PM-IDE-9999"}]}');
  const notesIndex = path.join(cwd, ".project-memory", "index", "notes.json");
  fs.unlinkSync(notesIndex);
  fs.symlinkSync(poisonIndex, notesIndex);

  const poisonBacklink = path.join(outside, "poison-backlink.md");
  fs.writeFileSync(
    poisonBacklink,
    "# Project Memory backlink\n- target: OUT\n- kind: file\n- derived_from: PM-IDE-9999\n- promotion_id: evil\n",
  );
  fs.symlinkSync(poisonBacklink, path.join(cwd, ".project-memory", "backlinks", "evil.md"));

  const report = memory.reconcile({ fixIndex: true });
  const codes = new Set(report.issues.map((issue) => issue.code));
  assert.ok(codes.has("INDEX_SYMLINK"));
  assert.ok(codes.has("BACKLINK_SYMLINK"));
  assert.equal(fs.lstatSync(notesIndex).isSymbolicLink(), false);
  assert.doesNotMatch(fs.readFileSync(notesIndex, "utf8"), /PM-IDE-9999/);
  assert.equal(fs.readFileSync(poisonIndex, "utf8"), '{"notes":[{"id":"PM-IDE-9999"}]}');
  assert.match(fs.readFileSync(poisonBacklink, "utf8"), /PM-IDE-9999/);
});

test("concurrent promotes to one canonical target serialize to exactly one winner", { timeout: 30_000 }, async () => {
  const { cwd, memory } = fixture();
  const worker = `
    import fs from 'node:fs';
    import { ProjectMemory } from ${JSON.stringify(path.join(projectRoot, "src", "index.ts"))};
    while (!fs.existsSync(process.env.PM_GO)) await new Promise(r => setTimeout(r, 1));
    try {
      const out = new ProjectMemory(process.env.PM_CWD).promote(process.env.PM_ID, {
        approved: true,
        promotion_id: process.env.PM_PROMOTION,
        target: { kind: 'spec', path: process.env.PM_TARGET },
        insertBlock: '## ' + process.env.PM_ID
      });
      process.stdout.write(JSON.stringify({ok:true,id:out.id}));
    } catch (error) {
      process.stdout.write(JSON.stringify({ok:false,code:error.code}));
    }
  `;
  for (let round = 0; round < 3; round += 1) {
    const target = `RACE-${round}.md`;
    fs.writeFileSync(path.join(cwd, target), "# Race target\n");
    const first = memory.capture(input("idea", `promote-race-${round}-a`));
    const second = memory.capture(input("idea", `promote-race-${round}-b`));
    const go = path.join(cwd, `GO-${round}`);
    const run = (id: string, promotion: string) =>
      execFileAsync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", worker], {
        cwd: projectRoot,
        env: {
          ...process.env,
          PM_CWD: cwd,
          PM_GO: go,
          PM_ID: id,
          PM_PROMOTION: promotion,
          PM_TARGET: target,
        },
      }).then(({ stdout }) => JSON.parse(stdout) as { ok: boolean; id?: string; code?: string });
    const left = run(first.id, `race-${round}-a`);
    const right = run(second.id, `race-${round}-b`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    fs.writeFileSync(go, "go");
    const results = await Promise.all([left, right]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok && result.code === "CONFLICT").length, 1);
    const winner = results.find((result) => result.ok)!.id!;
    const loser = winner === first.id ? second.id : first.id;
    assert.equal(memory.read(winner)!.note.status, "promoted");
    assert.equal(memory.read(loser)!.note.status, "captured");
    const canonical = fs.readFileSync(path.join(cwd, target), "utf8");
    assert.match(canonical, new RegExp(`project-memory-derived-from: ${winner}`));
    assert.doesNotMatch(canonical, new RegExp(`## ${loser}`));
    const lockFiles = fs
      .readdirSync(path.join(cwd, ".project-memory", "locks"))
      .filter((name) => name.endsWith(".lock"));
    assert.deepEqual(lockFiles, []);
  }
});

test("exclusive note creation gives concurrent writers unique IDs", { timeout: 30_000 }, async () => {
  const { cwd, memory } = fixture();
  const worker = `
    import { ProjectMemory } from ${JSON.stringify(path.join(projectRoot, "src", "index.ts"))};
    const pm = new ProjectMemory(process.env.PM_CWD);
    const i = process.env.PM_I;
    const out = pm.capture({
      type: 'idea', title: 'Concurrent '+i, summary: 'Unique '+i,
      rationale: 'Concurrency test '+i, next_action: 'Review '+i,
      source_refs: [{kind:'manual', ref:'test://concurrent/'+i}]
    });
    process.stdout.write(out.id);
  `;
  const ids = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      execFileAsync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", worker], {
        cwd: projectRoot,
        env: { ...process.env, PM_CWD: cwd, PM_I: String(index) },
      }).then(({ stdout }) => stdout.trim()),
    ),
  );
  assert.equal(new Set(ids).size, 6);
  const report = memory.reconcile({ fixIndex: true });
  assert.equal(report.issues.filter((issue) => issue.code === "DUPLICATE_ID").length, 0);
  assert.equal(memory.search({ type: "idea" }).length, 6);
});
