# Pi Note Skills

A Pi package for continuity across fragmented, multi-session project work. It keeps deferred work, decisions, open questions, assumptions, risks, and ideas as searchable, non-canonical Markdown notes and reactivates them when a task or trusted project milestone makes them relevant.

The architecture baseline is documented in [`Note_Skills_Design.md`](Note_Skills_Design.md).

## Design motivation: unload, not just recall

> 现在常见的 memory 多为 correct memory，本质就是将模型的历史记录整理输入到上下文，目的是减少模型在同类问题上的错误率，但是本项目希望做的是让模型将项目的内容及时从上下文卸载到 md 文本中，避免在超长程任务上出现的注意力漂移现象。

### correct memory 是什么

“correct memory”并不是一个标准化的记忆分类，它描述的是一类 memory 系统的目标：把模型的历史记录整理、压缩、检索，然后针对当前任务把“正确、最新、可信、不冲突”的那条记忆注入上下文，让模型在同类问题上答案更一致。它的数据流向是：

```text
历史记录 → 整理/检索 → 注入上下文 → 减少同类问题错误率
```

这是一类**增强型（injection）记忆系统**：记忆是知识库，系统的价值在于“从库里挑对东西喂回去”。代价是上下文持续被占用，且历史信息容易以“第二套真值”的姿态与当前事实竞争。

### 本项目不是 memory 类项目

Note Skills 的数据流向是相反的：

```text
当前上下文 → 及时卸载 → Markdown 文件 → 按需拉回
```

它要解决的不是“模型同类问题答错”，而是“超长程任务上信息失去工作状态”：已经定下来的决策、被推迟的工作、尚未验证的假设，随着上下文被压缩、截断或重建，从模型实际注意中淡出。本项目是**连续性层（continuity layer）**，是上下文的工作状态管理，不是记忆增强：

- 卸载发生在“讨论结束、任务执行、上下文压缩”等确定性时点，而非“模型记得保存”；
- 内容按语义对象（decision / deferred_work / open_question / …）组织，而不是会话纪要和历史回放；
- 拉回由 Trigger（里程碑/依赖/日期）和可信检索触发，而不是把全部历史常驻窗口；
- 权威始终在 canonical 侧：note 是 non-authoritative data，与正式真值冲突时以 canonical 为准；
- 一切持久化状态按不可信默认处理（威胁模型 §7 的 fail-closed 设计）。

### 超长程任务（long-horizon）为什么需要它

传统长程任务近似：

```text
开始任务 → 连续规划与执行 → 完成任务
```

实验与开发项目的真实工作流是**时间碎片化超长程任务（temporal fragmented long-horizon task）**：工作点分散在真实时间中的多个会话、多个里程碑与多个执行者之间；单次任务可能不长，但任务之间存在天、周或月级间隔；当前实现、未来设想、尚未验证的假设和正式决策同时存在；模型和用户都会遗忘，且未来任务启动时未必知道应该检索什么。

即使拥有超长上下文，信息仍可能**可见但不可激活**：原始对话或历史文件尚未丢失，但长期任务中当前代码、当前缺陷和当前验收目标占据更高注意力权重，历史决策无法被重新激活。这就是**注意力漂移（attention drift）**——不是模型变笨，而是重要信息仍在窗口里却不再被关注，或已经被逐出。典型失败模式：

| 失败模式 | 表现 |
| --- | --- |
| P1/P2 遗忘 | P0 完成后重新讨论已经讨论过的内容 |
| 理由丢失 | 只知道“选了方案 A”，不知道为什么 |
| 笔记沉睡 | 信息写入文件后再也没有读出 |
| 旧信息污染 | 同时读到已过时方案和当前方案 |
| 第二套真值 | Notes、规范、代码分别陈述不同的当前状态 |

因此本项目用确定性机制（Capture Gate、Trigger、Promote、Reconcile）把“模型记得维护”升级为“系统必然维护”：模型负责语义判断，确定性 Core 负责信息是否有生命周期、何时重新出现、权威性如何、是否仍然有效。


## Why a package, not only a prompt

The package separates responsibilities:

- `skills/note-skills/` teaches the model when and how to capture or retrieve semantic memory objects.
- `extensions/note-skills.ts` exposes the tool and maps Pi lifecycle events to capture/retrieval gates.
- `src/` enforces deterministic storage, validation, IDs, indexing, trigger evaluation, promotion, and reconciliation.
- `.note-skills/` is created inside each opted-in project; Markdown notes are primary data and JSON indexes are rebuildable.

Note Skills is not a Source of Truth. Current specifications, code, ADRs, issues, experiments, and accepted conclusions always take precedence.

## Existing implementations considered

- npm package search :: adapt :: `pi-hermes-memory` offers persistent memory, session search, secret scanning, and a strong test model; it does not provide canonical-state triggers, Promote transactions, or authority reconciliation.
- npm package search :: adapt :: `pi-memory` offers qmd semantic search and can become a future retrieval plugin; its storage model is not the filesystem-first governed lifecycle required here.
- npm package search :: adapt :: `@reddb-io/red-skills-memory` is conceptually close on governed Markdown memory and context packs, but adds graph/runtime scope beyond this MVP.
- GitHub code search :: adapt :: OpenClaw, Gemini CLI, and oh-my-claudecode demonstrate project-scoped memory and tier separation; none is a drop-in Pi package for this lifecycle.
- local Pi skills :: no-match :: no active local Pi skill provides prospective note skills with Trigger, Promote, and Reconcile.
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

Then initialize an opted-in project with the `note_skills` tool action `init` or the `/note-skills-init <project-id>` command.

## MVP capability boundary

Version 0.2.3 uses exact metadata filters, prompt-term relevance ranking, and trusted canonical-state triggers. It does not include embeddings, a graph database, a daemon, automatic scientific adjudication, or cross-project federation. Promote requires a content-bound single-use UI approval whose process-local capability is re-verified against the exact approved bytes before every canonical write; pending capture candidates persist durably under `.note-skills/pending/`.

**Trust boundary (recorded):** the Core API asserts but cannot prove that a live user confirmation occurred; the real UI gate (direct confirm dialog over exact target bytes) lives in the Pi Extension layer. Core pins the approval channel to `pi-ui` and requires a `pi-session://` principal, which prevents ad-hoc Core callers from minting approvals. If arbitrary in-process extensions belong to your threat model, treat Core callers as already trusted with user-level authority — the durable proof of "the user clicked confirm" is the extension's receipt record.
