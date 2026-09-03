# Changelog

## 0.5.0 - 2026-09-03

- Major architecture pivot (P0-A & P0-B): L1 External Working Context (`PROJECT_CONTEXT.md`) + Transactional Flush (`/note-skills-flush`). 2PC commit, CAS conflict detection, 5KB budget, and checkpoint ledger. Peer dependency >=0.84.4. Tests: 73 -> 77.

## 0.4.5 - 2026-09-02

- Fix gate follow-up loop: runs triggered by `note-skills-capture-gate` are suppressed entirely from candidate scanning; assistant discourse planning or citing Note IDs (`PM-xxx`) is excluded. Regression test (72→73).

## 0.4.4 - 2026-09-02

- Retrieval injection opt-in: `retrieval_gate` config (first_ask default / enabled / disabled) + `/note-skills [on|off|status]` human command. First matching retrieval shows a decision prompt instead of silently injecting (field report: context pollution on broad queries). Regression tests (71→72).

## 0.4.3 - 2026-09-02

- Fix receipt echo-amplification loop (PM-DEF-0009): receipt-shaped text (cand_ id tables, skip reasons) is excluded from agent_end scanning; retrieval noise fix: broad generic terms (模型/使用/为什么...) no longer drive injection + minimum-match gate (≥2 distinct terms or strong single hit). Regression tests: receipt-echo zero candidates + broad-prompt no-injection (69→71).

## 0.4.2 - 2026-09-01

- Fix exponential capture-gate loop: content-identity dedup (type + excerpt sha256, stable across re-scans — candidate_id position drift was re-emitting same excerpts) + same-sentence multi-marker merge (one sentence = one candidate; distinct same-type sentences stay distinct). Regression tests: cross-round dedup + two-distinct-risks preserved (69 total).

## 0.4.1 - 2026-08-31

- Fix same-source capture gate infinite loop: gate-noise blocks (gate message, assistant acknowledge reports, meta-discourse) are excluded from agent_end signal detection; real semantics survive. Regression tests added (68 total).

## 0.4.0 - 2026-08-31

- Brand rename: package `pi-project-memory` → `note-skills`; tool `project_memory` → `note_skills`; data dir `.project-memory` → `.note-skills`; skill dir `skills/project-memory/` → `skills/note-skills/`. No security-model/invariant change from signed v0.3.6. Breaking API change (tool name, data dir) — package not yet published, no migration cost.

## 0.3.6 - 2026-08-31

- Skip-receipt Phase 3 verification now matches exact receipt content; merged-path settle fixed as a regression test.

## 0.3.5 - 2026-08-31

- Skip receipts are written project-safely and atomically with the envelope batch (no half-settle, no symlink escape).
- Threat model documented: pending authenticity/completeness is out of scope without an external anchor; version re-binding semantics added.

## 0.3.4 - 2026-08-31

- Candidate binding requires the exact candidate id (plus source identity and excerpt hash); same-block same-type occurrences are distinct.
- Skips require a durable receipt; hand-edited skip resolutions revert to unresolved.
- Reconcile surfaces untrusted pending resolutions (PENDING_RESOLUTION_INVALID).

## 0.3.3 - 2026-08-31

- Candidate settlement binds to the exact excerpt (source identity + excerpt hash); forged cross-settlement between same-type same-session candidates is reverted to unresolved.

## 0.3.2 - 2026-08-31

- Same-type durable units inside one message now each get a candidate (occurrence-level detection with offset-based spans).
- Forged pending resolutions are recoverable: a legitimate new resolution can overwrite an untrusted one.
- Secret regex guard also rejects quantified alternation overlap; malformed patterns and bad config types fail closed.

## 0.3.1 - 2026-08-31

- Pending resolutions are re-verified on read: forged/stale captured resolutions revert to unresolved (fail-closed).
- Per-block candidate detection: multiple distinct same-type durable units each get a candidate.
- Capture with candidate_ids merges candidate provenance automatically; leaf changes across the follow-up no longer break binding.
- Duplicate-ID groups drop out of the derived index on reconcile.
- Custom secret regex hardening covers `?`-nested quantifiers; malformed config types fail closed.

## 0.3.0 - 2026-08-30

- Candidate settlement is bound: capture with `candidate_ids` validates type match and that the note's source_refs reference the candidate provenance; unrelated or fabricated notes cannot settle a candidate.
- Removing the run-wide suppression: every `agent_end` scans for new signals; per-candidate dedup by type/markers/source leaf/excerpt hash only.
- Harness provenance (pi-session:// server+leaf) is always the authoritative first source; model-supplied sources are additional claims only.
- Direct `update()` to terminal status requires a `status_reason` and cannot reopen closed notes; use `close()`.
- Trusted scan quarantines stripped required review fields, tampered fingerprints, duplicate-ID groups, secret keys, and invalid custom secret regexes.

## 0.2.4 - 2026-08-30

- `objectId/version` (and target ref) are validated as strings and bound into approval + capability comparison; non-string values are rejected before any canonical write.
- The live capability stores a deep copy of the approved target, so later mutation of the plan object cannot change what gets promoted.

## 0.2.3 - 2026-08-30

- Promotion approval is bound to the exact approved content in-process and re-verified against the on-disk record and the live request before every canonical write; editing the approval after confirmation is refused.
- Trigger values follow the JSON Schema strictly (non-empty strings / string lists), including `status_equals`.
- Promoted targets must be regular files; directories and device nodes are quarantined as `PROMOTE_TARGET_INVALID`.
- Pending batch commits restore earlier files if a rename fails mid-commit.

## 0.2.2 - 2026-08-30

- Promotion approval is now a process-local single-use capability, not just a JSON file: only a live Pi UI confirmation in the same process can mint a consumable approval_ref.
- Promotion plans are validated against the real project root (target path must be project-relative, non-symlink, existing) before approval record persistence.
- `promotion.backlink` / `backlink_verified` / `promoted_at` follow the JSON Schema; forged values are quarantined.

## 0.2.1 - 2026-08-30

- Promote approval is pinned to the live Pi UI channel (`pi-session://` principal); ad-hoc approval minting is rejected.
- Pending candidates must be fully resolvable before capture writes a note; resolution of a mixed candidate set is atomic.
- Retrieval only applies canonical-conflict `needs_review` when the evidence matches the current note revision.

## 0.2.0 - 2026-08-30

- Promote now requires a content-bound single-use approval: the extension displays the exact target bytes and hashes in a Pi UI confirmation before minting an `approval_ref`; the model cannot self-approve.
- Capture Gate candidates are persisted durably under `.note-skills/pending/`; each candidate must be resolved by capture or acknowledge with `candidate_ids`.
- Retrieval is prompt-relevant: task-start retrieval ranks notes by the actual user prompt terms.
- Canonical conflict evidence in the canonical state file marks hits `needs_review` via a separate `review_status`; lifecycle statuses are untouched.
- Secret policy scans the full normalized note (trigger, relations, created_by, …), and manually edited notes are quarantined on read.

## 0.1.1 - 2026-08-29

- Require deterministic Capture/Promote receipts to bind the real `tool_call_id`; model narration alone is unverified.
- Require explicit Promote write mode: `append_block` only for a new canonical object, `replace_file` for approved changes to an existing definition.
- Clarify that concurrent Promote transactions to one target permit exactly one winner.

## 0.1.0 - 2026-08-29

- Initial release of the `note-skills` task skill (v0.1.0): task-start retrieval first, Mandatory Capture Gate at discussion-to-execution / task end / pre-compaction checkpoints, six semantic note types with capture-or-acknowledge-skip, retrieval treated as non-authoritative data, user-approved promote only, and end-of-task capture receipts.
- Explicit capability boundary: model-side capture is a behavioral contract; no claim of harness-guaranteed semantic detection.
- Detail split on demand: `references/note-types.md` (fields/statuses per type), `references/lifecycle.md` (gate, retrieval, triggers, promote, reconcile, cross-session resume), `references/security-and-authority.md` (authority ordering, sensitive-data policy, fail-closed, provenance, injection handling).
