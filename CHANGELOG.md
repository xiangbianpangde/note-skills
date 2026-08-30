# Changelog

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
