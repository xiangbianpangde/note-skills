import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  fingerprintOf,
  ProjectMemory,
  ProjectMemoryError,
  parseNoteFile,
  serializeNote,
  writeFileAtomicBatch,
  writeNoteFile,
  type CaptureInput,
  type NoteType,
} from "../src/index.ts";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");

function fixture(): { cwd: string; memory: ProjectMemory } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-test-"));
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

function approvePromotion(
  memory: ProjectMemory,
  id: string,
  request: Parameters<ProjectMemory["planPromotion"]>[1],
): Parameters<ProjectMemory["promote"]>[1] {
  const plan = memory.planPromotion(id, request);
  const approval = memory.recordPromotionApproval(plan, {
    kind: "human",
    id: "pi-session://test-user",
    channel: "pi-ui",
  });
  return { ...request, approval_ref: approval.approval_ref };
}

test("uninitialized projects fail closed on read and retrieval paths", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-uninitialized-"));
  const memory = new ProjectMemory(cwd);
  expectCode(() => memory.read("PM-IDE-0001"), "MISSING_CONFIG");
  expectCode(() => memory.search({}), "MISSING_CONFIG");
  expectCode(() => memory.taskStartRetrieval(), "MISSING_CONFIG");
});

test("init fails fast when a legacy v0.3.x .project-memory root exists", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-legacy-root-"));
  const legacy = path.join(cwd, ".project-memory");
  fs.mkdirSync(path.join(legacy, "notes", "decision"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "config.yaml"), "schema_version: 1\nproject_id: old\n");
  fs.writeFileSync(
    path.join(legacy, "notes", "decision", "PM-OLD-0001.md"),
    "# note\n",
  );
  // v0.4.0 must refuse to silently start a fresh store next to old data.
  expectCode(() => new ProjectMemory(cwd).init({ project_id: "legacy" }), "CONFLICT");
  // A directory simply NAMED .project-memory without store markers is not treated as legacy.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-false-positive-"));
  fs.mkdirSync(path.join(empty, ".project-memory"));
  const res = new ProjectMemory(empty).init({ project_id: "fresh" });
  assert.equal(res.created, true);
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

  fs.rmSync(path.join(cwd, ".note-skills", "index"), { recursive: true, force: true });
  const report = memory.reconcile({ fixIndex: true });
  assert.equal(report.index.rebuilt, true);
  assert.equal(report.index.notes_indexed, 6);
  assert.ok(fs.existsSync(path.join(cwd, ".note-skills", "index", "notes.json")));
});

test("Note Skills notes cannot elevate themselves to canonical or source authority", () => {
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

test("trusted reads quarantine invalid authority, foreign project IDs, and empty IDs", () => {
  const { memory } = fixture();
  const authority = memory.capture(input("idea", "manual-authority"));
  const foreign = memory.capture(input("risk", "foreign-project"));
  const empty = memory.capture(input("decision", "empty-id"));

  const authorityFile = memory.read(authority.id)!;
  authorityFile.note.authority = "canonical" as never;
  writeNoteFile(authorityFile.file, authorityFile.note, authorityFile.body);
  const foreignFile = memory.read(foreign.id)!;
  foreignFile.note.project_id = "foreign-project";
  writeNoteFile(foreignFile.file, foreignFile.note, foreignFile.body);
  const emptyFile = memory.read(empty.id)!;
  emptyFile.note.id = "";
  writeNoteFile(emptyFile.file, emptyFile.note, emptyFile.body);

  assert.equal(memory.read(authority.id), null);
  assert.equal(memory.read(foreign.id), null);
  assert.equal(memory.read(empty.id), null);
  assert.equal(memory.search({ includeTerminal: true }).length, 0);
  const report = memory.reconcile({ fixIndex: true });
  assert.ok(report.issues.some((issue) => issue.code === "SCHEMA" && issue.file === authorityFile.file));
  assert.ok(report.issues.some((issue) => issue.code === "PROJECT_ID_MISMATCH" && issue.file === foreignFile.file));
  assert.ok(report.issues.some((issue) => issue.code === "SCHEMA" && issue.file === emptyFile.file && /id:/.test(issue.message)));
});

test("secret policy recursively scans nested capture/update fields and quarantines manual edits", () => {
  const { memory } = fixture();
  expectCode(
    () =>
      memory.capture({
        ...input("deferred_work", "nested-secret"),
        trigger: {
          conditions: [
            { kind: "milestone", key: "release", operator: "equals", value: "token=supersecretvalue123456" },
          ],
        },
      }),
    "POLICY_VIOLATION",
  );

  const captured = memory.capture(input("idea", "manual-nested-secret"));
  expectCode(
    () => memory.update(captured.id, { relations: { related_to: ["token=supersecretvalue123456"] } }),
    "POLICY_VIOLATION",
  );
  const file = memory.read(captured.id)!;
  file.note.created_by.id = "token=supersecretvalue123456";
  writeNoteFile(file.file, file.note, file.body);
  assert.equal(memory.search({ id: captured.id, includeTerminal: true }).length, 0);
  assert.ok(memory.reconcile().issues.some((issue) => issue.code === "SECRET_POLICY" && issue.noteId === captured.id));
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

test("task-start retrieval ranks an older prompt-relevant note above newer unrelated notes", () => {
  const { memory } = fixture();
  const relevant = memory.capture({
    ...input("risk", "database-migration"),
    title: "Database migration rollback",
    summary: "Preserve the rollback plan for the database migration",
  });
  for (let index = 0; index < 8; index += 1) {
    memory.capture(input("risk", `unrelated-ui-${index}`));
  }
  const retrieval = memory.taskStartRetrieval({
    text: "Implement the database migration rollback",
    types: ["risk"],
    limit: 3,
  });
  assert.equal(retrieval.active[0]?.note.id, relevant.id);
  assert.ok(retrieval.active[0]?.relevanceTerms?.includes("database"));
  assert.equal(retrieval.active.some((hit) => /unrelated-ui/.test(hit.note.title)), false);
});

test("broad generic prompts do not inject unrelated notes (retrieval noise regression)", () => {
  // Field report: '为什么我的 pi coding agent 的 b-ai 的模型无法使用？'
  // previously matched 6 unrelated notes via 模型/使用 (broad terms) and
  // polluted the context. Stop words + minimum-match gate must keep them out.
  const { memory } = fixture();
  memory.capture({
    ...input("decision", "phase3-state"),
    title: "Phase 3 学习者状态延后",
    summary: "quiz 事件回路已通，explain.state/v1 延后，模型与使用信号相关讨论",
  });
  memory.capture({
    ...input("risk", "analogy-hollow"),
    title: "analogyBreakage 空心话术风险",
    summary: "类比话术仅 warn 不阻断，需真实使用数据",
  });
  const retrieval = memory.taskStartRetrieval({
    text: "为什么我的 pi coding agent 的 b-ai 的模型无法使用？",
    types: ["decision", "risk"],
    limit: 10,
  });
  // Only strong/broad terms like 模型/使用 are in the prompt; the notes
  // otherwise share no specific term with it (b-ai, coding agent are
  // absent from their text) — injection must be suppressed.
  assert.equal(retrieval.active.length, 0, `expected no injection, got ${retrieval.active.length}`);
});

test("trusted canonical conflict evidence produces needs_review without overwriting lifecycle status", () => {
  const { cwd, memory } = fixture();
  const decision = memory.capture(input("decision", "canonical-conflict"));
  fs.writeFileSync(
    path.join(cwd, "state.yaml"),
    [
      "milestones:",
      "  P0: complete",
      "canonical_conflicts:",
      `  ${decision.id}:`,
      "    canonical_ref: SPEC.md#current-policy",
      "    reason: Canonical policy now requires a different choice",
      "",
    ].join("\n"),
  );
  const state = memory.loadCanonicalState()!;
  const retrieval = memory.taskStartRetrieval({
    state,
    text: "canonical conflict",
    types: ["decision"],
  });
  const hit = retrieval.active.find((item) => item.note.id === decision.id)!;
  assert.equal(hit.reviewStatus, "needs_review");
  assert.equal(hit.canonicalConflict?.canonical_ref, "SPEC.md#current-policy");
  assert.equal(memory.read(decision.id)!.note.status, "proposed");
  assert.equal(memory.read(decision.id)!.note.review_status, "clear");
  assert.ok(memory.reconcile().issues.some((issue) => issue.code === "CANONICAL_CONFLICT"));
});

test("promote requires approval, mutates canonical text once, reads back, and replays idempotently", () => {
  const { cwd, memory } = fixture();
  const captured = memory.capture(input("idea", "promote"));
  const request = {
    promotion_id: "promotion-001",
    target: { kind: "spec" as const, path: "SPEC.md" },
    insertBlock: "## Accepted memory item\n\nThis text was explicitly approved.",
  };
  expectCode(
    () => memory.promote(captured.id, { ...request, approved: true } as unknown as Parameters<ProjectMemory["promote"]>[1]),
    "INVALID_INPUT",
  );
  const opts = approvePromotion(memory, captured.id, request);
  const first = memory.promote(captured.id, opts);
  assert.equal(first.status, "promoted");
  const canonical = fs.readFileSync(path.join(cwd, "SPEC.md"), "utf8");
  assert.match(canonical, /Accepted memory item/);
  assert.match(canonical, new RegExp(`note-skills-derived-from: ${captured.id}`));

  const replay = memory.promote(captured.id, opts);
  assert.equal(replay.status, "replayed");
  const after = fs.readFileSync(path.join(cwd, "SPEC.md"), "utf8");
  assert.equal(after.match(/Accepted memory item/g)?.length, 1);

  const competing = memory.capture(input("idea", "competing-promote"));
  const beforeConflict = fs.readFileSync(path.join(cwd, "SPEC.md"), "utf8");
  expectCode(
    () =>
      memory.planPromotion(competing.id, {
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

test("promotion metadata cannot escape the project: escaped and symlinked targets are quarantined", () => {
  const { cwd, memory } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-promote-escape-"));
  const outsideBacklink = path.join(outside, "evil.md");
  fs.writeFileSync(outsideBacklink, "# Evil\n\nignored\n");

  // 1. ../ escape in promotion.target.path
  const escaped = memory.capture(input("idea", "promote-escape"));
  const escapedFile = memory.read(escaped.id)!;
  escapedFile.note.status = "promoted";
  escapedFile.note.promotion = {
    status: "promoted",
    target: { kind: "spec", ref: "../outside/evil.md", path: "../outside/evil.md" },
    promotion_id: "escape-1",
    promoted_at: new Date().toISOString(),
    backlink: "in_file",
    backlink_verified: true,
  };
  writeNoteFile(escapedFile.file, escapedFile.note, escapedFile.body);
  assert.equal(memory.read(escaped.id), null);
  const escapedReport = memory.reconcile({ fixIndex: true });
  assert.ok(escapedReport.issues.some((issue) => issue.code === "SCHEMA" && /promotion\.target\.path/.test(issue.message)));

  // 2. symlinked target inside project pointing outside
  const linked = memory.capture(input("idea", "promote-symlink-target"));
  fs.symlinkSync(outsideBacklink, path.join(cwd, "LINKED.md"));
  const linkedFile = memory.read(linked.id)!;
  linkedFile.note.status = "promoted";
  linkedFile.note.promotion = {
    status: "promoted",
    target: { kind: "spec", ref: "LINKED.md", path: "LINKED.md" },
    promotion_id: "link-1",
    promoted_at: new Date().toISOString(),
    backlink: "in_file",
    backlink_verified: true,
  };
  writeNoteFile(linkedFile.file, linkedFile.note, linkedFile.body);
  assert.equal(memory.read(linked.id), null);
  const linkedReport = memory.reconcile({ fixIndex: true });
  assert.ok(linkedReport.issues.some((issue) => issue.code === "PROMOTE_TARGET_INVALID"));
  assert.equal(fs.readFileSync(outsideBacklink, "utf8"), "# Evil\n\nignored\n");
});

test("stale canonical-conflict evidence does not mark retrieval needs_review", () => {
  const { cwd, memory } = fixture();
  const decision = memory.capture(input("decision", "stale-conflict"));
  const first = memory.read(decision.id)!;
  const staleSha = first.sha256;

  // Write evidence with a note_sha256 that does NOT match the current revision.
  fs.writeFileSync(
    path.join(cwd, "state.yaml"),
    [
      "milestones:",
      "  P0: complete",
      "canonical_conflicts:",
      `  ${decision.id}:`,
      "    canonical_ref: SPEC.md#current-policy",
      "    reason: Canonical policy moved on",
      `    note_sha256: "${'f'.repeat(64)}"`,
      "",
    ].join("\n"),
  );
  const state = memory.loadCanonicalState()!;
  const retrieval = memory.taskStartRetrieval({
    state,
    text: "stale conflict",
    types: ["decision"],
  });
  const hit = retrieval.active.find((item) => item.note.id === decision.id)!;
  assert.equal(hit.reviewStatus, "clear");
  assert.equal(hit.canonicalConflict, undefined);

  // Now write matching evidence.
  fs.writeFileSync(
    path.join(cwd, "state.yaml"),
    [
      "milestones:",
      "  P0: complete",
      "canonical_conflicts:",
      `  ${decision.id}:`,
      "    canonical_ref: SPEC.md#current-policy",
      "    reason: Canonical policy moved on",
      `    note_sha256: ${staleSha}`,
      "",
    ].join("\n"),
  );
  const freshState = memory.loadCanonicalState()!;
  const fresh = memory.taskStartRetrieval({
    state: freshState,
    text: "stale conflict",
    types: ["decision"],
  });
  const freshHit = fresh.active.find((item) => item.note.id === decision.id)!;
  assert.equal(freshHit.reviewStatus, "needs_review");
  assert.equal(freshHit.canonicalConflict?.reason, "Canonical policy moved on");
});

test("mixed valid+invalid pending resolution is atomic (no writes on NOT_FOUND)", () => {
  const { cwd, memory } = fixture();
  const now = new Date().toISOString();
  const candidateId = `cand_${`a`.repeat(32)}`;
  const envelope = {
    schema_version: 1 as const,
    envelope_id: `pc_${`b`.repeat(32)}`,
    project_id: "fixture",
    session_id: "session-atomic",
    source_leaf_id: "leaf-atomic",
    created_at: now,
    candidates: [
      {
        candidate_id: candidateId,
        type: "risk" as const,
        markers: ["P1"],
        source_ref: { kind: "conversation" as const, ref: "pi-session://session-atomic", turn_id: "leaf-atomic" },
        source_excerpt: "P1 later review",
        source_excerpt_sha256: "c".repeat(64),
        detected_at: now,
        resolution: null,
      },
    ],
  };
  memory.persistPendingCapture(envelope);
  const missingId = `cand_${`d`.repeat(32)}`;
  expectCode(
    () =>
      memory.resolvePendingCapture([candidateId, missingId], {
        status: "captured",
        tool_call_id: "call-atomic-1",
        note_id: "PM-IDE-0001",
      }),
    "NOT_FOUND",
  );
  // Valid candidate must remain unresolved (no half-write).
  assert.deepEqual(new ProjectMemory(cwd).pendingCaptureCandidates().map((candidate) => candidate.candidate_id), [candidateId]);
});

test("approval minting is restricted to the live Pi UI channel", () => {
  const { memory } = fixture();
  const captured = memory.capture(input("idea", "approval-channel"));
  const plan = memory.planPromotion(captured.id, {
    promotion_id: "approval-channel-1",
    target: { kind: "spec", path: "SPEC.md" },
    insertBlock: "## Channel test\n",
  });
  // Ad-hoc / test channel must be rejected.
  expectCode(
    () =>
      memory.recordPromotionApproval(plan, {
        kind: "human",
        id: "test-user",
        channel: "test",
      } as never),
    "INVALID_INPUT",
  );
  // Non-session principal id must be rejected.
  expectCode(
    () =>
      memory.recordPromotionApproval(plan, {
        kind: "human",
        id: "some-user",
        channel: "pi-ui",
      }),
    "INVALID_INPUT",
  );
  // Live Pi UI principal succeeds.
  const approval = memory.recordPromotionApproval(plan, {
    kind: "human",
    id: "pi-session://real-session",
    channel: "pi-ui",
  });
  assert.match(approval.approval_ref, /^pa_[0-9a-f]{32}$/);
});

test("recordPromotionApproval rejects a forged plan whose target escapes the project", () => {
  const { cwd, memory } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-forged-plan-"));
  fs.writeFileSync(path.join(outside, "evil.md"), "# Never read\n");
  const plan = {
    project_id: "fixture",
    note_id: "PM-IDE-0001",
    promotion_id: "forged-plan-1",
    target: { kind: "spec" as const, ref: "../outside/evil.md", path: "../outside/evil.md" },
    mode: "append_block" as const,
    payload_content: "## Forged block",
    payload_sha256: "0".repeat(64),
    before_sha256: "0".repeat(64),
    after_sha256: "0".repeat(64),
    planned_at: new Date().toISOString(),
    before_content: "",
    after_content: "",
  };
  expectCode(
    () =>
      memory.recordPromotionApproval(plan, {
        kind: "human",
        id: "pi-session://forged",
        channel: "pi-ui",
      }),
    "INVALID_INPUT",
  );
});

test("a hand-crafted approval JSON cannot bypass the live UI capability", () => {
  const { cwd, memory } = fixture();
  const captured = memory.capture(input("idea", "forged-approval"));
  const approvalsDir = path.join(cwd, ".note-skills", "approvals");
  fs.mkdirSync(approvalsDir, { recursive: true });
  const forgedRef = `pa_${`a`.repeat(32)}`;
  const plan = memory.planPromotion(captured.id, {
    promotion_id: "forged-approval-1",
    target: { kind: "spec", path: "SPEC.md" },
    insertBlock: "## Forged approval\n",
  });
  // Write an approval record that LOOKS perfect but was never minted in this
  // process (no live capability) — e.g. an attacker or a stale backup.
  fs.writeFileSync(
    path.join(approvalsDir, `${forgedRef}.json`),
    JSON.stringify({
      schema_version: 1,
      approval_ref: forgedRef,
      project_id: "fixture",
      note_id: captured.id,
      promotion_id: "forged-approval-1",
      target: plan.target,
      mode: "append_block",
      payload_sha256: plan.payload_sha256,
      before_sha256: plan.before_sha256,
      after_sha256: plan.after_sha256,
      planned_at: plan.planned_at,
      approved_at: new Date().toISOString(),
      approved_by: { kind: "human", id: "pi-session://forged", channel: "pi-ui" },
      status: "approved",
      consumed_at: null,
    }, null, 2) + "\n",
  );
  expectCode(
    () =>
      memory.promote(captured.id, {
        approval_ref: forgedRef,
        promotion_id: "forged-approval-1",
        target: { kind: "spec", path: "SPEC.md" },
        insertBlock: "## Forged approval\n",
      }),
    "POLICY_VIOLATION",
  );
  assert.equal(fs.readFileSync(path.join(cwd, "SPEC.md"), "utf8"), "# Canonical Spec\n");
  assert.equal(memory.read(captured.id)!.note.promotion.status, "not_promoted");
});

test("runtime validation aligns with JSON Schema for created_by and source_refs", () => {
  const { memory } = fixture();
  const captured = memory.capture(input("idea", "schema-align"));
  const file = memory.read(captured.id)!;
  file.note.created_by = { kind: "not-a-kind", id: "" } as never;
  writeNoteFile(file.file, file.note, file.body);
  assert.equal(memory.read(captured.id), null);
  const report = memory.reconcile({ fixIndex: true });
  assert.ok(report.issues.some((issue) => issue.code === "SCHEMA" && /created_by/.test(issue.message)));

  const second = memory.capture(input("risk", "schema-align-2"));
  const secondFile = memory.read(second.id)!;
  secondFile.note.source_refs[0]!.excerpt_sha256 = "not-a-hash";
  writeNoteFile(secondFile.file, secondFile.note, secondFile.body);
  const secondReport = memory.reconcile({ fixIndex: true });
  assert.ok(secondReport.issues.some((issue) => issue.code === "SCHEMA" && /source_refs\[0\]\.excerpt_sha256/.test(issue.message)));
});

test("forged promotion.backlink / backlink_verified values are quarantined at read", () => {
  const { memory } = fixture();
  const captured = memory.capture(input("idea", "forged-backlink"));
  const plan = memory.planPromotion(captured.id, {
    promotion_id: "forged-backlink-1",
    target: { kind: "spec", path: "SPEC.md" },
    insertBlock: "## Forged backlink test\n",
  });
  const approval = memory.recordPromotionApproval(plan, {
    kind: "human",
    id: "pi-session://backlink",
    channel: "pi-ui",
  });
  const promoted = memory.promote(captured.id, {
    approval_ref: approval.approval_ref,
    promotion_id: "forged-backlink-1",
    target: { kind: "spec", path: "SPEC.md" },
    insertBlock: "## Forged backlink test\n",
  });
  assert.equal(promoted.status, "promoted");

  // Hand-set an illegal backlink value; the note must be quarantined.
  const file = memory.read(captured.id)!;
  file.note.promotion.backlink = "forged" as never;
  writeNoteFile(file.file, file.note, file.body);
  assert.equal(memory.read(captured.id), null);
  const report = memory.reconcile({ fixIndex: true });
  assert.ok(report.issues.some((issue) => issue.code === "SCHEMA" && /promotion\.backlink/.test(issue.message)));
});

test("promotion approval is content-bound and CAS refuses a target changed after review", () => {
  const { cwd, memory } = fixture();
  const captured = memory.capture(input("idea", "promotion-cas"));
  const request = {
    promotion_id: "promotion-cas-1",
    target: { kind: "spec" as const, path: "SPEC.md" },
    content: "# User-reviewed V1\n",
  };
  const approved = approvePromotion(memory, captured.id, request);
  fs.writeFileSync(path.join(cwd, "SPEC.md"), "# Concurrent V2\n");

  expectCode(() => memory.promote(captured.id, approved), "CONFLICT");
  assert.equal(fs.readFileSync(path.join(cwd, "SPEC.md"), "utf8"), "# Concurrent V2\n");
  assert.equal(memory.read(captured.id)!.note.promotion.status, "not_promoted");
  assert.ok(memory.reconcile().issues.some((issue) => issue.code === "UNCONSUMED_APPROVAL"));
});

test("bidirectional supersedes metadata normalizes to one direction without a false cycle", () => {
  const { memory } = fixture();
  const older = memory.capture(input("idea", "supersedes-older"));
  const newer = memory.capture(input("idea", "supersedes-newer"));
  memory.update(newer.id, { relations: { supersedes: [older.id] } });
  memory.update(older.id, { relations: { superseded_by: [newer.id] } });
  assert.equal(memory.reconcile().issues.some((issue) => issue.code === "SUPERSEDES_CYCLE"), false);
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
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-outside-"));
  fs.writeFileSync(path.join(other, "OUT.md"), "outside");
  expectCode(
    () => new ProjectMemory(cwd).init({ project_id: "fixture", canonical_state_file: path.join(other, "OUT.md") }),
    "INVALID_INPUT",
  );
  const captured = memory.capture(input("idea", "outside"));
  expectCode(
    () =>
      memory.planPromotion(captured.id, {
        promotion_id: "outside-1",
        target: { kind: "spec", path: path.join(other, "OUT.md") },
        content: "no",
      }),
    "INVALID_INPUT",
  );
});

test("symlinked memory, state, note, and promote paths cannot escape the project", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-symlink-outside-"));

  const rootProject = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-symlink-root-"));
  fs.symlinkSync(outside, path.join(rootProject, ".note-skills"), "dir");
  expectCode(() => new ProjectMemory(rootProject).init({ project_id: "root-link" }), "INVALID_INPUT");
  assert.equal(fs.existsSync(path.join(outside, "config.yaml")), false);

  const configProject = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-symlink-config-"));
  fs.mkdirSync(path.join(configProject, ".note-skills"));
  const outsideConfig = path.join(outside, "outside-config.yaml");
  fs.writeFileSync(outsideConfig, "schema_version: 1\nproject_id: outside\ncreated_at: never\n");
  fs.symlinkSync(outsideConfig, path.join(configProject, ".note-skills", "config.yaml"));
  expectCode(() => new ProjectMemory(configProject).config(), "INVALID_INPUT");

  const noteProject = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-symlink-note-"));
  const noteMemory = new ProjectMemory(noteProject);
  noteMemory.init({ project_id: "note-link" });
  const ideas = path.join(noteProject, ".note-skills", "notes", "ideas");
  fs.rmSync(ideas, { recursive: true });
  fs.symlinkSync(outside, ideas, "dir");
  expectCode(() => noteMemory.capture(input("idea", "symlink-note")), "INVALID_INPUT");
  assert.equal(fs.readdirSync(outside).some((name) => name.startsWith("PM-IDE-")), false);

  const stateProject = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-symlink-state-"));
  const outsideState = path.join(outside, "outside-state.yaml");
  fs.writeFileSync(outsideState, "milestones:\n  P0: complete\n");
  fs.symlinkSync(outsideState, path.join(stateProject, "state.yaml"));
  expectCode(
    () => new ProjectMemory(stateProject).init({ project_id: "state-link", canonical_state_file: "state.yaml" }),
    "INVALID_INPUT",
  );

  const targetProject = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-symlink-target-"));
  const outsideTarget = path.join(outside, "outside-target.md");
  fs.writeFileSync(outsideTarget, "outside canonical bytes");
  fs.symlinkSync(outsideTarget, path.join(targetProject, "SPEC.md"));
  const targetMemory = new ProjectMemory(targetProject);
  targetMemory.init({ project_id: "target-link" });
  const captured = targetMemory.capture(input("idea", "symlink-target"));
  expectCode(
    () =>
      targetMemory.planPromotion(captured.id, {
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
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-derived-symlink-"));
  const poisonIndex = path.join(outside, "poison-index.json");
  fs.writeFileSync(poisonIndex, '{"notes":[{"id":"PM-IDE-9999"}]}');
  const notesIndex = path.join(cwd, ".note-skills", "index", "notes.json");
  fs.unlinkSync(notesIndex);
  fs.symlinkSync(poisonIndex, notesIndex);

  const poisonBacklink = path.join(outside, "poison-backlink.md");
  fs.writeFileSync(
    poisonBacklink,
    "# Note Skills backlink\n- target: OUT\n- kind: file\n- derived_from: PM-IDE-9999\n- promotion_id: evil\n",
  );
  fs.symlinkSync(poisonBacklink, path.join(cwd, ".note-skills", "backlinks", "evil.md"));

  const report = memory.reconcile({ fixIndex: true });
  const codes = new Set(report.issues.map((issue) => issue.code));
  assert.ok(codes.has("INDEX_SYMLINK"));
  assert.ok(codes.has("BACKLINK_SYMLINK"));
  assert.equal(fs.lstatSync(notesIndex).isSymbolicLink(), false);
  assert.doesNotMatch(fs.readFileSync(notesIndex, "utf8"), /PM-IDE-9999/);
  assert.equal(fs.readFileSync(poisonIndex, "utf8"), '{"notes":[{"id":"PM-IDE-9999"}]}');
  assert.match(fs.readFileSync(poisonBacklink, "utf8"), /PM-IDE-9999/);
});

test("pending-capture envelopes survive a fresh service instance until candidate-level resolution", () => {
  const { cwd, memory } = fixture();
  const now = new Date().toISOString();
  const envelope = {
    schema_version: 1 as const,
    envelope_id: `pc_${"a".repeat(32)}`,
    project_id: "fixture",
    session_id: "session-a",
    source_leaf_id: "leaf-a",
    created_at: now,
    candidates: [
      {
        candidate_id: `cand_${"b".repeat(32)}`,
        type: "risk" as const,
        markers: ["P1", "risk"],
        source_ref: { kind: "conversation" as const, ref: "pi-session://session-a", turn_id: "leaf-a" },
        source_excerpt: "P1 risk requires a later review.",
        source_excerpt_sha256: "c".repeat(64),
        detected_at: now,
        resolution: null,
      },
    ],
  };
  memory.persistPendingCapture(envelope);
  const reopened = new ProjectMemory(cwd);
  assert.deepEqual(reopened.pendingCaptureCandidates().map((candidate) => candidate.candidate_id), [envelope.candidates[0]!.candidate_id]);
  reopened.resolvePendingCapture([envelope.candidates[0]!.candidate_id], {
    status: "skipped",
    reason: "False-positive marker in a quoted review",
    tool_call_id: "call-pending-1",
  });
  assert.deepEqual(new ProjectMemory(cwd).pendingCaptureCandidates(), []);
});

test("concurrent promotes to one canonical target serialize to exactly one winner", { timeout: 30_000 }, async () => {
  const { cwd, memory } = fixture();
  // Each worker completes the whole live-UI flow (plan -> record approval ->
  // promote) inside its own process, because live capabilities are
  // process-local: a cross-process approval_ref can never be consumed.
  const worker = `
    import fs from 'node:fs';
    import { ProjectMemory } from ${JSON.stringify(path.join(projectRoot, "src", "index.ts"))};
    while (!fs.existsSync(process.env.PM_GO)) await new Promise(r => setTimeout(r, 1));
    try {
      const pm = new ProjectMemory(process.env.PM_CWD);
      const request = {
        promotion_id: process.env.PM_PROMOTION,
        target: { kind: 'spec', path: process.env.PM_TARGET },
        insertBlock: '## ' + process.env.PM_ID
      };
      const plan = pm.planPromotion(process.env.PM_ID, request);
      const approval = pm.recordPromotionApproval(plan, {kind:'human',id:'pi-session://worker-'+process.env.PM_ID,channel:'pi-ui'});
      const out = pm.promote(process.env.PM_ID, { ...request, approval_ref: approval.approval_ref });
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
    const firstPromotion = `race-${round}-a`;
    const secondPromotion = `race-${round}-b`;
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
    const left = run(first.id, firstPromotion);
    const right = run(second.id, secondPromotion);
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
    assert.match(canonical, new RegExp(`note-skills-derived-from: ${winner}`));
    assert.doesNotMatch(canonical, new RegExp(`## ${loser}`));
    const lockFiles = fs
      .readdirSync(path.join(cwd, ".note-skills", "locks"))
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

test("concurrent identical captures create one active fingerprint and merge every source", { timeout: 30_000 }, async () => {
  const { cwd, memory } = fixture();
  const go = path.join(cwd, "GO-identical");
  const worker = `
    import fs from 'node:fs';
    import { ProjectMemory } from ${JSON.stringify(path.join(projectRoot, "src", "index.ts"))};
    while (!fs.existsSync(process.env.PM_GO)) await new Promise(r => setTimeout(r, 1));
    const out = new ProjectMemory(process.env.PM_CWD).capture({
      type:'risk', title:'Shared concurrency risk', summary:'One semantic fingerprint across agents',
      rationale:'All agents observed the same risk', next_action:'Review merged provenance',
      source_refs:[{kind:'manual',ref:'test://identical/'+process.env.PM_I}]
    });
    process.stdout.write(JSON.stringify({id:out.id,status:out.status}));
  `;
  const runs = Array.from({ length: 12 }, (_, index) =>
    execFileAsync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", worker], {
      cwd: projectRoot,
      env: { ...process.env, PM_CWD: cwd, PM_GO: go, PM_I: String(index) },
    }).then(({ stdout }) => JSON.parse(stdout) as { id: string; status: "created" | "merged" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  fs.writeFileSync(go, "go");
  const receipts = await Promise.all(runs);
  assert.equal(new Set(receipts.map((receipt) => receipt.id)).size, 1);
  assert.equal(receipts.filter((receipt) => receipt.status === "created").length, 1);
  assert.equal(receipts.filter((receipt) => receipt.status === "merged").length, 11);
  const hits = memory.search({ type: "risk" }).filter((hit) => hit.note.title === "Shared concurrency risk");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.note.source_refs.length, 12);
  assert.equal(memory.reconcile().issues.some((issue) => issue.code === "DUPLICATE_FINGERPRINT"), false);
});

test("live capability is rebound: editing the approval record after minting is refused", () => {
  const { cwd, memory } = fixture();
  const captured = memory.capture(input("idea", "rebind"));
  const request = {
    promotion_id: "rebind-1",
    target: { kind: "spec" as const, path: "SPEC.md" },
    insertBlock: "## Approved content A\n",
  };
  const plan = memory.planPromotion(captured.id, request);
  const approval = memory.recordPromotionApproval(plan, {
    kind: "human",
    id: "pi-session://rebind",
    channel: "pi-ui",
  });

  // Attacker edits the on-disk approval record to different bytes B.
  const approvalsDir = path.join(cwd, ".note-skills", "approvals");
  const approvalFile = path.join(approvalsDir, `${approval.approval_ref}.json`);
  const tampered = JSON.parse(fs.readFileSync(approvalFile, "utf8")) as {
    planned_at: string;
    approved_at: string;
    payload_sha256: string;
    after_sha256: string;
  };
  // Tamper a binding-neutral field first (planned_at is not checked by
  // assertApprovalBinding, only by the live-capability comparison).
  tampered.planned_at = new Date(Date.parse(tampered.planned_at) + 1_000_000).toISOString();
  fs.writeFileSync(approvalFile, JSON.stringify(tampered, null, 2) + "\n");
  expectCode(
    () => memory.promote(captured.id, { ...request, approval_ref: approval.approval_ref }),
    "POLICY_VIOLATION",
  );
  assert.equal(fs.readFileSync(path.join(cwd, "SPEC.md"), "utf8"), "# Canonical Spec\n");
  assert.equal(memory.read(captured.id)!.note.promotion.status, "not_promoted");

  // Tampering a binding-checked field (payload_sha256) is refused as CONFLICT.
  const secondTamper = JSON.parse(fs.readFileSync(approvalFile, "utf8")) as typeof tampered;
  secondTamper.payload_sha256 = "e".repeat(64);
  fs.writeFileSync(approvalFile, JSON.stringify(secondTamper, null, 2) + "\n");
  expectCode(
    () => memory.promote(captured.id, { ...request, approval_ref: approval.approval_ref }),
    "CONFLICT",
  );
  const third = JSON.parse(fs.readFileSync(approvalFile, "utf8")) as typeof tampered;
  assert.equal(fs.readFileSync(path.join(cwd, "SPEC.md"), "utf8"), "# Canonical Spec\n");
  assert.equal(memory.read(captured.id)!.note.promotion.status, "not_promoted");
});

test("trigger condition values strictly follow the schema (non-empty string lists / strings)", () => {
  const { memory } = fixture();
  expectCode(
    () =>
      memory.capture({
        ...input("deferred_work", "bad-trigger-list"),
        trigger: { conditions: [{ kind: "milestone", key: "P0", operator: "in", value: [123] as never }] },
      }),
    "INVALID_INPUT",
  );
  expectCode(
    () =>
      memory.capture({
        ...input("deferred_work", "bad-trigger-in-empty"),
        trigger: { conditions: [{ kind: "milestone", key: "P0", operator: "in", value: [] }] },
      }),
    "INVALID_INPUT",
  );
  expectCode(
    () =>
      memory.capture({
        ...input("deferred_work", "bad-trigger-status_equals"),
        trigger: { conditions: [{ kind: "dependency", key: "PM-QUE-9999", operator: "status_equals", value: 123 as never }] },
      }),
    "INVALID_INPUT",
  );
  expectCode(
    () =>
      memory.capture({
        ...input("deferred_work", "bad-trigger-empty-string"),
        trigger: { conditions: [{ kind: "milestone", key: "P0", operator: "equals", value: "" }] },
      }),
    "INVALID_INPUT",
  );
  // Hand-edited note with a bad trigger value is quarantined at read.
  const captured = memory.capture(input("idea", "bad-trigger-edit"));
  const file = memory.read(captured.id)!;
  file.note.trigger = { conditions: [{ kind: "milestone", key: "P0", operator: "equals", value: 123 as never }] };
  writeNoteFile(file.file, file.note, file.body);
  assert.equal(memory.read(captured.id), null);
  assert.ok(memory.reconcile().issues.some((issue) => issue.code === "SCHEMA" && /trigger/.test(issue.message)));
});

test("promoted target directory is quarantined as PROMOTE_TARGET_INVALID", () => {
  const { cwd, memory } = fixture();
  const captured = memory.capture(input("idea", "target-dir"));
  const plan = memory.planPromotion(captured.id, {
    promotion_id: "target-dir-1",
    target: { kind: "spec", path: "SPEC.md" },
    insertBlock: "## Dir target\n",
  });
  const approval = memory.recordPromotionApproval(plan, {
    kind: "human",
    id: "pi-session://target-dir",
    channel: "pi-ui",
  });
  fs.rmSync(path.join(cwd, "SPEC.md"));
  fs.mkdirSync(path.join(cwd, "SPEC.md"));
  expectCode(
    () =>
      memory.promote(captured.id, {
        approval_ref: approval.approval_ref,
        promotion_id: "target-dir-1",
        target: { kind: "spec", path: "SPEC.md" },
        insertBlock: "## Dir target\n",
      }),
    "INVALID_INPUT",
  );
  // Hand-mark the note as promoted targeting the directory; it must be quarantined.
  const file = memory.read(captured.id)!;
  file.note.status = "promoted";
  file.note.promotion = {
    status: "promoted",
    target: { kind: "spec", ref: "SPEC.md", path: "SPEC.md" },
    promotion_id: "target-dir-1",
    promoted_at: new Date().toISOString(),
    backlink: "in_file",
    backlink_verified: true,
  };
  writeNoteFile(file.file, file.note, file.body);
  assert.equal(memory.read(captured.id), null);
  const report = memory.reconcile({ fixIndex: true });
  assert.ok(report.issues.some((issue) => issue.code === "PROMOTE_TARGET_INVALID"));
});

test("writeFileAtomicBatch commits all-or-nothing: staging failure leaves targets untouched", () => {
  const { cwd } = fixture();
  const fileA = path.join(cwd, "batch-a.json");
  const fileB = path.join(cwd, "batch-b.json");
  fs.writeFileSync(fileA, "A0\n");
  fs.writeFileSync(fileB, "B0\n");
  // Force a staging failure on the second file by making its directory a file.
  const blocker = path.join(cwd, "batch-dir");
  fs.writeFileSync(blocker, "blocker");
  const target = path.join(blocker, "child.json");
  assert.throws(
    () =>
      writeFileAtomicBatch([
        { file: fileA, content: "A1\n" },
        { file: target, content: "C1\n" },
      ]),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST",
  );
  assert.equal(fs.readFileSync(fileA, "utf8"), "A0\n");
  assert.equal(fs.readFileSync(fileB, "utf8"), "B0\n");
  // Successful batch replaces both and leaves no temp files.
  writeFileAtomicBatch([
    { file: fileA, content: "A2\n" },
    { file: fileB, content: "B2\n" },
  ]);
  assert.equal(fs.readFileSync(fileA, "utf8"), "A2\n");
  assert.equal(fs.readFileSync(fileB, "utf8"), "B2\n");
  assert.deepEqual(
    fs.readdirSync(cwd).filter((name) => name.startsWith(".pm-tmp-")),
    [],
  );
});

test("numeric objectId/version are rejected before any canonical write or approval", () => {
  const { cwd, memory } = fixture();
  const captured = memory.capture(input("idea", "target-meta"));
  // planPromotion must reject the malformed target up front.
  expectCode(
    () =>
      memory.planPromotion(captured.id, {
        promotion_id: "target-meta-1",
        target: { kind: "spec", path: "SPEC.md", objectId: 42 as never },
        insertBlock: "## Bad meta\n",
      }),
    "INVALID_INPUT",
  );
  expectCode(
    () =>
      memory.planPromotion(captured.id, {
        promotion_id: "target-meta-2",
        target: { kind: "spec", path: "SPEC.md", version: 7 as never },
        insertBlock: "## Bad meta\n",
      }),
    "INVALID_INPUT",
  );
  // A hand-written approval record with numeric version is INCONSISTENT.
  const validPlan = memory.planPromotion(captured.id, {
    promotion_id: "target-meta-3",
    target: { kind: "spec", path: "SPEC.md", objectId: "obj-1", version: "v1" },
    insertBlock: "## Good meta\n",
  });
  const validApproval = memory.recordPromotionApproval(validPlan, {
    kind: "human",
    id: "pi-session://target-meta",
    channel: "pi-ui",
  });
  const approvalFile = path.join(cwd, ".note-skills", "approvals", `${validApproval.approval_ref}.json`);
  const tampered = JSON.parse(fs.readFileSync(approvalFile, "utf8")) as {
    target: { version: unknown };
  };
  tampered.target.version = 7;
  fs.writeFileSync(approvalFile, JSON.stringify(tampered, null, 2) + "\n");
  expectCode(
    () =>
      memory.promote(captured.id, {
        approval_ref: validApproval.approval_ref,
        promotion_id: "target-meta-3",
        target: { kind: "spec", path: "SPEC.md", objectId: "obj-1", version: "v1" },
        insertBlock: "## Good meta\n",
      }),
    "INCONSISTENT",
  );
  assert.equal(fs.readFileSync(path.join(cwd, "SPEC.md"), "utf8"), "# Canonical Spec\n");
  // Replaying false: objectId/version are bound — different objectId is CONFLICT.
  const secondPlan = memory.planPromotion(captured.id, {
    promotion_id: "target-meta-4",
    target: { kind: "spec", path: "SPEC.md", objectId: "obj-2", version: "v1" },
    insertBlock: "## Good meta\n",
  });
  const secondApproval = memory.recordPromotionApproval(secondPlan, {
    kind: "human",
    id: "pi-session://target-meta-2",
    channel: "pi-ui",
  });
  expectCode(
    () =>
      memory.promote(captured.id, {
        approval_ref: secondApproval.approval_ref,
        promotion_id: "target-meta-4",
        target: { kind: "spec", path: "SPEC.md", objectId: "obj-1", version: "v1" },
        insertBlock: "## Good meta\n",
      }),
    "CONFLICT",
  );
});

test("capability holds a deep copy of the target: mutating plan.target afterwards is refused", () => {
  const { cwd, memory } = fixture();
  const captured = memory.capture(input("idea", "target-copy"));
  const plan = memory.planPromotion(captured.id, {
    promotion_id: "target-copy-1",
    target: { kind: "spec", path: "SPEC.md", objectId: "obj-orig", version: "v1" },
    insertBlock: "## Copy test\n",
  });
  const approval = memory.recordPromotionApproval(plan, {
    kind: "human",
    id: "pi-session://target-copy",
    channel: "pi-ui",
  });
  // Mutate the plan object AFTER approval — capability holds a deep copy, so
  // the in-memory plan no longer matters; only the approval record does.
  plan.target.ref = "MUTATED";
  plan.target.objectId = "obj-mutated";
  // Promote with the ORIGINAL target bytes still succeeds (approval + capability
  // hold the originals); the note metadata records the approved objectId.
  const receipt = memory.promote(captured.id, {
    approval_ref: approval.approval_ref,
    promotion_id: "target-copy-1",
    target: { kind: "spec", path: "SPEC.md", objectId: "obj-orig", version: "v1" },
    insertBlock: "## Copy test\n",
  });
  assert.equal(receipt.status, "promoted");
  assert.equal(memory.read(captured.id)!.note.promotion.target?.objectId, "obj-orig");
  // But requesting DIFFERENT target metadata than approved is CONFLICT (new
  // note, separate canonical file so the backlink guard stays out of the way).
  fs.writeFileSync(path.join(cwd, "OTHER.md"), "# Other canonical\n");
  const other = memory.capture(input("idea", "target-copy-2"));
  const otherPlan = memory.planPromotion(other.id, {
    promotion_id: "target-copy-2",
    target: { kind: "spec", path: "OTHER.md", objectId: "obj-orig", version: "v1" },
    insertBlock: "## Copy test\n",
  });
  const otherApproval = memory.recordPromotionApproval(otherPlan, {
    kind: "human",
    id: "pi-session://target-copy-2",
    channel: "pi-ui",
  });
  expectCode(
    () =>
      memory.promote(other.id, {
        approval_ref: otherApproval.approval_ref,
        promotion_id: "target-copy-2",
        target: { kind: "spec", path: "OTHER.md", objectId: "obj-DIFFERENT", version: "v1" },
        insertBlock: "## Copy test\n",
      }),
    "CONFLICT",
  );
});

test("pending settlement rejects unrelated type, nonexistent note, and missing provenance", () => {
  const { cwd, memory } = fixture();
  const now = new Date().toISOString();
  const candId = `cand_${`1`.repeat(32)}`;
  const envelope = {
    schema_version: 1 as const,
    envelope_id: `pc_${`2`.repeat(32)}`,
    project_id: "fixture",
    session_id: "session-bind",
    source_leaf_id: "leaf-bind",
    created_at: now,
    candidates: [
      {
        candidate_id: candId,
        type: "risk" as const,
        markers: ["risk"],
        source_ref: { kind: "conversation" as const, ref: "pi-session://session-bind", turn_id: "leaf-bind" },
        source_excerpt: "a risk",
        source_excerpt_sha256: "3".repeat(64),
        detected_at: now,
        resolution: null,
      },
    ],
  };
  memory.persistPendingCapture(envelope);
  // A nonexistent note id is rejected.
  expectCode(
    () =>
      memory.resolvePendingCapture([candId], { status: "captured", tool_call_id: "c1", note_id: "PM-IDE-9999" }),
    "NOT_FOUND",
  );
  // A wrong-type idea note is rejected.
  const idea = memory.capture(input("idea", "wrong-type-settle"));
  expectCode(
    () =>
      memory.resolvePendingCapture([candId], { status: "captured", tool_call_id: "c2", note_id: idea.id }),
    "INVALID_INPUT",
  );
  // A risk note whose source_ref does NOT reference the candidate provenance is rejected.
  const risk = memory.capture(input("risk", "no-provenance-settle"));
  expectCode(
    () =>
      memory.resolvePendingCapture([candId], { status: "captured", tool_call_id: "c3", note_id: risk.id }),
    "INVALID_INPUT",
  );
  assert.equal(new ProjectMemory(cwd).pendingCaptureCandidates().length, 1);
});

test("captureAndResolvePending validates type + provenance and binds in one call", () => {
  const { cwd, memory } = fixture();
  const now = new Date().toISOString();
  const candId = `cand_${`4`.repeat(32)}`;
  memory.persistPendingCapture({
    schema_version: 1,
    envelope_id: `pc_${`5`.repeat(32)}`,
    project_id: "fixture",
    session_id: "session-atomic",
    source_leaf_id: "leaf-atomic",
    created_at: now,
    candidates: [
      {
        candidate_id: candId,
        type: "risk",
        markers: ["risk"],
        source_ref: { kind: "conversation", ref: "pi-session://session-atomic", turn_id: "leaf-atomic" },
        source_excerpt: "atomic risk",
        source_excerpt_sha256: "6".repeat(64),
        detected_at: now,
        resolution: null,
      },
    ],
  } satisfies Parameters<ProjectMemory["persistPendingCapture"]>[0]);
  const bound = memory.captureAndResolvePending(
    [candId],
    {
      type: "risk",
      title: "Bound risk",
      summary: "Bound summary",
      rationale: "Bound rationale",
      next_action: "Bound next",
      source_refs: [
        { kind: "conversation", ref: "pi-session://session-atomic", turn_id: "leaf-atomic" },
      ],
    },
    "atomic-call-1",
  );
  assert.equal(bound.receipt.status, "created");
  assert.equal(bound.resolved.length, 1);
  assert.equal(new ProjectMemory(cwd).pendingCaptureCandidates().length, 0);
  // Add a SECOND unresolved idea candidate to the same store, then request a
  // mixed-type bind: must be rejected up front (both remain unresolved).
  const otherCand = `cand_${`7`.repeat(32)}`;
  memory.persistPendingCapture({
    schema_version: 1,
    envelope_id: `pc_${`8`.repeat(32)}`,
    project_id: "fixture",
    session_id: "session-mix",
    source_leaf_id: "leaf-mix",
    created_at: now,
    candidates: [
      {
        candidate_id: otherCand,
        type: "idea",
        markers: ["idea"],
        source_ref: { kind: "conversation", ref: "pi-session://session-mix", turn_id: "leaf-mix" },
        source_excerpt: "mixed idea",
        source_excerpt_sha256: "9".repeat(64),
        detected_at: now,
        resolution: null,
      },
    ],
  } satisfies Parameters<ProjectMemory["persistPendingCapture"]>[0]);
  // candId is already resolved from the first bind, so a mixed request using it
  // would hit NOT_FOUND — instead use two fresh unresolved candidates.
  const freshRisk = `cand_${`a`.repeat(32)}`;
  memory.persistPendingCapture({
    schema_version: 1,
    envelope_id: `pc_${`b`.repeat(32)}`,
    project_id: "fixture",
    session_id: "session-mix2",
    source_leaf_id: "leaf-mix2",
    created_at: now,
    candidates: [
      {
        candidate_id: freshRisk,
        type: "risk",
        markers: ["risk"],
        source_ref: { kind: "conversation", ref: "pi-session://session-mix2", turn_id: "leaf-mix2" },
        source_excerpt: "mixed risk",
        source_excerpt_sha256: "c".repeat(64),
        detected_at: now,
        resolution: null,
      },
    ],
  } satisfies Parameters<ProjectMemory["persistPendingCapture"]>[0]);
  expectCode(
    () =>
      memory.captureAndResolvePending(
        [freshRisk, otherCand],
        {
          type: "risk",
          title: "Mixed",
          summary: "Mixed summary",
          rationale: "Mixed rationale",
          next_action: "Mixed next",
          source_refs: [{ kind: "conversation", ref: "pi-session://session-mix2", turn_id: "leaf-mix2" }],
        },
        "atomic-call-2",
      ),
    "INVALID_INPUT",
  );
  assert.equal(new ProjectMemory(cwd).pendingCaptureCandidates().length, 2);
});

test("stripped required review fields are quarantined (no silent clear default)", () => {
  const { memory } = fixture();
  const captured = memory.capture(input("risk", "stripped-review"));
  const file = memory.read(captured.id)!;
  const raw = JSON.parse(JSON.stringify(file.note)) as Record<string, unknown>;
  delete raw.review_status;
  delete raw.review_reason;
  writeNoteFile(file.file, raw as never, file.body);
  assert.equal(memory.read(captured.id), null);
  const report = memory.reconcile({ fixIndex: true });
  assert.ok(report.issues.some((issue) => issue.code === "SCHEMA" && /review_status/.test(issue.message)));
});

test("tampered fingerprint is quarantined and cannot redirect a later merges", () => {
  const { cwd, memory } = fixture();
  const a = memory.capture(input("risk", "tamper-fp"));
  const file = memory.read(a.id)!;
  // Replace fingerprint with a syntactically valid but content-wrong hash.
  file.note.fingerprint = `sha256:${"a".repeat(64)}`;
  writeNoteFile(file.file, file.note, file.body);
  assert.equal(memory.read(a.id), null);
  // A NEW capture of the SAME logical content must NOT merge into the
  // quarantined note — it should create a fresh one (or fail fresh-create).
  const fresh = memory.capture(input("risk", "tamper-fp"));
  assert.equal(fresh.status, "created");
  assert.notEqual(fresh.note.id, a.id);
  const report = memory.reconcile({ fixIndex: true });
  assert.ok(report.issues.some((issue) => issue.code === "FINGERPRINT_MISMATCH"));
});

test("duplicate note IDs are quarantined from search/trigger/index", () => {
  const { cwd, memory } = fixture();
  const a = memory.capture(input("risk", "dup-id-a"));
  // Create a second file that claims the SAME id (a's) inside the risks dir.
  const dir = path.join(cwd, ".note-skills", "notes", "risks");
  const dupeFile = path.join(dir, `${a.id}-dupe.md`);
  const dupeNote = structuredClone(memory.read(a.id)!.note);
  dupeNote.title = "Dupe identity";
  dupeNote.summary = "Dupe summary";
  dupeNote.rationale = "Dupe rationale";
  dupeNote.next_action = "Dupe next";
  dupeNote.fingerprint = fingerprintOf("risk", dupeNote.title, dupeNote.summary);
  fs.writeFileSync(dupeFile, serializeNote(dupeNote, ""));
  // Both files now claim a.id -> scan must quarantine the WHOLE group.
  const scan = memory.scan();
  assert.equal(scan.notes.filter((entry) => entry.note.id === a.id).length, 0, "duplicate identity must not be trusted");
  expectCode(() => memory.read(a.id), "INCONSISTENT");
  const search = memory.search({ includeTerminal: true }).filter((hit) => hit.note.id === a.id);
  assert.equal(search.length, 0);
  const triggers = memory.evaluateTriggers(memory.loadCanonicalState()!).due;
  assert.equal(triggers.some((item) => item.id === a.id), false);
  const report = memory.reconcile({ fixIndex: true });
  assert.ok(report.issues.some((issue) => issue.code === "DUPLICATE_ID"));
});

test("secrets hidden in object keys are detected", () => {
  // Use a test-only custom pattern so the fixture key never resembles a real
  // credential (avoids tripping secret scanners on the test file itself).
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pm-secret-key-"));
  const memory = new ProjectMemory(cwd);
  memory.init({ project_id: "secret-key", extra_secret_patterns: ["FIXTURE_SECRET_[0-9a-f]{16}"] });
  const captured = memory.capture(input("idea", "secret-key"));
  const file = memory.read(captured.id)!;
  const raw = JSON.parse(JSON.stringify(file.note)) as Record<string, unknown>;
  raw["FIXTURE_SECRET_0123456789abcdef"] = "value";
  writeNoteFile(file.file, raw as never, file.body);
  assert.equal(memory.read(captured.id), null);
  const report = memory.reconcile({ fixIndex: true });
  assert.ok(report.issues.some((issue) => issue.code === "SECRET_POLICY"));
});

test("update() cannot enter a terminal status without a reason and cannot reopen", () => {
  const { memory } = fixture();
  const note = memory.capture(input("risk", "terminal-bypass"));
  expectCode(
    () => memory.update(note.id, { status: "closed" }),
    "INVALID_INPUT",
  );
  // close() still works with a reason.
  const closed = memory.close(note.id, { status: "closed", status_reason: "resolved in review" });
  assert.equal(closed.note.status, "closed");
  expectCode(
    () => memory.update(note.id, { status: "open" }),
    "INVALID_INPUT",
  );
});

test("dangerous or invalid custom secret patterns fail closed at config load", () => {
  // (a+)+ nested quantifier => ReDoS risk => INCONSISTENT at config parse.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pm-regex-"));
  const memory = new ProjectMemory(cwd);
  expectCode(
    () => memory.init({ project_id: "regex-test", extra_secret_patterns: ["(a+)+$"] }),
    "INCONSISTENT",
  );
  // Malformed pattern (unclosed group) also fails at init.
  const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "pm-regex2-"));
  const memory2 = new ProjectMemory(cwd2);
  expectCode(
    () => memory2.init({ project_id: "regex-test2", extra_secret_patterns: ["(("] }),
    "INCONSISTENT",
  );
});

test("forged pending JSON resolution is not trusted: nonexistent note reverts to unresolved", () => {
  const { cwd, memory } = fixture();
  const now = new Date().toISOString();
  const candId = `cand_${`a1`.repeat(16)}`;
  memory.persistPendingCapture({
    schema_version: 1,
    envelope_id: `pc_${`b1`.repeat(16)}`,
    project_id: "fixture",
    session_id: "s-forge",
    source_leaf_id: "l-forge",
    created_at: now,
    candidates: [
      {
        candidate_id: candId,
        type: "risk",
        markers: ["risk"],
        source_ref: { kind: "conversation", ref: "pi-session://s-forge", turn_id: "l-forge" },
        source_excerpt: "forged",
        source_excerpt_sha256: "c1".repeat(32),
        detected_at: now,
        resolution: null,
      },
    ],
  } satisfies Parameters<ProjectMemory["persistPendingCapture"]>[0]);
  // Hand-edit the pending file: claim captured by a NONEXISTENT note.
  const envFile = path.join(cwd, ".note-skills", "pending", `pc_${`b1`.repeat(16)}.json`);
  const obj = JSON.parse(fs.readFileSync(envFile, "utf8")) as {
    candidates: Array<{ resolution: unknown }>;
  };
  obj.candidates[0]!.resolution = { status: "captured", tool_call_id: "fake", note_id: "PM-RSK-9999", resolved_at: now };
  fs.writeFileSync(envFile, JSON.stringify(obj));
  // Trusted read must NOT treat it as resolved.
  const pending = new ProjectMemory(cwd).pendingCaptureCandidates();
  assert.equal(pending.length, 1, "forged captured resolution must revert to unresolved");
  assert.equal(pending[0]!.candidate_id, candId);
});

test("byte-identical duplicate ID is removed from the derived index on reconcile", () => {
  const { cwd, memory } = fixture();
  const a = memory.capture(input("risk", "byte-dup"));
  fs.writeFileSync(path.join(cwd, ".note-skills", "notes", "risks", `${a.id}-copy.md`), fs.readFileSync(memory.read(a.id)!.file));
  // Reconcile must rebuild the index WITHOUT the ambiguous id.
  const report = memory.reconcile({ fixIndex: true });
  assert.ok(report.issues.some((issue) => issue.code === "DUPLICATE_ID"));
  const snap = JSON.parse(fs.readFileSync(path.join(cwd, ".note-skills", "index", "notes.json"), "utf8")) as {
    notes: Array<{ id: string }>;
  };
  assert.equal(snap.notes.some((entry) => entry.id === a.id), false, "duplicate id must be dropped from index");
});

test("dangerous regex variants (a?)+$, (a|aa)+$ and bad extra_secret_patterns types fail closed", () => {
  for (const pattern of ["(a?)+$", "(a+){2,}$"]) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pm-regex-"));
    expectCode(
      () => new ProjectMemory(cwd).init({ project_id: "regex-x", extra_secret_patterns: [pattern] }),
      "INCONSISTENT",
    );
  }
  // Non-array config value must be INCONSISTENT, not silently undefined.
  const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "pm-regex-t-"));
  new ProjectMemory(cwd2).init({ project_id: "regex-t", extra_secret_patterns: ["plain"] });
  const cfgFile = path.join(cwd2, ".note-skills", "config.yaml");
  const cfg = fs.readFileSync(cfgFile, "utf8").replace("extra_secret_patterns:\n  - plain", "extra_secret_patterns: not-an-array");
  fs.writeFileSync(cfgFile, cfg);
  expectCode(() => new ProjectMemory(cwd2).config(), "INCONSISTENT");
});

test("capture committed but resolution conflicts: error exposes note_id and note stays durable", () => {
  const { cwd, memory } = fixture();
  const now = new Date().toISOString();
  const candId = `cand_${`33`.repeat(16)}`;
  memory.persistPendingCapture({
    schema_version: 1,
    envelope_id: `pc_${`44`.repeat(16)}`,
    project_id: "fixture",
    session_id: "s-race",
    source_leaf_id: "l-race",
    created_at: now,
    candidates: [
      {
        candidate_id: candId,
        type: "risk",
        markers: ["risk"],
        source_ref: { kind: "conversation", ref: "pi-session://s-race", turn_id: "l-race" },
        source_excerpt: "race risk",
        source_excerpt_sha256: "55".repeat(32),
        detected_at: now,
        resolution: null,
      },
    ],
  } satisfies Parameters<ProjectMemory["persistPendingCapture"]>[0]);
  // First, claim the candidate with an ATOMIC bind (the other process must use
  // the same trusted path — a non-atomic settle cannot prove binding).
  const raceWin = memory.captureAndResolvePending(
    [candId],
    {
      type: "risk",
      title: "Race note",
      summary: "durable note",
      rationale: "x",
      next_action: "x",
      source_refs: [{ kind: "conversation", ref: "pi-session://s-race", turn_id: "l-race" }],
    },
    "race-winner",
  );
  // captureAndResolvePending pre-validates the candidate set BEFORE capture:
  // since the candidate is already resolved, the call must fail WITHOUT any
  // new note side effect (pre-check is strictly better than post-write failure).
  const beforeCount = memory.search({ type: "risk", includeTerminal: true }).length;
  try {
    memory.captureAndResolvePending(
      [candId],
      {
        type: "risk",
        title: "Second race note",
        summary: "durable too",
        rationale: "x",
        next_action: "x",
        source_refs: [{ kind: "conversation", ref: "pi-session://s-race", turn_id: "l-race" }],
      },
      "race-call-1",
    );
    assert.fail("expected resolution failure");
  } catch (error) {
    // NOT_FOUND (candidate already resolved) — and critically NO new note.
    assert.equal((error as { code: string }).code, "NOT_FOUND");
    assert.equal(memory.search({ type: "risk", includeTerminal: true }).length, beforeCount);
  }
});

test("review_reason-only deletion is quarantined (status stays clear)", () => {
  const { memory } = fixture();
  const captured = memory.capture(input("risk", "reason-only"));
  const file = memory.read(captured.id)!;
  const raw = JSON.parse(JSON.stringify(file.note)) as Record<string, unknown>;
  raw.review_status = "clear";
  delete raw.review_reason;
  writeNoteFile(file.file, raw as never, file.body);
  assert.equal(memory.read(captured.id), null);
  const report = memory.reconcile({ fixIndex: true });
  assert.ok(report.issues.some((issue) => issue.code === "SCHEMA" && /review_reason/.test(issue.message)));
});

test("(a|aa)+$ quantified alternation is rejected as dangerous", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pm-regex-alt-"));
  expectCode(
    () => new ProjectMemory(cwd).init({ project_id: "regex-alt", extra_secret_patterns: ["(a|aa)+$"] }),
    "INCONSISTENT",
  );
});

test("cross-settlement forgery: candidate B cannot be settled by note A via hand-edited resolution", () => {
  const { cwd, memory } = fixture();
  const now = new Date().toISOString();
  // Two same-type candidates, same session+leaf, distinct excerpts.
  memory.persistPendingCapture({
    schema_version: 1,
    envelope_id: `pc_${`f3`.repeat(16)}`,
    project_id: "fixture",
    session_id: "s-x",
    source_leaf_id: "l-x",
    created_at: now,
    candidates: [
      {
        candidate_id: `cand_${`11`.repeat(16)}`,
        type: "risk",
        markers: ["风险"],
        source_ref: { kind: "conversation", ref: "pi-session://s-x", turn_id: "l-x" },
        source_excerpt: "...风险 A 迁移兼容性...",
        source_excerpt_sha256: "2a".repeat(32),
        detected_at: now,
        resolution: null,
      },
      {
        candidate_id: `cand_${`33`.repeat(16)}`,
        type: "risk",
        markers: ["风险"],
        source_ref: { kind: "conversation", ref: "pi-session://s-x", turn_id: "l-x" },
        source_excerpt: "...风险 B 插件凭证...",
        source_excerpt_sha256: "4b".repeat(32),
        detected_at: now,
        resolution: null,
      },
    ],
  } satisfies Parameters<ProjectMemory["persistPendingCapture"]>[0]);
  // Capture A with ITS excerpt hash (atomic bind).
  const boundA = memory.captureAndResolvePending(
    [`cand_${`11`.repeat(16)}`],
    {
      type: "risk",
      title: "Migrate compatibility",
      summary: "A risk",
      rationale: "x",
      next_action: "x",
      source_refs: [{ kind: "conversation", ref: "pi-session://s-x", turn_id: "l-x" }],
    },
    "xbind-a",
  );
  assert.equal(boundA.resolved.length, 1);
  // Attack: hand-edit candidate B resolution to point at A's note.
  const envFile = path.join(cwd, ".note-skills", "pending", `pc_${`f3`.repeat(16)}.json`);
  const obj = JSON.parse(fs.readFileSync(envFile, "utf8")) as {
    candidates: Array<{ candidate_id: string; resolution: unknown }>;
  };
  obj.candidates[1]!.resolution = {
    status: "captured",
    tool_call_id: "fake",
    note_id: boundA.receipt.id,
    resolved_at: now,
  };
  fs.writeFileSync(envFile, JSON.stringify(obj));
  const remaining = new ProjectMemory(cwd).pendingCaptureCandidates();
  assert.equal(remaining.length, 1, "forged cross-settlement must revert B to unresolved");
  assert.equal(remaining[0]!.candidate_id, `cand_${`33`.repeat(16)}`);
});

test("same-block same-excerpt candidates cannot cross-settle (real occurrence binding)", () => {
  const { cwd, memory } = fixture();
  const now = new Date().toISOString();
  // Two risk candidates with IDENTICAL source identity and IDENTICAL excerpt
  // hash (short block => same raw excerpt), distinguished only by candidate_id.
  const sameExcerpt = "9c".repeat(32);
  memory.persistPendingCapture({
    schema_version: 1,
    envelope_id: `pc_${`ab`.repeat(16)}`,
    project_id: "fixture",
    session_id: "s-same",
    source_leaf_id: "l-same",
    created_at: now,
    candidates: [
      {
        candidate_id: `cand_${`cd`.repeat(16)}`,
        type: "risk",
        markers: ["风险"],
        source_ref: { kind: "conversation", ref: "pi-session://s-same", turn_id: "l-same" },
        source_excerpt: "风险 A 迁移。风险 B 插件。",
        source_excerpt_sha256: sameExcerpt,
        detected_at: now,
        resolution: null,
      },
      {
        candidate_id: `cand_${`ef`.repeat(16)}`,
        type: "risk",
        markers: ["风险"],
        source_ref: { kind: "conversation", ref: "pi-session://s-same", turn_id: "l-same" },
        source_excerpt: "风险 A 迁移。风险 B 插件。",
        source_excerpt_sha256: sameExcerpt,
        detected_at: now,
        resolution: null,
      },
    ],
  } satisfies Parameters<ProjectMemory["persistPendingCapture"]>[0]);
  // Atomically bind candidate A only.
  const boundA = memory.captureAndResolvePending(
    [`cand_${`cd`.repeat(16)}`],
    {
      type: "risk",
      title: "Risk A",
      summary: "A",
      rationale: "x",
      next_action: "x",
      source_refs: [{ kind: "conversation", ref: "pi-session://s-same", turn_id: "l-same" }],
    },
    "same-call-a",
  );
  assert.equal(boundA.resolved.length, 1);
  // Forge: point candidate B's resolution at A's note.
  const envFile = path.join(cwd, ".note-skills", "pending", `pc_${`ab`.repeat(16)}.json`);
  const obj = JSON.parse(fs.readFileSync(envFile, "utf8")) as {
    candidates: Array<{ candidate_id: string; resolution: unknown }>;
  };
  const bIdx = obj.candidates.findIndex((c) => c.candidate_id === `cand_${`ef`.repeat(16)}`);
  obj.candidates[bIdx]!.resolution = {
    status: "captured",
    tool_call_id: "fake",
    note_id: boundA.receipt.id,
    resolved_at: now,
  };
  fs.writeFileSync(envFile, JSON.stringify(obj));
  const remaining = new ProjectMemory(cwd).pendingCaptureCandidates();
  assert.equal(remaining.length, 1, "same-excerpt candidate B must revert to unresolved");
  assert.equal(remaining[0]!.candidate_id, `cand_${`ef`.repeat(16)}`);
});

test("forged status:skipped resolution reverts to unresolved without a receipt", () => {
  const { cwd, memory } = fixture();
  const now = new Date().toISOString();
  const candId = `cand_${`11`.repeat(16)}`;
  memory.persistPendingCapture({
    schema_version: 1,
    envelope_id: `pc_${`22`.repeat(16)}`,
    project_id: "fixture",
    session_id: "s-skip",
    source_leaf_id: "l-skip",
    created_at: now,
    candidates: [
      {
        candidate_id: candId,
        type: "risk",
        markers: ["风险"],
        source_ref: { kind: "conversation", ref: "pi-session://s-skip", turn_id: "l-skip" },
        source_excerpt: "skip test",
        source_excerpt_sha256: "33".repeat(32),
        detected_at: now,
        resolution: null,
      },
    ],
  } satisfies Parameters<ProjectMemory["persistPendingCapture"]>[0]);
  // Legit acknowledge path writes a receipt; verify trusted read keeps it resolved.
  memory.resolvePendingCapture([candId], { status: "skipped", tool_call_id: "real-call", reason: "false positive" });
  const afterLegit = new ProjectMemory(cwd).pendingCaptureCandidates();
  assert.equal(afterLegit.length, 0, "legit skip with receipt stays resolved");
  // Forge: hand-edit a different candidate to skipped WITHOUT receipt.
  const candId2 = `cand_${`44`.repeat(16)}`;
  memory.persistPendingCapture({
    schema_version: 1,
    envelope_id: `pc_${`55`.repeat(16)}`,
    project_id: "fixture",
    session_id: "s-skip2",
    source_leaf_id: "l-skip2",
    created_at: now,
    candidates: [
      {
        candidate_id: candId2,
        type: "risk",
        markers: ["风险"],
        source_ref: { kind: "conversation", ref: "pi-session://s-skip2", turn_id: "l-skip2" },
        source_excerpt: "skip test 2",
        source_excerpt_sha256: "66".repeat(32),
        detected_at: now,
        resolution: null,
      },
    ],
  } satisfies Parameters<ProjectMemory["persistPendingCapture"]>[0]);
  const envFile = path.join(cwd, ".note-skills", "pending", `pc_${`55`.repeat(16)}.json`);
  const obj = JSON.parse(fs.readFileSync(envFile, "utf8")) as {
    candidates: Array<{ candidate_id: string; resolution: unknown }>;
  };
  obj.candidates[0]!.resolution = { status: "skipped", tool_call_id: "fake", reason: "fake reason", resolved_at: now };
  fs.writeFileSync(envFile, JSON.stringify(obj));
  const afterForged = new ProjectMemory(cwd).pendingCaptureCandidates();
  assert.equal(afterForged.length, 1, "forged skip without receipt must revert to unresolved");
  assert.equal(afterForged[0]!.candidate_id, candId2);
});

test("skip receipt writes are project-contained and batch-atomic (symlink / dir target / no half-settle)", () => {
  const { cwd, memory } = fixture();
  const now = new Date().toISOString();
  const mkCandidate = (id: string, session: string) => ({
    candidate_id: id,
    type: "risk" as const,
    markers: ["风险"],
    source_ref: { kind: "conversation" as const, ref: `pi-session://${session}`, turn_id: "l" },
    source_excerpt: "skip receipt",
    source_excerpt_sha256: `${id.slice(5, 37)}`.padEnd(64, "1"),
    detected_at: now,
    resolution: null,
  });
  const candA = `cand_${`ab`.repeat(16)}`;
  const candB = `cand_${`cd`.repeat(16)}`;
  memory.persistPendingCapture({
    schema_version: 1,
    envelope_id: `pc_${`34`.repeat(16)}`,
    project_id: "fixture",
    session_id: "s-receipt",
    source_leaf_id: "l",
    created_at: now,
    candidates: [mkCandidate(candA, "s-receipt"), mkCandidate(candB, "s-receipt")],
  } satisfies Parameters<ProjectMemory["persistPendingCapture"]>[0]);
  const receiptsDir = path.join(cwd, ".note-skills", "pending", ".receipts");

  // Scenario A: .receipts replaced by a symlink to outside.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pm-receipt-out-"));
  fs.rmSync(receiptsDir, { recursive: true, force: true });
  fs.symlinkSync(outside, receiptsDir, "dir");
  expectCode(
    () =>
      memory.resolvePendingCapture([candA], {
        status: "skipped",
        tool_call_id: "call-a",
        reason: "false positive",
      }),
    "INCONSISTENT",
  );
  assert.equal(fs.readdirSync(outside).length, 0, "receipt must not land outside via symlink");
  fs.rmSync(receiptsDir, { force: true });

  // Scenario B: receipt target is a directory -> whole batch fails, no half-settle.
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.mkdirSync(path.join(receiptsDir, `${candA}.json`), { recursive: true });
  const isRenameFailure = (error: unknown) =>
    (error as { code?: string }).code === "EISDIR" || (error as { code?: string }).code === "EEXIST";
  assert.throws(
    () =>
      memory.resolvePendingCapture([candA], {
        status: "skipped",
        tool_call_id: "call-a",
        reason: "false positive",
      }),
    isRenameFailure,
  );
  // Envelope must NOT be committed (candidate stays unresolved).
  assert.equal(new ProjectMemory(cwd).pendingCaptureCandidates().length, 2);
  fs.rmSync(path.join(receiptsDir, `${candA}.json`), { recursive: true, force: true });

  // Scenario C: two-candidate batch with a dir target for B -> no half-settle.
  fs.mkdirSync(path.join(receiptsDir, `${candB}.json`), { recursive: true });
  assert.throws(
    () =>
      memory.resolvePendingCapture([candA, candB], {
        status: "skipped",
        tool_call_id: "call-ab",
        reason: "false positives",
      }),
    isRenameFailure,
  );
  assert.equal(new ProjectMemory(cwd).pendingCaptureCandidates().length, 2, "batch must not half-settle");
});

test("captureAndResolvePending settles via the merged path (existing fingerprint note)", () => {
  const { cwd, memory } = fixture();
  const now = new Date().toISOString();
  const candId = `cand_${`77`.repeat(16)}`;
  memory.persistPendingCapture({
    schema_version: 1,
    envelope_id: `pc_${`88`.repeat(16)}`,
    project_id: "fixture",
    session_id: "s-merge",
    source_leaf_id: "l-merge",
    created_at: now,
    candidates: [
      {
        candidate_id: candId,
        type: "risk",
        markers: ["风险"],
        source_ref: { kind: "conversation", ref: "pi-session://s-merge", turn_id: "l-merge" },
        source_excerpt: "merged risk",
        source_excerpt_sha256: "99".repeat(32),
        detected_at: now,
        resolution: null,
      },
    ],
  } satisfies Parameters<ProjectMemory["persistPendingCapture"]>[0]);
  // Seed an existing note with the SAME fingerprint (title/summary) but a
  // different source (no candidate binding yet).
  memory.capture({
    type: "risk",
    title: "Merged risk",
    summary: "Merged summary",
    rationale: "x",
    next_action: "x",
    source_refs: [{ kind: "conversation", ref: "pi-session://s-merge", turn_id: "l-merge" }],
  });
  // Atomic bind now hits the merge path.
  const bound = memory.captureAndResolvePending(
    [candId],
    {
      type: "risk",
      title: "Merged risk",
      summary: "Merged summary",
      rationale: "x",
      next_action: "x",
      source_refs: [{ kind: "conversation", ref: "pi-session://s-merge", turn_id: "l-merge" }],
    },
    "merge-bind-call",
  );
  assert.equal(bound.receipt.status, "merged");
  assert.equal(bound.resolved.length, 1);
  assert.equal(new ProjectMemory(cwd).pendingCaptureCandidates().length, 0);
  const note = memory.read(bound.receipt.id)!;
  assert.ok(
    note.note.source_refs.some((source) => source.candidate_id === candId && source.excerpt_sha256 === "99".repeat(32)),
    "merged note must carry the candidate-bound source",
  );
});
