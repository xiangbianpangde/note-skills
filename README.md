# Pi Project Memory

A Pi package for continuity across fragmented, multi-session project work. It keeps deferred work, decisions, open questions, assumptions, risks, and ideas as searchable, non-canonical Markdown notes and reactivates them when a task or trusted project milestone makes them relevant.

The architecture baseline is documented in [`Project_Memory_Design.md`](Project_Memory_Design.md).

## Why a package, not only a prompt

The package separates responsibilities:

- `skills/project-memory/` teaches the model when and how to capture or retrieve semantic memory objects.
- `extensions/project-memory.ts` exposes the tool and maps Pi lifecycle events to capture/retrieval gates.
- `src/` enforces deterministic storage, validation, IDs, indexing, trigger evaluation, promotion, and reconciliation.
- `.project-memory/` is created inside each opted-in project; Markdown notes are primary data and JSON indexes are rebuildable.

Project Memory is not a Source of Truth. Current specifications, code, ADRs, issues, experiments, and accepted conclusions always take precedence.

## Existing implementations considered

- npm package search :: adapt :: `pi-hermes-memory` offers persistent memory, session search, secret scanning, and a strong test model; it does not provide canonical-state triggers, Promote transactions, or authority reconciliation.
- npm package search :: adapt :: `pi-memory` offers qmd semantic search and can become a future retrieval plugin; its storage model is not the filesystem-first governed lifecycle required here.
- npm package search :: adapt :: `@reddb-io/red-skills-memory` is conceptually close on governed Markdown memory and context packs, but adds graph/runtime scope beyond this MVP.
- GitHub code search :: adapt :: OpenClaw, Gemini CLI, and oh-my-claudecode demonstrate project-scoped memory and tier separation; none is a drop-in Pi package for this lifecycle.
- local Pi skills :: no-match :: no active local Pi skill provides prospective project memory with Trigger, Promote, and Reconcile.
- local Pi extensions :: no-match :: no active local Pi extension provides a project Note store or mandatory semantic capture gate.
- Pi examples/docs :: reuse :: lifecycle events, `session_before_compact`, `before_agent_start`, custom tools, project trust, and file-mutation queues are reused directly.

## Development

```bash
npm install
npm test
npm run typecheck
npm run validate:skill
```

Load the package directly while developing:

```bash
pi -e .
```

Then initialize an opted-in project with the `project_memory` tool action `init` or the `/project-memory-init <project-id>` command.

## MVP capability boundary

Version 0.2.0 uses exact metadata filters, prompt-term relevance ranking, and trusted canonical-state triggers. It does not include embeddings, a graph database, a daemon, automatic scientific adjudication, or cross-project federation. Promote requires a content-bound single-use UI approval; pending capture candidates persist durably under `.project-memory/pending/`.
