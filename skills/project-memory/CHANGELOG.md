# Changelog

## 0.1.1 - 2026-08-29

- Require deterministic Capture/Promote receipts to bind the real `tool_call_id`; model narration alone is unverified.
- Require explicit Promote write mode: `append_block` only for a new canonical object, `replace_file` for approved changes to an existing definition.
- Clarify that concurrent Promote transactions to one target permit exactly one winner.

## 0.1.0 - 2026-08-29

- Initial release of the `project-memory` task skill (v0.1.0): task-start retrieval first, Mandatory Capture Gate at discussion-to-execution / task end / pre-compaction checkpoints, six semantic note types with capture-or-acknowledge-skip, retrieval treated as non-authoritative data, user-approved promote only, and end-of-task capture receipts.
- Explicit capability boundary: model-side capture is a behavioral contract; no claim of harness-guaranteed semantic detection.
- Detail split on demand: `references/note-types.md` (fields/statuses per type), `references/lifecycle.md` (gate, retrieval, triggers, promote, reconcile, cross-session resume), `references/security-and-authority.md` (authority ordering, sensitive-data policy, fail-closed, provenance, injection handling).
