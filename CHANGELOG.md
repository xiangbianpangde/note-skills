# Changelog

## 0.1.1 - 2026-08-29

- Fail closed on uninitialized reads, non-memory authority, symlink escapes, and backlink hijacking.
- Serialize concurrent Promote transactions per canonical target and add stale-lock reconciliation.
- Bind extension receipts to real tool call IDs and expose explicit append-versus-replace Promote modes.
- Expand boundary and four-process scenario coverage.

## 0.1.0 - 2026-08-29

- Add the initial filesystem-first Project Memory core.
- Add the Pi extension bridge and model-facing `project-memory` skill.
- Add mandatory capture-gate reminders, trigger-based retrieval, promotion, reconciliation, and tests.
