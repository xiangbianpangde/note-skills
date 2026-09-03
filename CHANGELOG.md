# Changelog

## 0.5.0 - 2026-09-03

- **v0.5.0 Major Architecture Pivot (P0-A, P0-B, P0-C, P0-D & P0-E complete)**: From long-term memory archive alone to a 2-Layer Working Memory & Context Offload system.
  - **P0-A Contract & Peer Dependency**:
    - Peer dependency updated: `@earendil-works/pi-coding-agent >=0.84.4`.
    - Formally established Two-Dimensional Authority Model: `PROJECT_CONTEXT.md` carries `authority: working_projection` (non-authoritative state projection, canonical truth overrides).
  - **P0-B Transactional Flush & Working Context**:
    - L1 Working Context: `PROJECT_CONTEXT.md` maintained at project root, bounded to 5KB hard cap with required sections (`## Current Objective`, `## Next Action`, `## Negative Constraints / Do Not Assume`).
    - Two-Phase Commit Flush: acquires `context.lock`, checks CAS (`base_context_sha256`), writes durable snapshot `.note-skills/checkpoints/CP-xxxx.md`, updates root `PROJECT_CONTEXT.md`, reads back & verifies hash, and emits verified `FlushReceipt`.
    - Core APIs: `flushWorkingContext()`, `readWorkingContext()`, `verifyFlushReceipt()`.
    - Extension integrations: tool actions `flush` & `read_context`, command `/note-skills-flush`.
  - **P0-C Safe Aggressive Compaction & Dual-Mode Compaction**:
    - Extension command `/note-skills-flush-compact` and tool action `flush_compact`: flushes working context and immediately triggers active compaction via Pi's `ctx.compact()`.
    - Mode A (Verified Pointer Compaction): when a verified checkpoint exists and covers the discarded frontier, replaces bloated history with minimal <100 token pointer summary and aggressively cuts `firstKeptEntryId` directly after the checkpointed boundary.
    - Mode B (Emergency Safe Compaction): when uncheckpointed, missing context, or mid-run token overflow occurs, falls back to native structured compaction and logs `EMERGENCY_UNFLUSHED_COMPACTION` — strictly obeying invariant INV-COMPACT-01 (*Never evict uncheckpointed state*).
    - Lifecycle tracking: `session_compact` resets compaction block counter; `session_compact_failed` warns on unexpected failure.
  - **P0-D Fresh-Session Reconstruction & Context Independence Benchmark**:
    - `before_agent_start`: automatically detects and injects `PROJECT_CONTEXT.md` wrapped in a non-authoritative security envelope (`authority: working_projection`) explicitly stating that canonical files override and no permissions are elevated.
    - Git Branch Staleness Guard: compares checkpoint's `git_branch` with live repository branch; warns `CONTEXT_STALE` on mismatch to prevent cross-branch context contamination (§6.2).
    - Context Independence Test: multi-process automated benchmark in `tests/scenario.test.ts` proving a fresh blank session with zero conversation history continues tasks seamlessly and preserves negative constraints.
  - **P0-E 12-Failure-Mode Adversarial Test Suite**:
    - Dedicated `tests/adversarial.test.ts` covering all 12 adversarial scenarios requested by Sol: (1) ordinary resume, (2) negative constraint retention, (3) canonical conflict precedence (INV-AUTH-02), (4) external human edit CAS defense, (5) branch drift detection, (6) corrupted context fail-closed, (7) corrupted checkpoint fail-closed, (8) mid-run overflow Mode B fallback, (9) unresolved candidate compaction blocking, (10) secret pattern blocking (POLICY_VIOLATION), (11) 5KB budget exceeding (BUDGET_EXCEEDED), (12) concurrent writers lock serialization.
  - Regression tests: 73 -> 92 tests (100% passing).

## 0.4.5 - 2026-09-02

- **Completely eliminate gate follow-up loop trapping the user**:
  - `agent_end` now checks if the low-level run was dispatched to handle the
    gate (`customType: "note-skills-capture-gate"` present in `event.messages`).
    Gate follow-up runs are dedicated to candidate resolution; any assistant
    text, thinking, planning, or tool invocations in that run are gate-handling
    processing and are suppressed entirely from capture scanning. This stops the
    infinite automated follow-up loop (`triggerTurn: true` -> assistant ->
    `agent_end` -> followUp -> assistant -> ...) where users were forced to
    repeatedly click abort/pause to send messages.
  - Enhanced `isGateMetaDiscourse` for assistant messages in all runs: suppresses
    any discourse mentioning existing Note IDs (`PM-DEF-xxxx`, `PM-RSK-xxxx`),
    tool names (`note_skills`), gate planning phrases ("先处理本轮...条候选",
    "区分...风险与...回声", "Planning audit candidate", "Inspecting gate candidate",
    "纯过程旁白"), and acknowledgment summaries.
- Regression tests: gate follow-up run produces zero candidates + meta-discourse
  planning suppressed (72 → 73).

## 0.4.4 - 2026-09-02

- **Retrieval injection is now opt-in (first-use gate)**: before_agent_start
  no longer injects memory notes silently. New config field `retrieval_gate`
  (`first_ask` default / `enabled` / `disabled`):
  - `first_ask`: the first matching retrieval displays a decision prompt
    (customType `note-skills-retrieval-gate`) telling the model/user to run
    `/note-skills on` to enable, or ignore to stay off — no pollution before
    the user asked for memory (field report).
  - `enabled`: always inject (previous behavior).
  - `disabled`: never inject.
  - Human control: new `/note-skills [on|off|status]` command reads/writes the
    gate; `status` shows current state.
- Breaking-ish behavior change (opt-in by default); existing projects keep
  `first_ask` (fail closed). Regression tests: gate off/on/status + first_ask
  decision prompt (71 → 72).

## 0.4.3 - 2026-09-02

- **Fix receipt echo-amplification loop (PM-DEF-0009)**: the model's detailed
  capture/acknowledge receipt (candidate-id tables, skip reasons, type lists)
  was re-scanned by the next agent_end and produced up to 8 candidates from the
  SAME receipt text via different type rules — zero new semantics. Two new
  gate-noise rules in isGateMetaDiscourse: (1b) any block containing
  `cand_<32hex>` candidate-id hashes is treated as receipt/echo (even when
  long — the previous ≤40-word + ≥2-vocab heuristic missed long tables);
  (1c) candidate-id line density (≥2 cand_ lines) also marks meta. Real
  semantics without candidate-id hashes are preserved.
- **Fix retrieval noise injection** (field report: '为什么我的 pi coding agent
  的 b-ai 的模型无法使用？' matched 6 unrelated notes via broad terms
  模型/使用 and polluted the context): (1) GENERIC_TERM_PARTS + expanded
  TASK_STOP_WORDS — broad/generic terms never survive the bigram split and
  cannot drive injection; (2) minimum-match gate in taskStartRetrieval — a
  note is injected only when ≥2 distinct prompt terms match, or a single
  high-weight title/next_action hit reaches a strong score. Specific-term
  retrieval (e.g. 'database migration rollback') is unaffected.
- Regression tests: receipt-shaped echo (zero candidates) + broad-prompt
  no-injection (69 → 71).

## 0.4.2 - 2026-09-01

## 0.4.2 - 2026-09-01

- **Fix exponential capture-gate loop (reported from researchctl, 182 envelopes / 56 unresolved)**: two root causes in the agent_end signal pipeline:
  1. **Cross-round content dedup**: `candidate_id` was derived from `spanKey` (blockIndex + offset + contentHash), so the same source text re-scanned in a later agent_end sits at a different block index → new candidate_id → the old position-based dedup key never matched → every re-scan re-emitted the same excerpt as a "fresh" candidate (same excerpt persisted up to ~9 times). Dedup key is now CONTENT identity (type + `source_excerpt_sha256`), stable across re-scans regardless of window position.
  2. **Same-sentence multi-marker merge**: one sentence can hit multiple markers ("P1-B Contract 已确认冻结（rev11），后续需要跟进 P1-C" hits 后续 / P1 / P1) that describe the SAME durable unit → 3 candidates for one unit. New `sentenceAround()` merge key (blockIndex + type + sentence slice) collapses same-sentence hits into one candidate while preserving DISTINCT same-type units in different sentences (风险 A + 风险 B still yield two candidates).
- Regression tests: cross-round content dedup (same excerpt re-scanned → 1) + existing same-block two-distinct-risks preserved (68 → 69).

## 0.4.1 - 2026-08-31

- **Fix same-source capture gate infinite loop** (reported from researchctl project): the agent_end capture scan now suppresses gate-noise blocks before signal detection: (1) the `[Note Skills Mandatory Capture Gate]` message itself; (2) assistant replies that only report handling the gate ("已 acknowledge…待决项清零", skip/receipt bookkeeping) — these self-referential meta-discourses previously re-captured themselves as new candidates, consuming ~200 candidates in the field; (3) short blocks dominated by gate vocabulary. Real semantics inside a gate-handling reply (e.g. "合同冻结是实现完成后的里程碑") are preserved. Same-source loop regression tests: strict zero-candidate meta-reply + real-semantics-survive (68 total).

## 0.4.0 - 2026-08-31

- **Rebrand to Note Skills** (breaking):
  - npm package: `pi-project-memory` → `note-skills`
  - tool name: `project_memory` → `note_skills` (TOOL_NAME + all tool-call docs)
  - data directory: `.project-memory` → `.note-skills` (MEMORY_ROOT + all derived paths)
  - user commands: `project-memory-init`/`project-memory-reconcile` → `note-skills-init`/`note-skills-reconcile`
  - Pi entry/customType namespaces: `note-skills-*` (receipt/retrieval/capture-gate)
  - skill/extension/design-doc paths: `skills/project-memory/` → `skills/note-skills/`, `extensions/project-memory.ts` → `extensions/note-skills.ts`, `Project_Memory_Design.md` → `Note_Skills_Design.md`
  - canonical backlink marker: `project-memory-derived-from:` → `note-skills-derived-from:`
  - all brand text updated (LICENSE/README/CHANGELOG, internal TS symbol names kept as-is)
- No behavior/invariant change — the signed v0.3.6 security model (triple binding, trusted scan, threat model §7) is unchanged. Breaking API surface is the rename itself; package was not yet published (npm 404), so no migration cost. Old `.project-memory/` is NOT read by v0.4.0; projects that ran v0.3.x would need explicit re-capture (see §7.3 re-binding semantics).

## 0.3.6 - 2026-08-31

- Post-signing maintenance (from auditor suggestions): Phase 3 receipt verification upgraded from non-null readback to EXACT skipReceiptExists matching (envelope_id + candidate_id + tool_call_id + reason hash + resolved_at); merged+resolved captureAndResolvePending scenario fixed as a regression test (66 total). No signature-impacting logic change: same invariants as signed 14a6923 (v0.3.5).

## 0.3.5 - 2026-08-31

- P1 (audit #7): skip-receipt writes are project-contained (rejectSymlinkComponents before any write), atomic (writeFileAtomic + readback), and batched WITH the envelope mutations (one staged batch, unified rename) — a receipt write failure can no longer half-settle a multi-candidate skip or land a receipt outside the project via a planted symlink.
- Threat model clarified (security-and-authority.md §7.2): pending JSON authenticity/completeness is explicitly NOT claimed (excludes candidate deletion/replacement/replay/reuse without external anchor); the design guarantees structure + cross-binding verification only.
- §7.3 migration semantics: v0.3.3→v0.3.4 re-binding (no legacy fallback; re-capture/acknowledge required).
- Tests: 64 -> 65 (symlink receipts escape, dir target, no half-settle batch).

## 0.3.4 - 2026-08-31

- P1 (audit #6): candidate-to-Note binding now requires candidate_id in addition to source identity + excerpt hash (`candidateBindsToNote`). Same-short-block same-type occurrences now carry distinct candidate identities, so resolution-only forgery of B pointing at A's note reverts B to unresolved. `captureAndResolvePending` merges candidate_id + excerpt into the Note source_refs; `mergeInto` dedupes on the full identity (source + excerpt + candidate id) so the normal merged path can settle candidates too.
- P2: `status:skipped` resolutions are only trusted with a durable skip-receipt written by `resolvePendingCapture` (envelope_id + candidate_id + tool_call_id + reason hash + resolved_at). Hand-edited skip without a matching receipt reverts to unresolved.
- P2: reconcile now reports untrusted persisted resolutions as `PENDING_RESOLUTION_INVALID` (same trusted verification as the Gate) so forgery is surfaced.
- Tests: 62 -> 64 (same-block same-excerpt cross-settlement, forged skip w/o receipt).

## 0.3.3 - 2026-08-31

- P1 (fourth-audit cross-settlement): candidate-to-Note binding now requires BOTH the source identity AND the candidate's excerpt hash (`candidateBindsToNote`). Same-session same-type candidates can no longer be cross-settled by pointing a forged resolution at another candidate's Note. `captureAndResolvePending()` merges each candidate's `excerpt_sha256` into the Note source_refs so atomic binds satisfy the full identity; `pendingCaptureCandidates()` and `resolvePendingCapture()` re-verify with the same rule.
- Tests: 61 -> 62 (cross-settlement forgery regression).

## 0.3.2 - 2026-08-31

- P1 (final signing): occurrence-level signal detection — `detectCaptureSignalsInBlocks()` now emits one signal per (type, marker, offset) occurrence, so two DISTINCT same-type durable units inside ONE message block (e.g. transition risk + plugin secret risk, both marked "风险") produce two candidates. Envelope identity binds block index + marker offset + block content hash; dedupe keys use candidate identity (not excerpt-only), so same-marker occurrences in short blocks stay distinct while re-scanning the same span stays idempotent.
- P2: forged/untrusted pending resolutions are now RECOVERABLE — `resolvePendingCapture()` re-verifies a persisted resolution under the same trusted rules; invalid captured/skipped resolutions fall through so a legitimate new resolution can overwrite them instead of deadlocking the candidate with CONFLICT.
- P2: custom secret regex guard extended to quantified alternation overlap `(a|aa)+$`, `(ab|a)+` (fixed literal-escape bug where the alternation pattern was never matched).
- Tests: 57 -> 61 (same-block same-marker candidates, A-then-B same leaf, regex alternation, review_reason-only deletion, race/precheck no-side-effect).

## 0.3.1 - 2026-08-31

- P1: on-disk pending resolutions are no longer trusted by themselves. `pendingCaptureCandidates()` re-verifies every `captured` resolution against the real Note (exists, same type, provenance referenced); forged/stale resolutions revert the candidate to unresolved (fail-closed against hand-edited pending JSON). `skipped` without a reason also reverts.
- P1: per-block signal detection. `detectCaptureSignalsInBlocks()` runs per message block; two distinct same-type durable units yield two candidates instead of one aggregated type signal. Envelope identity is bound to the source span (block index + hash), so a later distinct unit gets a new envelope while re-scanning the same span stays idempotent.
- P2: `captureAndResolvePending()` merges each candidate's verified source_ref into the Note BEFORE capture — binding does not depend on the tool-call leaf matching the agent_end leaf (Pi leaf may advance across the follow-up).
- P2: duplicate-ID groups are removed from reconcile's local notes before index drift/rebuild, so byte-identical duplicates no longer hide drift and the ambiguous id is dropped from the derived index.
- P2: custom secret pattern hardening extended: `?`-based nested quantifiers (`(a?)+$`) and `{m,n}` forms rejected; `extra_secret_patterns` present but not a string[] now throws `INCONSISTENT` instead of silently disabling the policy.
- Tests: 51 -> 57 (forged pending resolution, byte-identical duplicate index, regex variants + config type, per-block candidates, leaf-change binding, race/no-side-effect pre-check).

## 0.3.0 - 2026-08-30

- P1: Mandatory Capture Gate binding closed. New Core primitive `captureAndResolvePending(candidateIds, input, toolCallId)` creates/merges the Note and binds the candidate in one flow with type + provenance verification; `resolvePendingCapture()` now rejects nonexistent notes, wrong-type notes, and notes whose `source_refs` do not reference the candidate provenance. A risk candidate can no longer be settled by an unrelated idea note or a fabricated note ID.
- P1: removed the run-wide `handledThisRun` suppression. `agent_end` always scans; duplicates are deduped per-candidate by (type, markers, source leaf, excerpt hash). Processing one signal no longer hides NEW signals later in the same run.
- P2: capture+resolution are now validated as one call (side effects reported explicitly: on resolution failure the committed note ID is returned in the error details instead of a plain failure).
- P2: harness provenance is authoritative and cannot be replaced: the real Pi session/leaf is always the first source_ref; model-supplied `source_ref/source_kind/source_turn_id` are appended only as additional claimed sources.
- P2: `update()` cannot enter a terminal status without a non-empty `status_reason` and cannot reopen a terminal note; only `close()`/`promote()` handle terminal transitions.
- P2: trusted scan now quarantines notes with stripped required review fields (no silent `clear` default), tampered fingerprints (recomputed as `fingerprintOf(type,title,summary)`), duplicate-ID groups, and secrets hidden in object keys.
- P2: custom secret patterns are validated at config load (parse errors, nested quantifiers / ReDoS, >512 chars fail closed with `INCONSISTENT`).
- Tests: 43 -> 51 (pending settlement binding, atomic bind, stripped-required, fingerprint tamper, duplicate ID, secret-in-key, terminal bypass, dangerous regex).

## 0.2.4 - 2026-08-30

- P2: `CanonicalTarget.objectId/version` are now validated as optional strings at every boundary — target resolution (`resolvePromotionTarget`), promotion plan validation, approval-record validation (`INCONSISTENT` for malformed disk records) — BEFORE any canonical write or approval record is created. Numeric values no longer reach the note write, so a malformed target cannot produce an unreadable note after a successful-looking write.
- P2: `objectId/version` (and `target.ref`) are now part of `assertApprovalBinding()` and `assertLiveCapabilityMatchesApproval()`, so approval binding and capability comparison cover the FULL target identity.
- P2: the live capability now holds a deep copy (`structuredClone`) of the approved target; mutating `plan.target` (or its nested fields) after minting no longer changes the approved bytes used at promote time.
- Tests: 41 -> 43 (numeric objectId/version at plan+approval boundaries, deep-copy immutability + full-target binding).

## 0.2.3 - 2026-08-30

- P1: the live approval capability now captures the EXACT approved content (project_id, note/promotion IDs, full target kind/ref/path, mode, before/after/payload hashes, planned_at, approved_at, approving principal). `promote()` verifies the capability against both the on-disk approval record (read again under lock) and the incoming request before any canonical write; editing the approval record after minting (approve-A-then-write-B) is refused, closing the approve/replay TOCTOU hole.
- P2: trigger condition values strictly follow the JSON Schema — `milestone 'in'` requires a non-empty string[] with non-empty items; `milestone equals/not_equals` and `dependency status_equals` require non-empty strings; `status_in` accepts a non-empty string or a non-empty string[]; invalid values now reject capture/update and quarantine hand-edited notes.
- P2: promoted targets must be regular files (not directories or device nodes); `scan()` and `reconcile()` now report `PROMOTE_TARGET_INVALID` and quarantine such notes instead of treating them as trusted.
- P2: `writeFileAtomicBatch` now restores already-committed files to their captured original content if a later rename fails (best-effort all-or-nothing); staging failures still leave every target untouched.
- Tests: 37 -> 41 (capability rebinding, trigger value schema, directory target, batch staging/rollback).

## 0.2.2 - 2026-08-30

- P1: `validatePromotionPlan()` now takes the project `cwd` and enforces project-relative, symlink-safe, existing-file checks on `target.path`; `recordPromotionApproval()` re-derives the safe relative target instead of trusting plan bytes, so a forged plan can no longer make it read outside the project.
- P1: approvals now require a process-local live capability in addition to the on-disk record. `recordPromotionApproval()` registers a single-use capability; `promote()` refuses any approval_ref (including `channel: pi-ui` hand-written records) that was not minted in this process, and consumes the capability on success. `validateApprovalRecord()` also enforces the live `pi-session://` principal.
- P2: `validateNote()` aligns `promotion.backlink` (in_file|link_file|null), `backlink_verified` (boolean) and `promoted_at` (ISO or null) with the JSON Schema; forged values quarantine the note at read.
- P2: pending resolution validates `note_id` format on capture resolutions (both on call and inside envelope validation) and commits via a batched temp-write-then-rename commit so a failure during staging leaves the store untouched.
- Tests: 34 -> 37 (forged plan, hand-crafted approval, forged backlink value).

## 0.2.1 - 2026-08-30

- Promotion metadata hardening: persisted `promotion.target.path` is statically checked (non-absolute, no `..` escape, never inside `.note-skills`) before any write, and dynamically re-validated (project-relative, symlink-safe, existing) by `scan()` and `reconcile()` before backlink reads.
- Runtime validation aligned with the JSON Schema for `created_by`, `source_refs` optional fields, promotion target structure, and nullable reason fields.
- Stale canonical-conflict evidence is no longer applied at retrieval: `search()` and the extension only promote `needs_review` when `note_sha256` matches the current revision.
- `resolvePendingCapture()` is now two-phase atomic: the entire candidate set is validated before any envelope is written, so a mixed valid/invalid request cannot half-succeed.
- `recordPromotionApproval()` pins the approval channel to `pi-ui` and requires a `pi-session://` principal id; ad-hoc Core callers cannot mint approvals outside the live Pi UI path.
- Extension capture pre-validates `candidate_ids` before writing the note, so an unresolvable candidate set fails before capture.
- Skill metadata version bumped to 0.2.1.

## 0.2.0 - 2026-08-30

- Trusted scan: `scan()` now validates every note's schema, project_id, and authority before returning it; invalid, foreign-project, and secret-bearing notes are quarantined.
- Recursive secret policy: `findSecretMatches()` traverses the full Note object (trigger, relations, created_by, etc.) and rejects secrets at any depth; `redactSecrets()` before persisting excerpts.
- Fingerprint-level concurrency lock: `capture()` acquires a deterministic fingerprint lock before the in-lock rescan, so concurrent processes with the same fingerprint cannot create duplicates.
- Per-note CAS write: `writeNoteFileCas()` enforces before-SHA-256 atomicity for every update and merge; `update()` and `mergeInto()` hold per-note locks.
- Content-bound promote approval: `planPromotion()` builds exact approved after-bytes; `recordPromotionApproval()` writes a single-use `PromotionApprovalRecord`; `promote()` consumes the record inside approval + note + target triple locks.
- Supersedes cycle fix: `superseded_by` is normalized to the same direction as `supersedes`; bidirectional metadata no longer produces a false `SUPERSES_CYCLE`.
- Durable pending capture: `PendingCaptureEnvelope` is written to `.note-skills/pending/` at agent_end; candidates are resolved individually via `capture` or `acknowledge` with candidate IDs.
- Task-prompt relevance: `taskStartRetrieval()` accepts a `text` parameter and ranks active notes by prompt-term relevance using weighted field scoring.
- Canonical conflict adapter: `canonical_conflicts` in the canonical state file produces `needs_review` hits without modifying the note's lifecycle status; `review_status` is a separate cross-cutting field.
- Schema: `review_status` and `review_reason` added to `Note`, `validateNote`, and `note.schema.json`.
- `package.json` `files` now includes `Note_Skills_Design.md`.

## 0.1.1 - 2026-08-29

- Fail closed on uninitialized reads, non-memory authority, symlink escapes, and backlink hijacking.
- Serialize concurrent Promote transactions per canonical target and add stale-lock reconciliation.
- Bind extension receipts to real tool call IDs and expose explicit append-versus-replace Promote modes.
- Expand boundary and four-process scenario coverage.

## 0.1.0 - 2026-08-29

- Add the initial filesystem-first Note Skills core.
- Add the Pi extension bridge and model-facing `note-skills` skill.
- Add mandatory capture-gate reminders, trigger-based retrieval, promotion, reconciliation, and tests.
