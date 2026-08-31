# Changelog

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

- Promotion metadata hardening: persisted `promotion.target.path` is statically checked (non-absolute, no `..` escape, never inside `.project-memory`) before any write, and dynamically re-validated (project-relative, symlink-safe, existing) by `scan()` and `reconcile()` before backlink reads.
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
- Durable pending capture: `PendingCaptureEnvelope` is written to `.project-memory/pending/` at agent_end; candidates are resolved individually via `capture` or `acknowledge` with candidate IDs.
- Task-prompt relevance: `taskStartRetrieval()` accepts a `text` parameter and ranks active notes by prompt-term relevance using weighted field scoring.
- Canonical conflict adapter: `canonical_conflicts` in the canonical state file produces `needs_review` hits without modifying the note's lifecycle status; `review_status` is a separate cross-cutting field.
- Schema: `review_status` and `review_reason` added to `Note`, `validateNote`, and `note.schema.json`.
- `package.json` `files` now includes `Project_Memory_Design.md`.

## 0.1.1 - 2026-08-29

- Fail closed on uninitialized reads, non-memory authority, symlink escapes, and backlink hijacking.
- Serialize concurrent Promote transactions per canonical target and add stale-lock reconciliation.
- Bind extension receipts to real tool call IDs and expose explicit append-versus-replace Promote modes.
- Expand boundary and four-process scenario coverage.

## 0.1.0 - 2026-08-29

- Add the initial filesystem-first Project Memory core.
- Add the Pi extension bridge and model-facing `project-memory` skill.
- Add mandatory capture-gate reminders, trigger-based retrieval, promotion, reconciliation, and tests.
