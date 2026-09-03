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
  contextLockPath,
  acquireLockFile,
  releaseLockFile,
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

function validContextBody(
  objective: string = "Execute primary task",
  nextAction: string = "Run verification",
  negativeConstraints: string = "- Do not assume P1 is approved\n- Do not modify canonical files directly",
): string {
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
    negativeConstraints,
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

test("P0-E (2/12): Negative constraints anti-wipeout: silent deletion is forbidden and commands inherit constraints", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-02-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-02" });

  const r1 = pm.flushWorkingContext({
    content: validContextBody("Refactor storage", "Implement write locks", "- Do not deploy before security audit"),
    covered_through_entry_id: "turn-002a",
  });
  assert.equal(r1.checkpoint_id, "CP-0001");

  // Attack 1: Attempting to silently wipe negative constraints with "- None specified"
  assert.throws(
    () =>
      pm.flushWorkingContext({
        content: validContextBody("Refactor storage", "Implement write locks", "- None specified"),
        covered_through_entry_id: "turn-002b",
        base_context_sha256: r1.new_context_sha256,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "POLICY_VIOLATION");
      assert.match(err.message, /silent deletion of negative constraints is forbidden/);
      return true;
    },
  );

  // Behavior 2: /note-skills-flush command must inherit existing negative constraints instead of overwriting with None specified
  const { commandHandlers } = extensionHarness();
  const ctx = {
    cwd,
    hasUI: true,
    ui: { setStatus() {}, notify() {} },
    sessionManager: { getSessionId: () => "s-02", getLeafId: () => "turn-002c" },
  };

  await commandHandlers.get("note-skills-flush")!("Deploy next step", ctx);
  const cp2 = pm.readWorkingContext();
  assert.equal(cp2?.metadata.checkpoint_id, "CP-0002");
  assert.match(cp2!.body, /Do not deploy before security audit/, "CP-0002 must inherit negative constraints from CP-0001");
});

test("P0-E (3/12): Canonical truth overrides working projection on conflict (INV-AUTH-02 arbitration)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-03-"));
  fs.writeFileSync(path.join(cwd, "state.yaml"), "milestones:\n  P0: in_progress\n");
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-03", canonical_state_file: "state.yaml" });

  // 1. Attempting to flush a working context that asserts P0 is complete contradicts canonical state -> CONFLICT
  assert.throws(
    () =>
      pm.flushWorkingContext({
        content: validContextBody("Complete milestone P0", "milestone P0 is complete and verified"),
        covered_through_entry_id: "turn-003a",
      }),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "CONFLICT");
      assert.match(err.message, /working context contradicts canonical milestone "P0"/);
      return true;
    },
  );

  // 2. Flush a valid context
  pm.flushWorkingContext({
    content: validContextBody("Implement P0 tasks", "Continue milestone P0 implementation"),
    covered_through_entry_id: "turn-003b",
  });

  // 3. Now simulate hand-editing PROJECT_CONTEXT on disk to contradict canonical state.yaml
  const ctxFile = projectContextPath(cwd);
  const currentText = fs.readFileSync(ctxFile, "utf8");
  fs.writeFileSync(ctxFile, currentText.replace("Continue milestone P0 implementation", "milestone P0 is complete"));

  // 4. before_agent_start must detect the canonical conflict, fail closed, and suppress operational state!
  const { events } = extensionHarness();
  const ctx = {
    cwd,
    hasUI: true,
    ui: { setStatus() {}, notify() {} },
    sessionManager: { getSessionId: () => "s-03", getLeafId: () => "turn-003c" },
  };

  const result = (events.get("before_agent_start")!({ prompt: "Status" }, ctx)) as {
    message: { customType: string; content: string; details: { authority: string } };
  };

  assert.ok(result.message);
  assert.equal(result.message.customType, "note-skills-canonical-conflict");
  assert.equal(result.message.details.authority, "canonical");
  assert.match(result.message.content, /CANONICAL_CONFLICT/);
  assert.match(result.message.content, /CANONICAL TRUTH PRECEDES WORKING PROJECTION/);
  // Operational state is suppressed
  assert.equal(/Continue milestone P0/.test(result.message.content), false);
});

test("P0-E (4/12): External file edit by human triggers CONTEXT_CONFLICT; base hash is mandatory on update", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-04-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-04" });

  const receipt1 = pm.flushWorkingContext({
    content: validContextBody("Initial task", "Step 1"),
    covered_through_entry_id: "turn-004a",
  });

  // Gap closure: Calling flush on existing context without base_context_sha256 is FORBIDDEN
  assert.throws(
    () =>
      pm.flushWorkingContext({
        content: validContextBody("Initial task", "Step 2"),
        covered_through_entry_id: "turn-004b",
      }),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "CONTEXT_CONFLICT");
      assert.match(err.message, /base_context_sha256 is mandatory/);
      return true;
    },
  );

  // Human opens PROJECT_CONTEXT.md and manually edits a step
  const contextFile = projectContextPath(cwd);
  const currentContent = fs.readFileSync(contextFile, "utf8");
  fs.writeFileSync(contextFile, currentContent.replace("Step 1", "Human modified step 1"));

  // Agent tries to flush next revision using old base hash -> CONTEXT_CONFLICT
  assert.throws(
    () =>
      pm.flushWorkingContext({
        content: validContextBody("Initial task", "Agent step 2"),
        covered_through_entry_id: "turn-004c",
        base_context_sha256: receipt1.new_context_sha256,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "CONTEXT_CONFLICT");
      assert.match(err.message, /modified concurrently/);
      return true;
    },
  );
});

test("P0-E (5/12): Branch drift fail-closed: git branch auto-collected and operational body suppressed on drift", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-05-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-05" });

  // Initialize git repository structure
  fs.mkdirSync(path.join(cwd, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(cwd, ".git", "refs", "heads", "main"), "1122334455667788990011223344556677889900\n");

  // Flush without passing git_branch -> service must automatically collect branch 'main'
  const receipt = pm.flushWorkingContext({
    content: validContextBody("Feature Secret", "Deploy feature secret to production"),
    covered_through_entry_id: "t-05",
  });
  assert.equal(receipt.git_branch, "main");

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

  // Mock workspace switched to branch 'release-v2'
  fs.writeFileSync(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/release-v2\n");

  const result = (events.get("before_agent_start")!({ prompt: "Status" }, ctx)) as {
    message: { content: string };
  };

  // FAIL-CLOSED: Operational body MUST NOT be injected!
  assert.match(result.message.content, /CONTEXT_STALE/);
  assert.match(result.message.content, /OPERATIONAL STATE SUPPRESSED/);
  assert.equal(/Deploy feature secret to production/.test(result.message.content), false, "operational body must be suppressed on branch drift");
  assert.ok(notifications.some((msg) => /CONTEXT_STALE/.test(msg)));
});

test("P0-E (6/12): Corrupted/invalid PROJECT_CONTEXT.md fails closed on read boundary", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-06-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-06" });

  // 1. Broken frontmatter fails closed with INVALID_INPUT
  fs.writeFileSync(projectContextPath(cwd), "No frontmatter at all\n");
  assert.throws(
    () => pm.readWorkingContext(),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "INVALID_INPUT");
      return true;
    },
  );

  // 2. Syntactically valid frontmatter but missing required section fails closed on read
  const missingSection = [
    "---",
    "schema_version: 1",
    "project_id: adv-06",
    "authority: working_projection",
    "context_revision: 1",
    "checkpoint_id: CP-0001",
    "source_session_id: s",
    "covered_through_entry_id: e",
    "base_context_sha256: ''",
    "generated_at: '2026-09-03T10:00:00.000Z'",
    "---",
    "# Working Context",
    "## Current Objective\n- Only objective",
  ].join("\n");
  fs.writeFileSync(projectContextPath(cwd), missingSection);

  assert.throws(
    () => pm.readWorkingContext(),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "INVALID_INPUT");
      assert.match(err.message, /missing required/);
      return true;
    },
  );
});

test("P0-E (7/12): Tampered receipt metadata fails verification and forces Mode B (INV-COMPACT-01)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-07-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-07" });

  const receipt = pm.flushWorkingContext({
    content: validContextBody("Task", "Step"),
    covered_through_entry_id: "turn-007",
    source_session_id: "session-07",
  });
  assert.equal(receipt.status, "FLUSH_VERIFIED");

  // Attack: tamper receipt JSON's covered_through_entry_id while checkpoint bytes are untouched
  const rFile = flushReceiptPath(cwd, receipt.checkpoint_id);
  const rData = JSON.parse(fs.readFileSync(rFile, "utf8"));
  rData.covered_through_entry_id = "falsified-turn-id";
  fs.writeFileSync(rFile, JSON.stringify(rData, null, 2));

  // 1. verifyFlushReceipt must detect metadata tampering and return null
  assert.equal(pm.verifyFlushReceipt(receipt.checkpoint_id), null);

  // 2. Compaction must fail-closed into Mode B (emergency safe compaction)
  const { events, entries } = extensionHarness();
  const ctx = {
    cwd,
    hasUI: false,
    ui: { setStatus() {}, notify() {} },
    sessionManager: { getSessionId: () => "session-07", getLeafId: () => "turn-007" },
  };

  const compactEvent = {
    type: "session_before_compact",
    reason: "manual" as const,
    willRetry: false,
    signal: new AbortController().signal,
    preparation: { firstKeptEntryId: "turn-007", tokensBefore: 1000 } as never,
    branchEntries: [{ id: "turn-007", message: { role: "user" } }],
  };

  const compRes = events.get("session_before_compact")!(compactEvent, ctx);
  assert.equal(compRes, undefined, "must fall back to Mode B when receipt fails verification");
  const emergencyLog = entries.find(
    (e) => (e as { data?: { mode?: string; cause?: string } }).data?.cause === "unverified_receipt",
  );
  assert.ok(emergencyLog, "must record unverified_receipt emergency compaction entry");
});

test("P0-E (8/12): Uncovered entry ancestry strictly forces Mode B Emergency Safe Compaction", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-08-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-08" });

  pm.flushWorkingContext({
    content: validContextBody("Task", "Step"),
    covered_through_entry_id: "covered-turn-999",
    source_session_id: "session-08",
  });

  const { events, entries } = extensionHarness();
  const ctx = {
    cwd,
    hasUI: false,
    ui: { setStatus() {}, notify() {} },
    sessionManager: { getSessionId: () => "session-08", getLeafId: () => "l-08" },
  };

  // The branch entries do NOT contain "covered-turn-999" (ancestry cannot be proven!)
  const compactEvent = {
    type: "session_before_compact",
    reason: "threshold" as const,
    willRetry: false,
    signal: new AbortController().signal,
    preparation: { firstKeptEntryId: "entry-010", tokensBefore: 1000 } as never,
    branchEntries: [
      { id: "entry-001", type: "message", message: { role: "user" } },
      { id: "entry-002", type: "message", message: { role: "assistant" } },
    ],
  };

  const result = events.get("session_before_compact")!(compactEvent, ctx);
  // UNCONDITIONALLY Mode B (return undefined)
  assert.equal(result, undefined);
  const log = entries.find(
    (e) => (e as { data?: { cause?: string } }).data?.cause === "covered_entry_not_on_current_ancestry",
  );
  assert.ok(log, "must record ancestry failure log and refuse Mode A");
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

test("P0-E (10/12): External secret injection blocked on read boundary (safe persistent-state boundary)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-10-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-10" });

  // 1. Writer path blocks secret
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

  // 2. Flush a valid context
  pm.flushWorkingContext({
    content: validContextBody("Clean task", "Step"),
    covered_through_entry_id: "t-10-clean",
  });

  // 3. Hand-edit PROJECT_CONTEXT on disk to inject secret
  const ctxFile = projectContextPath(cwd);
  fs.appendFileSync(ctxFile, "\nAWS token=supersecretvalue123456\n");

  // 4. Read boundary must fail closed with POLICY_VIOLATION
  assert.throws(
    () => pm.readWorkingContext(),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "POLICY_VIOLATION");
      assert.match(err.message, /secret detected on read boundary/);
      return true;
    },
  );

  // 5. before_agent_start must catch and refuse injection
  const { events } = extensionHarness();
  const ctx = {
    cwd,
    hasUI: false,
    ui: { setStatus() {}, notify() {} },
    sessionManager: { getSessionId: () => "s-10", getLeafId: () => "l-10" },
  };
  const res = events.get("before_agent_start")!({ prompt: "start" }, ctx);
  assert.equal(res, undefined, "secret-bearing context must not be injected into agent context");
});

test("P0-E (11/12): Content exceeding 5KB hard budget blocked on write AND read boundary", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-11-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-11" });

  // 1. Writer path blocks >5KB
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

  // 2. Flush a valid context
  pm.flushWorkingContext({
    content: validContextBody("Clean task", "Step"),
    covered_through_entry_id: "t-11-clean",
  });

  // 3. Hand-edit PROJECT_CONTEXT on disk to exceed 5KB
  const ctxFile = projectContextPath(cwd);
  fs.appendFileSync(ctxFile, "x".repeat(5120));

  // 4. Read boundary must fail closed with BUDGET_EXCEEDED
  assert.throws(
    () => pm.readWorkingContext(),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "BUDGET_EXCEEDED");
      return true;
    },
  );
});

test("P0-E (12/12): Real concurrent writers lock contention on context.lock", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-12-"));
  const pm1 = new ProjectMemory(cwd);
  const pm2 = new ProjectMemory(cwd);
  pm1.init({ project_id: "adv-12" });

  // Writer 1 acquires the real context.lock file via O_EXCL
  const lock = contextLockPath(cwd);
  const fd = acquireLockFile(lock, { owner: "writer-1" });
  assert.ok(typeof fd === "number");

  // Writer 2 attempts to flush while Writer 1 holds the lock -> CONFLICT
  assert.throws(
    () =>
      pm2.flushWorkingContext({
        content: validContextBody("Concurrent task", "Step by writer 2"),
        covered_through_entry_id: "t-12-race",
      }),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "CONFLICT");
      assert.match(err.message, /another transaction holds context\.lock/);
      return true;
    },
  );

  // Writer 1 releases the lock
  releaseLockFile(lock, fd);

  // Writer 2 can now acquire the lock and flush cleanly
  const r2 = pm2.flushWorkingContext({
    content: validContextBody("Concurrent task", "Step by writer 2"),
    covered_through_entry_id: "t-12-race",
  });
  assert.equal(r2.status, "FLUSH_VERIFIED");
  assert.equal(r2.checkpoint_id, "CP-0001");
});
