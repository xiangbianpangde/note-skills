import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  ProjectMemory,
  ProjectMemoryError,
  flushWorkingContext,
  readWorkingContext,
  verifyFlushReceipt,
  projectContextPath,
  checkpointPath,
  flushReceiptPath,
} from "../src/index.ts";
import projectMemoryExtension from "../extensions/note-skills.ts";

function extensionHarness() {
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const commands: string[] = [];
  const commandHandlers = new Map<string, (args: string, ctx: unknown) => unknown>();
  const events = new Map<string, (...args: unknown[]) => unknown>();
  const sent: unknown[] = [];
  const entries: unknown[] = [];
  const mock = {
    registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      tools.push(tool);
    },
    registerCommand(name: string, spec: { description?: string; handler: (args: string, ctx: unknown) => unknown }) {
      commands.push(name);
      commandHandlers.set(name, spec.handler);
    },
    on(name: string, handler: (...args: unknown[]) => unknown) {
      events.set(name, handler);
    },
    sendMessage(message: unknown) {
      sent.push(message);
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
  };
  projectMemoryExtension(mock as never);
  return { tools, commands, commandHandlers, events, sent, entries };
}

function validContextBody(objective: string = "Execute primary task", nextAction: string = "Run verification"): string {
  return [
    "# Project Working Context",
    "",
    "## Current Objective",
    `- ${objective}`,
    "",
    "## Canonical References",
    "- SPEC: docs/spec.md @ v1",
    "",
    "## Verified Working State",
    "- Core infrastructure is verified",
    "",
    "## Negative Constraints / Do Not Assume",
    "- Do not assume P1 is approved",
    "- Do not modify canonical files directly",
    "",
    "## Next Action",
    `- ${nextAction}`,
  ].join("\n");
}

/* ================================================================== */
/* P0-E: 12 Adversarial Failure Mode Tests (§8 & §21 Architecture)    */
/* ================================================================== */

test("P0-E (1/12): Ordinary resume loads working context cleanly", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-01-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-01" });

  const receipt = pm.flushWorkingContext({
    content: validContextBody("Build compiler pipeline", "Add parser tokens"),
    covered_through_entry_id: "turn-001",
    source_session_id: "session-1",
  });
  assert.equal(receipt.status, "FLUSH_VERIFIED");

  const restored = pm.readWorkingContext();
  assert.ok(restored);
  assert.equal(restored?.metadata.checkpoint_id, "CP-0001");
  assert.match(restored?.body ?? "", /Build compiler pipeline/);
  assert.match(restored?.body ?? "", /Add parser tokens/);
});

test("P0-E (2/12): Negative constraints ('Do Not Assume') are preserved and enforceable", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-02-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-02" });

  pm.flushWorkingContext({
    content: validContextBody("Refactor storage", "Implement write locks"),
    covered_through_entry_id: "turn-002",
  });

  const ctx = pm.readWorkingContext();
  assert.ok(ctx);
  // Must preserve negative constraints explicitly
  assert.match(ctx!.body, /Do not assume P1 is approved/);
  assert.match(ctx!.body, /Do not modify canonical files directly/);
});

test("P0-E (3/12): Canonical truth overrides working projection on conflict (INV-AUTH-02)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-03-"));
  fs.writeFileSync(path.join(cwd, "state.yaml"), "milestones:\n  P0: in_progress\n");
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-03", canonical_state_file: "state.yaml" });

  // Working context projection claims P0 is complete, but canonical state says in_progress
  pm.flushWorkingContext({
    content: validContextBody("Complete milestone P0", "Deploy to production"),
    covered_through_entry_id: "turn-003",
  });

  // Evaluate trigger from canonical state
  const state = pm.loadCanonicalState();
  assert.ok(state);
  assert.equal(state?.milestones.P0, "in_progress");

  // Canonical state always wins; working context is non-authoritative working projection
  const workingCtx = pm.readWorkingContext();
  assert.equal(workingCtx?.metadata.authority, "working_projection");
});

test("P0-E (4/12): External file edit by human triggers CONTEXT_CONFLICT on stale agent flush", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-04-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-04" });

  const receipt1 = pm.flushWorkingContext({
    content: validContextBody("Initial task", "Step 1"),
    covered_through_entry_id: "turn-004a",
  });

  // Human opens PROJECT_CONTEXT.md and manually edits a constraint
  const contextFile = projectContextPath(cwd);
  const currentContent = fs.readFileSync(contextFile, "utf8");
  const humanEditedContent = currentContent.replace("Step 1", "Human modified step 1");
  fs.writeFileSync(contextFile, humanEditedContent);

  // Agent tries to flush next revision using old base hash
  assert.throws(
    () =>
      pm.flushWorkingContext({
        content: validContextBody("Initial task", "Agent step 2"),
        covered_through_entry_id: "turn-004b",
        base_context_sha256: receipt1.new_context_sha256,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "CONTEXT_CONFLICT");
      return true;
    },
  );
});

test("P0-E (5/12): Branch switch detects CONTEXT_STALE and warns before injection", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-05-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-05" });
  const { events } = extensionHarness();
  const notifications: string[] = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      setStatus() {},
      notify(msg: string) {
        notifications.push(msg);
      },
    },
    sessionManager: { getSessionId: () => "s", getLeafId: () => "l" },
  };

  // Checkpoint flushed on branch 'main'
  pm.flushWorkingContext({
    content: validContextBody("Feature A", "Step A"),
    covered_through_entry_id: "t-05",
    git_branch: "main",
  });

  // Mock workspace switched to branch 'release-v2'
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/release-v2\n");

  const result = (events.get("before_agent_start")!({ prompt: "Status" }, ctx)) as {
    message: { content: string };
  };

  assert.match(result.message.content, /CONTEXT_STALE/);
  assert.match(result.message.content, /release-v2/);
  assert.ok(notifications.some((msg) => /CONTEXT_STALE/.test(msg)));
});

test("P0-E (6/12): Corrupted PROJECT_CONTEXT.md fails closed with INVALID_INPUT without crashing", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-06-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-06" });

  // Write broken frontmatter
  fs.writeFileSync(projectContextPath(cwd), "No frontmatter at all\n");
  assert.throws(
    () => pm.readWorkingContext(),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "INVALID_INPUT");
      return true;
    },
  );
});

test("P0-E (7/12): Corrupted checkpoint file fails receipt verification (INV-COMPACT-01)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-07-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-07" });

  const receipt = pm.flushWorkingContext({
    content: validContextBody("Task", "Step"),
    covered_through_entry_id: "t-07",
  });
  assert.equal(receipt.status, "FLUSH_VERIFIED");

  // Corrupt the checkpoint snapshot
  const cpFile = checkpointPath(cwd, receipt.checkpoint_id);
  fs.writeFileSync(cpFile, "corrupted content\n");

  // verifyFlushReceipt must fail and return null
  const verified = pm.verifyFlushReceipt(receipt.checkpoint_id);
  assert.equal(verified, null);
});

test("P0-E (8/12): Uncheckpointed mid-run overflow triggers Mode B Emergency Safe Compaction", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-08-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-08" });
  const { events, entries } = extensionHarness();
  const ctx = {
    cwd,
    hasUI: false,
    ui: { setStatus() {}, notify() {} },
    sessionManager: { getSessionId: () => "s-08", getLeafId: () => "l-08" },
  };

  // Event with reason: "overflow" when no checkpoint exists
  const overflowEvent = {
    type: "session_before_compact",
    reason: "overflow" as const,
    willRetry: true,
    signal: new AbortController().signal,
    preparation: {
      firstKeptEntryId: "e-kept",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 120_000,
      fileOps: {} as never,
      settings: {} as never,
    },
    branchEntries: [{ id: "e-01", type: "message", message: { role: "user" } }],
  };

  const result = events.get("session_before_compact")!(overflowEvent, ctx);
  // Must return undefined so Pi native structured compaction handles it safely
  assert.equal(result, undefined);

  const emergencyLog = entries.find(
    (e) => (e as { data?: { mode?: string; reason?: string } }).data?.mode === "emergency_safe",
  );
  assert.ok(emergencyLog, "must record emergency safe compaction log");
});

test("P0-E (9/12): Unresolved capture candidates block compaction once with warning", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-09-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-09" });
  const { events } = extensionHarness();
  const ctx = {
    cwd,
    hasUI: false,
    ui: { setStatus() {}, notify() {} },
    sessionManager: { getSessionId: () => "s-09", getLeafId: () => "l-09" },
  };

  // Generate an unhandled candidate
  events.get("agent_end")!({ messages: [{ role: "user", content: "P1 延期任务待处理" }] }, ctx);
  const pending = pm.pendingCaptureCandidates();
  assert.ok(pending.length >= 1);

  // First compaction attempt is blocked
  const firstBlock = events.get("session_before_compact")!({}, ctx);
  assert.deepEqual(firstBlock, { cancel: true });

  // Second compaction attempt fails open
  const secondAttempt = events.get("session_before_compact")!({}, ctx);
  assert.equal(secondAttempt, undefined);
});

test("P0-E (10/12): Secret pattern injected into working context triggers POLICY_VIOLATION", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-10-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-10" });

  assert.throws(
    () =>
      pm.flushWorkingContext({
        content: validContextBody("Secret task", "Step") + "\ntoken=supersecretvalue123456",
        covered_through_entry_id: "t-10",
      }),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "POLICY_VIOLATION");
      return true;
    },
  );
});

test("P0-E (11/12): Content exceeding 5KB hard budget triggers BUDGET_EXCEEDED", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-11-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-11" });

  const oversizedBody = validContextBody("Oversized task", "Step") + "\n" + "x".repeat(5120);
  assert.throws(
    () =>
      pm.flushWorkingContext({
        content: oversizedBody,
        covered_through_entry_id: "t-11",
      }),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "BUDGET_EXCEEDED");
      return true;
    },
  );
});

test("P0-E (12/12): Concurrent flush attempts serialize under context.lock and detect race", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-12-"));
  const pm1 = new ProjectMemory(cwd);
  const pm2 = new ProjectMemory(cwd);
  pm1.init({ project_id: "adv-12" });

  // First flush creates CP-0001
  const r1 = pm1.flushWorkingContext({
    content: validContextBody("Initial task", "Step 1"),
    covered_through_entry_id: "t-12a",
  });
  assert.equal(r1.checkpoint_id, "CP-0001");

  // Writer 1 flushes revision 2 with CP-0001 hash as base
  const r2 = pm1.flushWorkingContext({
    content: validContextBody("Initial task", "Step 2 by Writer 1"),
    covered_through_entry_id: "t-12b",
    base_context_sha256: r1.new_context_sha256,
  });
  assert.equal(r2.checkpoint_id, "CP-0002");

  // Writer 2 attempts to flush revision 2 with old CP-0001 hash as base
  assert.throws(
    () =>
      pm2.flushWorkingContext({
        content: validContextBody("Initial task", "Step 2 by Writer 2"),
        covered_through_entry_id: "t-12c",
        base_context_sha256: r1.new_context_sha256,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "CONTEXT_CONFLICT");
      return true;
    },
  );
});
