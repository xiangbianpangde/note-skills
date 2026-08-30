# Changelog

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
- Capture Gate candidates are persisted durably under `.project-memory/pending/`; each candidate must be resolved by capture or acknowledge with `candidate_ids`.
- Retrieval is prompt-relevant: task-start retrieval ranks notes by the actual user prompt terms.
- Canonical conflict evidence in the canonical state file marks hits `needs_review` via a separate `review_status`; lifecycle statuses are untouched.
- Secret policy scans the full normalized note (trigger, relations, created_by, …), and manually edited notes are quarantined on read.

## 0.1.1 - 2026-08-29

- Require deterministic Capture/Promote receipts to bind the real `tool_call_id`; model narration alone is unverified.
- Require explicit Promote write mode: `append_block` only for a new canonical object, `replace_file` for approved changes to an existing definition.
- Clarify that concurrent Promote transactions to one target permit exactly one winner.

## 0.1.0 - 2026-08-29

- Initial release of the `project-memory` task skill (v0.1.0): task-start retrieval first, Mandatory Capture Gate at discussion-to-execution / task end / pre-compaction checkpoints, six semantic note types with capture-or-acknowledge-skip, retrieval treated as non-authoritative data, user-approved promote only, and end-of-task capture receipts.
- Explicit capability boundary: model-side capture is a behavioral contract; no claim of harness-guaranteed semantic detection.
- Detail split on demand: `references/note-types.md` (fields/statuses per type), `references/lifecycle.md` (gate, retrieval, triggers, promote, reconcile, cross-session resume), `references/security-and-authority.md` (authority ordering, sensitive-data policy, fail-closed, provenance, injection handling).
