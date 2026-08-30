import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const coreUrl = new URL("../src/index.ts", import.meta.url).href;

async function session(cwd: string, body: string, env: Record<string, string> = {}) {
  const script = `import { ProjectMemory } from ${JSON.stringify(coreUrl)};\n${body}`;
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    { cwd: projectRoot, env: { ...process.env, PM_CWD: cwd, ...env } },
  );
  assert.equal(stderr, "");
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

test("four fresh processes preserve P1 rationale, trigger it after P0, promote it, and retain history", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-scenario-"));
  fs.writeFileSync(path.join(cwd, "state.yaml"), "milestones:\n  P0: in_progress\n");
  fs.writeFileSync(path.join(cwd, "BACKLOG.md"), "# Canonical Backlog\n");

  const a = await session(
    cwd,
    `
const pm = new ProjectMemory(process.env.PM_CWD);
pm.init({ project_id: 'scenario', canonical_state_file: 'state.yaml' });
const deferred = pm.capture({
  type: 'deferred_work',
  title: 'Multi-agent scheduling',
  summary: 'Reconsider multi-agent scheduling after P0',
  rationale: 'P0 must validate the single-agent loop before orchestration adds permission and concurrency complexity.',
  priority: 'P1',
  source_refs: [{kind:'conversation',ref:'pi-session://A',turn_id:'turn-p0'}],
  trigger: {mode:'all',conditions:[{kind:'milestone',key:'P0',operator:'equals',value:'complete'}]},
  next_action: 'Review concurrency, permission, and single-agent bottleneck evidence.'
});
const decision = pm.capture({
  type: 'decision', title: 'Use filesystem-first memory',
  summary: 'Keep Markdown notes primary and indexes derived.',
  rationale: 'Git reviewability and index rebuildability are required.',
  source_refs: [{kind:'conversation',ref:'pi-session://A',turn_id:'turn-decision'}],
  next_action: 'Promote to architecture only after explicit approval.'
});
process.stdout.write(JSON.stringify({deferredId:deferred.id,decisionId:decision.id}));
`,
  );
  const deferredId = String(a.deferredId);

  const b = await session(
    cwd,
    `
const pm = new ProjectMemory(process.env.PM_CWD);
const restored = pm.taskStartRetrieval({state:pm.loadCanonicalState(),limit:10});
const hit = restored.active.find(x=>x.note.id===process.env.PM_ID);
process.stdout.write(JSON.stringify({
  due: restored.due.map(x=>x.id),
  found: !!hit,
  rationale: hit?.note.rationale,
  authority: hit?.note.authority,
  source: hit?.note.source_refs[0]?.ref
}));
`,
    { PM_ID: deferredId },
  );
  assert.deepEqual(b.due, []);
  assert.equal(b.found, true);
  assert.match(String(b.rationale), /single-agent loop/);
  assert.equal(b.authority, "memory");
  assert.equal(b.source, "pi-session://A");

  fs.writeFileSync(path.join(cwd, "state.yaml"), "milestones:\n  P0: complete\n");
  const c = await session(
    cwd,
    `
const pm = new ProjectMemory(process.env.PM_CWD);
const due = pm.taskStartRetrieval({state:pm.loadCanonicalState(),limit:10}).due;
const request = {
  promotion_id:'scenario-promote-1',
  target:{kind:'backlog',path:'BACKLOG.md'},
  insertBlock:'## Multi-agent scheduling\\n\\nReview after P0; source Project Memory '+process.env.PM_ID+'.'
};
const plan = pm.planPromotion(process.env.PM_ID, request);
const approval = pm.recordPromotionApproval(plan, {kind:'human',id:'scenario-user',channel:'test'});
const promoted = pm.promote(process.env.PM_ID, {...request, approval_ref:approval.approval_ref});
process.stdout.write(JSON.stringify({due:due.map(x=>x.id),promotion:promoted.status}));
`,
    { PM_ID: deferredId },
  );
  assert.deepEqual(c.due, [deferredId]);
  assert.equal(c.promotion, "promoted");

  const d = await session(
    cwd,
    `
const pm = new ProjectMemory(process.env.PM_CWD);
const active = pm.search({type:'deferred_work'});
const history = pm.read(process.env.PM_ID);
const canonical = (await import('node:fs')).readFileSync(process.env.PM_CWD+'/BACKLOG.md','utf8');
process.stdout.write(JSON.stringify({
  active:active.length,
  status:history?.note.status,
  target:history?.note.promotion.target?.path,
  source:history?.note.source_refs[0]?.ref,
  backlink:canonical.includes('project-memory-derived-from: '+process.env.PM_ID),
  errors:pm.reconcile().issues.filter(x=>x.severity==='error').length
}));
`,
    { PM_ID: deferredId },
  );
  assert.equal(d.active, 0);
  assert.equal(d.status, "promoted");
  assert.equal(d.target, "BACKLOG.md");
  assert.equal(d.source, "pi-session://A");
  assert.equal(d.backlink, true);
  assert.equal(d.errors, 0);
});
