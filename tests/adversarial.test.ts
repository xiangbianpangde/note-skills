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
import { validateProjectContext } from "../src/storage.ts";
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
/* P0-E: 12 Hardened Adversarial Failure Mode Tests (Sol Sign-off)    */
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

  // Attack 1: Attempting to silently wipe negative constraints with various casing, placeholders, and absence-phrase synonyms
  const trivialAttempts = [
    "- None specified",
    "- none specified",
    "- None Specified",
    "- NONE SPECIFIED",
    "- Nothing specified",
    "- Constraints: none",
    "- N.A.",
    "- n/a",
    "- 无任何限制",
    "- 暂无约束",
    "- 无特别约束",
    // Sol audit counter-examples:
    "- No constraints specified",
    "- No additional constraints",
    "- There are no special constraints",
    "- There aren't any constraints",
    "- No restrictions currently",
    "- 当前无约束",
    "- 暂时没有约束",
    "- 目前没有任何限制",
  ];

  for (const trivial of trivialAttempts) {
    assert.throws(
      () =>
        pm.flushWorkingContext({
          content: validContextBody("Refactor storage", "Implement write locks", trivial),
          covered_through_entry_id: "turn-002b",
          base_context_sha256: r1.new_context_sha256,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ProjectMemoryError);
        assert.equal(err.code, "POLICY_VIOLATION");
        assert.match(err.message, /silent deletion or relaxation of negative constraints is forbidden/);
        return true;
      },
      `Trivial negative constraint wipeout attempt "${trivial}" must be rejected`,
    );
  }

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

  // Attack 2: Real negative constraints with "Not ...", "No ...", "无 ...", "没有 ..." MUST NOT be misclassified as non-substantive
  const realConstraints = [
    "- Not allowed to deploy before security audit",
    "- No direct writes to production db",
    "- 无管理员批准不得部署",
    "- 没有测试覆盖的代码禁止合并",
  ];

  let accumulatedConstraints = "- Do not deploy before security audit";
  let currentSha = cp2!.sha256;
  for (let i = 0; i < realConstraints.length; i++) {
    const realConstraint = realConstraints[i];
    accumulatedConstraints += `\n${realConstraint}`;
    // Updating while preserving previous constraints and adding a new real constraint must succeed
    const res = pm.flushWorkingContext({
      content: validContextBody("Refactor storage", "Implement write locks", accumulatedConstraints),
      covered_through_entry_id: `turn-002-real-${i}`,
      base_context_sha256: currentSha,
    });
    currentSha = res.new_context_sha256;

    // Verify it is indeed recognized as substantive
    const read = pm.readWorkingContext();
    assert.ok(read);
    assert.match(read.body, new RegExp(realConstraint.replace(/^-\s*/, "")));

    // Attempting to wipe these real constraints with "- none" must throw POLICY_VIOLATION
    assert.throws(
      () =>
        pm.flushWorkingContext({
          content: validContextBody("Refactor storage", "Implement write locks", "- none"),
          covered_through_entry_id: `turn-002-wipe-${i}`,
          base_context_sha256: currentSha,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ProjectMemoryError);
        assert.equal(err.code, "POLICY_VIOLATION");
        assert.match(err.message, /silent deletion or relaxation of negative constraints is forbidden/);
        return true;
      },
      `Attempt to wipe real constraints with "- none" must be rejected`,
    );
  }

  // Attack 3: Substring-presence and inline strikethrough semantic bypass attempts must be rejected (Sol audit P1-NEGATIVE-WIPEOUT-A)
  // Even though the old constraint string appears in the text, it is not an active constraint.
  const substringBypassAttempts = [
    "- This constraint is NO LONGER ACTIVE: Do not deploy before security audit",
    "- Historical/removed constraint: Do not deploy before security audit",
    "- ~~Do not deploy before security audit~~",
    "- Do not deploy ~~before security audit~~",
    "- Ignore the following old rule: Do not deploy before security audit",
    "<!-- Do not deploy before security audit -->",
    "## Negative Constraints / Do Not Assume\n<!-- Do not deploy before security audit -->\n- None specified",
  ];

  for (const bypass of substringBypassAttempts) {
    assert.throws(
      () =>
        pm.flushWorkingContext({
          content: validContextBody("Refactor storage", "Implement write locks", bypass),
          covered_through_entry_id: "turn-002-bypass",
          base_context_sha256: currentSha,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ProjectMemoryError);
        assert.equal(err.code, "POLICY_VIOLATION");
        assert.match(err.message, /silent deletion or relaxation of negative constraints is forbidden/);
        return true;
      },
      `Substring bypass attempt "${bypass}" must be rejected`,
    );
  }

  // Behavior 3: Explicit, auditable relaxation authorization (Sol audit P1-NEGATIVE-WIPEOUT-B)
  // 3a: Trivial reason / long placeholder / gibberish is rejected
  const invalidReasons = [
    "n/a",
    "none none none none",
    "xxxxxxxxxxxxxxxxxxxx",
    "placeholder placeholder",
    "not valid reason at all",
    "dummy dummy dummy",
    "asdf qwer zxcvbnm",
    "xxxx policy qwer",
    "asdfg ghjkl zxcvb",
    "123456 789012 345678",
    "policy 123456 789012",
    "测试 占位 忽略 占位 测试 占位",
    "测试，占位，暂无，跳过，忽略",
    "测试测试测试测试测试测试",
    "占位符占位符占位符",
  ];

  for (const invalidReason of invalidReasons) {
    assert.throws(
      () =>
        pm.flushWorkingContext({
          content: validContextBody("Refactor storage", "Implement write locks", "- None specified"),
          covered_through_entry_id: "turn-002-relax-trivial",
          base_context_sha256: currentSha,
          relax_negative_constraints: { reason: invalidReason, approved_by: "alice" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof ProjectMemoryError);
        assert.equal(err.code, "POLICY_VIOLATION");
        return true;
      },
      `Trivial or placeholder relaxation reason "${invalidReason}" must be rejected`,
    );
  }

  // 3b: Substantive auditable reason is accepted and recorded in both receipt & metadata
  const relaxationReason = "Security audit successfully completed and signed off by lead architect";
  const relaxed = pm.flushWorkingContext({
    content: validContextBody("Refactor storage", "Implement write locks", "- None specified"),
    covered_through_entry_id: "turn-002-relax-approved",
    base_context_sha256: currentSha,
    relax_negative_constraints: {
      reason: relaxationReason,
      approved_by: "sec-lead-alice",
    },
  });
  assert.equal(relaxed.status, "FLUSH_VERIFIED");
  assert.ok(relaxed.negative_constraints_relaxation);
  assert.equal(relaxed.negative_constraints_relaxation.actor, "sec-lead-alice");
  assert.equal(relaxed.negative_constraints_relaxation.reason, relaxationReason);
  assert.ok(relaxed.negative_constraints_relaxation.removed_constraints.length > 0);
  assert.equal(relaxed.negative_constraints_relaxation.previous_context_sha256, currentSha);

  const cpRelaxed = pm.readWorkingContext();
  assert.ok(cpRelaxed);
  assert.match(cpRelaxed!.body, /None specified/);
  assert.ok(cpRelaxed!.metadata.negative_constraints_relaxation);
  assert.equal(
    cpRelaxed!.metadata.negative_constraints_relaxation.reason,
    relaxationReason,
  );
  assert.equal(
    cpRelaxed!.metadata.negative_constraints_relaxation.actor,
    "sec-lead-alice",
  );

  // Cross-verification in verifyFlushReceipt
  const verifiedReceipt = pm.verifyFlushReceipt(relaxed.checkpoint_id);
  assert.ok(verifiedReceipt);
  assert.deepEqual(
    verifiedReceipt?.negative_constraints_relaxation,
    relaxed.negative_constraints_relaxation,
  );

  // 3c: Schema strict closed validation for negative_constraints_relaxation (Sol audit P1-NEGATIVE-WIPEOUT-B)
  const schemaAttackAudits = [
    { ...relaxed.negative_constraints_relaxation, timestamp: 123 },
    { ...relaxed.negative_constraints_relaxation, timestamp: "2026-99-99T99:99:99Z" },
    { ...relaxed.negative_constraints_relaxation, timestamp: "2026-02-31T12:00:00Z" },
    { ...relaxed.negative_constraints_relaxation, timestamp: "2026-02-31T12:00:00+08:00" },
    { ...relaxed.negative_constraints_relaxation, timestamp: "2025-02-29T12:00:00+08:00" },
    { ...relaxed.negative_constraints_relaxation, timestamp: "2026-02-31T12:00:00-05:00" },
    { ...relaxed.negative_constraints_relaxation, timestamp: "2026-04-31T12:00:00+08:00" },
    { ...relaxed.negative_constraints_relaxation, actor: "" },
    { ...relaxed.negative_constraints_relaxation, actor: null },
    { ...relaxed.negative_constraints_relaxation, previous_context_sha256: "not-a-sha" },
    { ...relaxed.negative_constraints_relaxation, previous_context_sha256: "A".repeat(64) },
    { ...relaxed.negative_constraints_relaxation, removed_constraints: [123, null] },
    { ...relaxed.negative_constraints_relaxation, extra_forged_field: "injected" },
  ];

  for (const attackAudit of schemaAttackAudits) {
    assert.throws(
      () => {
        const invalidMeta = {
          ...cpRelaxed!.metadata,
          negative_constraints_relaxation: attackAudit,
        };
        // validateProjectContext must reject any structural or type flaw in relaxation audit
        validateProjectContext({
          metadata: invalidMeta as any,
          body: cpRelaxed!.body,
          raw: "mock",
        }, "adv-02");
      },
      (err: unknown) => {
        assert.ok(err instanceof ProjectMemoryError);
        assert.equal(err.code, "INVALID_INPUT");
        return true;
      },
      `Schema attack audit ${JSON.stringify(attackAudit)} must be rejected by validateProjectContext`,
    );
  }
});

test("P0-E (3/12): Canonical truth overrides working projection on conflict (INV-AUTH-02 arbitration)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-03-"));
  fs.writeFileSync(path.join(cwd, "state.yaml"), "milestones:\n  P0: in_progress\n");
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-03", canonical_state_file: "state.yaml" });

  // 1. Attempting to flush a working context that asserts P0 is complete contradicts canonical state -> CONFLICT
  const contradictionPhrases = [
    "milestone P0 is complete",
    "Milestone P0 has been completed and verified",
    "Completed milestone P0",
    "P0 has passed all acceptance criteria",
    "P0 is fully shipped",
    "P0 has been signed off",
    "P0 已验收通过",
    "P0 已经闭环",
    "已完成 P0",
    "P0 已完成",
  ];

  for (const phrase of contradictionPhrases) {
    assert.throws(
      () =>
        pm.flushWorkingContext({
          content: validContextBody("Complete milestone P0", phrase),
          covered_through_entry_id: "turn-003a",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ProjectMemoryError);
        assert.equal(err.code, "CONFLICT");
        assert.match(err.message, /working context contradicts canonical milestone "P0"/);
        return true;
      },
      `Contradiction phrase "${phrase}" must trigger CONFLICT`,
    );
  }

  // 2. Flush a valid context
  pm.flushWorkingContext({
    content: validContextBody("Implement P0 tasks", "Continue milestone P0 implementation"),
    covered_through_entry_id: "turn-003b",
  });

  // 3. Now simulate hand-editing PROJECT_CONTEXT on disk to contradict canonical state.yaml
  const ctxFile = projectContextPath(cwd);
  const currentText = fs.readFileSync(ctxFile, "utf8");
  fs.writeFileSync(ctxFile, currentText.replace("Continue milestone P0 implementation", "milestone P0 is completed and verified"));

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

  // 5. Test Chinese milestone key (e.g. 阶段一)
  const cwdZh = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-03-zh-"));
  fs.writeFileSync(path.join(cwdZh, "state.yaml"), "milestones:\n  阶段一: in_progress\n");
  const pmZh = new ProjectMemory(cwdZh);
  pmZh.init({ project_id: "adv-03-zh", canonical_state_file: "state.yaml" });

  assert.throws(
    () =>
      pmZh.flushWorkingContext({
        content: validContextBody("阶段一任务", "阶段一 已完成"),
        covered_through_entry_id: "turn-03-zh",
      }),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "CONFLICT");
      assert.match(err.message, /阶段一/);
      return true;
    },
    "Chinese milestone key with completed suffix must trigger CONFLICT",
  );
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

test("P0-E (5/12): Branch drift fail-closed (including Git worktree .git file): git branch auto-collected and operational body suppressed", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-05-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-05" });

  // Simulate real Git linked worktree layout with commondir & packed-refs:
  const commonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "common-git-dir-"));
  fs.writeFileSync(
    path.join(commonGitDir, "packed-refs"),
    "# pack-refs with: peeled fully-peeled sorted\n1122334455667788990011223344556677889900 refs/heads/main\n",
  );

  const worktreeGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-git-dir-"));
  fs.writeFileSync(path.join(worktreeGitDir, "commondir"), `${commonGitDir}\n`);
  fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/main\n");

  fs.writeFileSync(path.join(cwd, ".git"), `gitdir: ${worktreeGitDir}\n`);

  // Flush without passing git_branch -> service must automatically resolve linked worktree commondir and collect 'main'
  const receipt = pm.flushWorkingContext({
    content: validContextBody("Feature Secret", "Deploy feature secret to production"),
    covered_through_entry_id: "t-05",
  });
  assert.equal(receipt.git_branch, "main");
  assert.equal(receipt.git_head, "1122334455667788990011223344556677889900");

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

  // Switch branch in the worktree gitdir
  fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/release-v2\n");

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

  // 3. Syntactically valid frontmatter but invalid authority fails closed on read
  const invalidAuthority = [
    "---",
    "schema_version: 1",
    "project_id: adv-06",
    "authority: canonical",
    "context_revision: 1",
    "checkpoint_id: CP-0001",
    "source_session_id: s",
    "covered_through_entry_id: e",
    "base_context_sha256: ''",
    "generated_at: '2026-09-03T10:00:00.000Z'",
    "---",
    validContextBody(),
  ].join("\n");
  fs.writeFileSync(projectContextPath(cwd), invalidAuthority);

  assert.throws(
    () => pm.readWorkingContext(),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "POLICY_VIOLATION");
      assert.match(err.message, /authority must be "working_projection"/);
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
    git_branch: "main",
  });
  assert.equal(receipt.status, "FLUSH_VERIFIED");

  // Attack 1: tamper receipt JSON's covered_through_entry_id while checkpoint bytes are untouched
  const rFile = flushReceiptPath(cwd, receipt.checkpoint_id);
  const rData = JSON.parse(fs.readFileSync(rFile, "utf8"));
  rData.covered_through_entry_id = "falsified-turn-id";
  fs.writeFileSync(rFile, JSON.stringify(rData, null, 2));

  // 1. verifyFlushReceipt must detect metadata tampering and return null
  assert.equal(pm.verifyFlushReceipt(receipt.checkpoint_id), null);

  // Attack 2: delete git_branch from receipt JSON while checkpoint has git_branch
  const rData2 = JSON.parse(fs.readFileSync(rFile, "utf8"));
  rData2.covered_through_entry_id = "turn-007"; // restore covered
  delete rData2.git_branch; // delete git_branch
  fs.writeFileSync(rFile, JSON.stringify(rData2, null, 2));
  assert.equal(pm.verifyFlushReceipt(receipt.checkpoint_id), null, "deleting git_branch from receipt must fail verification");

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

test("P0-E (8/12): Uncheckpointed toolResult eviction is strictly prevented (INV-COMPACT-01 Mode B fallback)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-08-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-08" });

  pm.flushWorkingContext({
    content: validContextBody("Task", "Step"),
    covered_through_entry_id: "turn-covered",
    source_session_id: "session-08",
  });

  const { events, entries } = extensionHarness();
  const ctx = {
    cwd,
    hasUI: false,
    ui: { setStatus() {}, notify() {} },
    sessionManager: { getSessionId: () => "session-08", getLeafId: () => "l-08" },
  };

  // Sol counterexample scenario:
  // turn-covered is an assistant toolCall.
  // Immediately following it is turn-toolResult (NOT covered by checkpoint!).
  // Then turn-user.
  // Previously, toolResult was jumped over and turn-user was kept, evicting the uncheckpointed toolResult!
  const sequenceWithUncheckpointedToolResult = {
    type: "session_before_compact",
    reason: "threshold" as const,
    willRetry: false,
    signal: new AbortController().signal,
    preparation: { firstKeptEntryId: "turn-user", tokensBefore: 1000 } as never,
    branchEntries: [
      { id: "turn-covered", type: "message", message: { role: "assistant" } },
      { id: "turn-toolResult", type: "message", message: { role: "toolResult" } }, // uncheckpointed!
      { id: "turn-user", type: "message", message: { role: "user" } },
    ],
  };

  const res1 = events.get("session_before_compact")!(sequenceWithUncheckpointedToolResult, ctx);
  // Must unconditionally fallback to Mode B!
  assert.equal(res1, undefined, "must refuse Mode A when uncheckpointed toolResult follows covered entry");
  const log1 = entries.find(
    (e) => (e as { data?: { cause?: string } }).data?.cause === "uncheckpointed_tool_result_after_covered_entry",
  );
  assert.ok(log1, "must record uncheckpointed_tool_result log");

  // Also verify: covered entry not present on current ancestry -> Mode B
  const missingAncestryEvent = {
    type: "session_before_compact",
    reason: "threshold" as const,
    willRetry: false,
    signal: new AbortController().signal,
    preparation: { firstKeptEntryId: "e-01", tokensBefore: 1000 } as never,
    branchEntries: [
      { id: "e-01", type: "message", message: { role: "user" } },
    ],
  };
  const res2 = events.get("session_before_compact")!(missingAncestryEvent, ctx);
  assert.equal(res2, undefined, "must refuse Mode A when covered entry missing from ancestry");
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

test("P0-E (10/12): External secret injection blocked on read boundary (both metadata and body)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "note-skills-adv-10-"));
  const pm = new ProjectMemory(cwd);
  pm.init({ project_id: "adv-10" });

  // 1. Flush a valid context
  pm.flushWorkingContext({
    content: validContextBody("Clean task", "Step"),
    covered_through_entry_id: "t-10-clean",
  });

  // 2. Hand-edit PROJECT_CONTEXT on disk to inject secret into a frontmatter comment (Sol P1-1 YAML comment scenario)
  const ctxFile = projectContextPath(cwd);
  const currentText = fs.readFileSync(ctxFile, "utf8");
  const commentSecretText = currentText.replace(
    "authority: working_projection",
    "authority: working_projection\n# secret token=supersecretvalue123456 in yaml comment",
  );
  fs.writeFileSync(ctxFile, commentSecretText);

  // 3. Read boundary must detect secret in raw bytes (even inside YAML comment) and fail closed!
  assert.throws(
    () => pm.readWorkingContext(),
    (err: unknown) => {
      assert.ok(err instanceof ProjectMemoryError);
      assert.equal(err.code, "POLICY_VIOLATION");
      assert.match(err.message, /secret detected on read boundary/);
      return true;
    },
  );

  // 4. before_agent_start must catch and refuse injection
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
