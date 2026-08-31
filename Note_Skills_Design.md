# Note Skills / Notes Skill 架构设计

> 面向实验 Agent 与开发 Agent 的时间碎片化超长程任务连续性层

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v0.1 |
| 状态 | Proposed（架构基线，尚不代表已经实现） |
| 适用对象 | 实验 Agent、开发 Agent、长期运行 Harness、Agent 工具与 Skill 开发者 |
| 核心定位 | filesystem-first、hook-enforced、searchable、provenance-aware 的 Note Skills Layer |
| 更新日期 | 2026-08-29 |

## 0. 执行摘要

本设计要解决的不是“如何让一个 Agent 连续工作更久”，而是“如何让人和多个短生命周期 Agent 围绕同一项目连续协作数周、数月甚至更久”。

典型场景是：团队在实现 P0 时讨论出若干 P1/P2 方案、假设、风险与开放问题；这些信息没有进入当前实现，也不适合立即写入正式规范，于是只停留在聊天上下文、临时文件或人的记忆中。等 P0 完成后，即使原始上下文仍可访问，模型也可能因注意力偏移而无法主动重新发现这些信息，用户也可能忘记当时的理由。

本设计的核心判断如下：

1. **存在于 Context，不等于存在于 Agent 的工作状态。** 更长的上下文只能缓解遗忘，不能建立跨时间的项目连续性。
2. **单独提供一个可选的 Notes Skill 不足以解决问题。** 当前任务的优化压力会促使模型减少工具调用与“非必要”文件，因此 Mandatory Capture 必须由 Harness Hook 强制检查。
3. **Note Skills 的核心价值不是存档，而是未来重新激活。** Capture 只有与 Retrieval、Trigger、Promote、Reconcile 和 Provenance 形成闭环才有意义。
4. **Note Skills 不是 Source of Truth。** 它回答“过去想过什么、为什么推迟、何时应重新考虑”；正式规范、代码、实验记录与被接受的结论回答“现在到底是什么”。
5. **第一版应保持简单。** 使用 Markdown、YAML Frontmatter、结构化筛选和文本检索即可；优先把 Hook、权威边界、状态转换、去重、Promote 与 Reconcile 做正确，复杂 RAG 后置。

一句话定义：

> Note Skills 是一个由 Harness 强制维护、可检索、可追溯、支持条件触发的非规范性项目记忆层；Notes Skill 是模型访问该记忆层的接口，而不是正确性的唯一保障。

---

## 1. 背景与问题定义

### 1.1 从长程任务到时间碎片化超长程任务

传统长程任务通常近似为：

```text
开始任务 → 连续规划与执行 → 完成任务
```

实验与开发项目的真实工作流更接近：

```text
讨论 A
  → 实现 P0
  → 数天后验证
  → 讨论 B
  → 修改实现
  → 一周后完成 P0
  → 数周后重新考虑早期 P1
  → 换一个 Agent 或重新打开项目继续工作
```

本文将其称为：

> **时间碎片化超长程任务（temporal fragmented long-horizon task）**

它有四个共同特征：

- 工作点分散在真实时间中的多个会话、多个里程碑与多个执行者之间；
- 单次任务可能不长，但任务之间存在天、周或月级间隔；
- 当前实现、未来设想、尚未验证的假设和正式决策同时存在；
- 模型和用户都会遗忘，且未来任务启动时未必知道应该检索什么。

### 1.2 为什么超长 Context 不能从根本上解决

长上下文提供的是“可见性”，不是“工作状态管理”。信息即使仍在窗口中，也可能因为当前代码、当前缺陷和当前验收目标占据更高注意力权重而无法被重新激活。

因此需要区分：

- **信息仍然存在**：原始对话或历史文件尚未丢失；
- **信息可被发现**：系统知道如何检索它；
- **信息应在此刻被发现**：系统知道当前里程碑满足了它的 Trigger；
- **信息具有何种权威性**：系统知道它是想法、未决问题、正式决策还是当前真值；
- **信息仍然有效**：系统知道它是否被更新、替代、提升或关闭。

Context 本身不能稳定承担这些职责。

### 1.3 典型失败模式

| 失败模式 | 表现 | 根因 |
| --- | --- | --- |
| P1/P2 遗忘 | P0 完成后重新讨论已经讨论过的内容 | Deferred Work 没有被结构化捕获和触发 |
| 理由丢失 | 只知道“选了方案 A”，不知道为什么 | Decision 只记录结果，没有保存 rationale 与替代方案 |
| 笔记沉睡 | 信息写入文件后再也没有读出 | 只有 Capture，没有任务开始与里程碑触发的 Retrieval |
| 旧信息污染 | Agent 同时读到已过时方案和当前方案 | 缺少 supersedes、状态过滤和 canonical precedence |
| 第二套真值 | Notes、规范、代码分别陈述不同的当前状态 | Memory 与 Source of Truth 的权威边界不清 |
| 会话纪要泛滥 | 每次聊天都生成长篇流水账 | 笔记按会话而非按语义对象组织 |
| 模型选择性漏记 | 模型认为“不重要”而不调用记忆工具 | Capture 依赖模型自觉，没有 Mandatory Hook |
| 来源断裂 | 无法判断一条笔记来自谁、何时、哪段讨论 | 缺少稳定 ID、来源引用、时间和哈希 |

### 1.4 问题边界

本文关注的是项目级连续性，而不是通用个人记忆、模型参数记忆或完整聊天归档。系统的工作对象是：

- 尚未进入正式计划的后续工作；
- 已明确或拟议的决策及其理由；
- 开放问题、假设、风险与想法；
- 未来何时应该重新考虑这些对象；
- 它们如何被提升到正式项目文件，以及如何与当前真值保持一致。

---

## 2. 目标、非目标与成功标准

### 2.1 目标

Note Skills 应实现以下目标：

1. 在讨论、任务结束与上下文压缩前，可靠捕获必须长期保存的语义对象；
2. 在新任务、里程碑完成或项目状态变化时，主动重新激活相关记忆；
3. 保存“是什么、为什么、何时再看、与什么有关、来自哪里”；
4. 明确区分 Memory、正式决策、当前状态与原始讨论；
5. 支持 Note 向规范、ADR、Backlog、ExperimentSpec 等正式对象的受控 Promote；
6. 检测过时、冲突、断链、重复、半完成 Promote 与触发器漂移；
7. 让新会话、新 Agent 或新成员能在有限上下文预算内恢复必要项目历史；
8. 在实验项目中保持证据、实验记录、科学结论与讨论记忆之间的严格边界。

### 2.2 非目标

MVP 不承担以下职责：

- 保存每一句聊天或生成完整会议纪要；
- 替代项目规范、代码、Issue、实验登记、RunManifest、Evidence 或 Claim；
- 自动判断科学结论成立，或把讨论性想法提升为研究事实；
- 自动执行被 Trigger 激活的工作；
- 构建通用知识图谱、复杂向量数据库或全局跨项目“第二大脑”；
- 将密钥、令牌、患者原文、敏感个人信息或未授权数据写入笔记；
- 依赖一个常驻且永不丢失上下文的 Agent；
- 依赖模型在每次讨论中都能自觉、完整地调用 Skill。

### 2.3 成功标准

一个最小可用实现至少应证明：

- P0 讨论中明确推迟的 P1 项目会被捕获为独立 Note；
- 当正式项目状态变为 `P0_COMPLETE` 时，该 Note 会被检索并呈现；
- 被替代或已 Promote 的旧 Note 默认不会作为当前建议出现；
- Agent 能说明检索结果为何相关、来源是什么、权威等级是什么；
- Note 与正式文件冲突时，正式文件优先，系统产生 Reconcile 提示而不是混合两种说法；
- Promote 后，Note 保留历史但明确指向正式目标，不再形成第二套当前真值；
- 删除生成索引后可以由原始 Note 完整重建；
- Capture 失败时，关键 Hook 能阻止静默丢失或留下可审计的失败结果。

---

## 3. 核心判断

### 3.1 Note Skills 是基础设施，不是普通笔记功能

对于超长程 Agent，Note Skills 与 `read`、`write`、`search` 一样属于基础能力。它不是为了增加文档数量，而是为了让“尚未成为当前真值、但未来仍有价值的信息”具备生命周期。

### 3.2 Skill 是接口，Harness 是保障

模型可通过 Skill 调用：

```text
note_skills.capture()
note_skills.search()
note_skills.read()
note_skills.update()
note_skills.close()
note_skills.promote()
```

但以下职责必须属于确定性的 Harness：

- Mandatory Capture 检查；
- Schema 与状态转换验证；
- 稳定 ID、时间、来源和哈希；
- 原子写入、去重与幂等；
- 权限与敏感信息策略；
- 索引生成与一致性检查；
- Trigger 计算；
- Promote 事务和回读；
- Reconcile 与漂移报告。

### 3.3 Capture 与 Retrieval 必须形成闭环

失败的记忆系统通常不是“完全没写”，而是“写进去后再也没有读出来”。完整闭环应为：

```text
讨论或执行
  → Mandatory Capture
  → 结构化 Note
  → 可重建索引
  → 任务/里程碑 Trigger
  → 受预算约束的 Retrieval
  → 重新进入 Working Context
  → 更新、关闭或 Promote
  → Reconcile
```

### 3.4 P1 问题本质上是 Prospective Memory 缺失

普通历史记忆回答“以前发生过什么”；P1/P2 延后工作需要回答：

> 当某个条件满足时，应该提醒未来的 Agent 重新考虑什么？

因此 Trigger-based Retrieval 不是附加功能，而是 Note Skills 的核心能力。

### 3.5 正确性不应依赖模型注意力

模型负责语义理解、候选提取、摘要与相关性判断；系统负责不变量。凡是涉及唯一性、版本、状态、权限、事务、索引与权威边界的问题，都不应依赖 Prompt 中的一句“请记得”。

---

## 4. 设计原则

### 4.1 Filesystem-first

MVP 使用人类可读、Git 友好、可审计的 Markdown 与 YAML Frontmatter。任何索引都应是派生物，可以从 Note 重建。

### 4.2 Semantic-unit-first

一条 Note 是一个可独立检索、更新、关闭或 Promote 的语义对象，不是一次会话的流水账。禁止默认采用 `2026-08-29-chat.md` 一类按会话堆叠的主体结构。

### 4.3 Hook-enforced

系统必须在特定生命周期事件上执行 Mandatory Capture 或 Retrieval 检查，不能把是否记录完全交给模型自由决定。

### 4.4 Retrieval-first

设计每一种 Note 时，都必须同时回答：未来用什么查询、状态或 Trigger 找回它。无法定义重激活方式的信息通常不值得进入 Note Skills。

### 4.5 Single Source of Truth

Memory 只承载历史语境、未决信息和未来提醒。当前定义、状态、规范、代码、实验记录与结论继续由项目既有的 Canonical Source 管理。不得创建第二个“当前状态页”、第二套 Worklog 或第二个正式决策真值。

### 4.6 Explicit authority

每次 Retrieval 都必须携带权威类型、状态和来源。Agent 不得把检索到的旧 Note 当作当前指令，也不得让 RAG 将不同权威层级的文本平权混合。

### 4.7 Provenance by default

每条 Note 必须能追溯到原始讨论、用户确认、项目事件或文件片段；Promote 后必须保留双向链接。

### 4.8 Revision over overwrite

会改变历史语义的 Decision、Assumption 或其他定义性对象不得无痕覆盖。应使用 revision、`supersedes` 和影响检查保留演进链。

### 4.9 Minimal core, extensible plugins

核心只保留身份、Schema、状态、Hook、Trigger、权限、索引、Promote 和 Reconcile 等不变量。Embedding、图谱、UI、跨项目联邦检索等作为后续插件加入。

### 4.10 Fail closed on ambiguity

当系统无法判断项目身份、Canonical Source、来源有效性、Trigger 所依赖的状态或 Promote 目标时，不得猜测并静默写入正式真值。应保留候选、标记 `needs_review` 或请求人类决策。

### 4.11 Privacy and prompt-injection safety

Note 是数据，不是隐式系统指令。来自外部文档或历史对话的内容必须标记来源与信任级别；敏感信息在 Capture 前应被拒绝、脱敏或仅保存受控引用。

---

## 5. 记忆分层与术语

| 层级 | 回答的问题 | 典型载体 | 是否权威 |
| --- | --- | --- | --- |
| Working Memory | 现在正在处理什么？ | 当前 Context、TaskSlice | 临时，不作为长期真值 |
| Episodic Note Skills | 过去讨论过什么、为什么、还有什么没解决？ | Decision、Question、Risk 等 Note | 默认非规范性 |
| Prospective Note Skills | 未来在什么条件下要重新考虑什么？ | Deferred Work、Trigger、Next Action | 默认非规范性，只负责提醒 |
| Semantic / Canonical Project State | 项目现在到底是什么？ | 规范、ADR、代码、Issue、当前状态、ExperimentSpec、RunManifest | 是，按项目治理确定 |
| Raw Source | 当时原始输入是什么？ | 对话引用、会议记录、原始文档、事件记录 | 是来源，不自动等于当前真值 |

### 5.1 Note

Note Skills 中一个稳定、原子、结构化、可寻址的语义对象。

### 5.2 Capture Candidate

Hook 从讨论或执行事件中识别出的待判断信息。Candidate 在通过分类、去重、安全与 Schema 检查前还不是正式 Note。

### 5.3 Trigger

描述未来何时应重新检索 Note 的可计算条件，例如 `P0_COMPLETE`、某个依赖关闭、某个组件重新被修改或某个日期到达。

### 5.4 Promote

把 Note 中已成熟的内容受控写入 Canonical Source，并将 Note 标记为已提升、建立双向来源关系的事务。

### 5.5 Reconcile

检查 Note 内部、Note 与 Canonical Source、索引与 Trigger 之间的一致性，发现过时、冲突、断链和半完成事务。

---

## 6. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│ User / Experiment Agent / Development Agent / Worker         │
└──────────────────────────────┬───────────────────────────────┘
                               │
                     Working Context / TaskSlice
                               │
             ┌─────────────────▼─────────────────┐
             │ Model-facing Note Skills Skill │
             │ capture/search/read/update/...    │
             └─────────────────┬─────────────────┘
                               │ proposes semantic operation
             ┌─────────────────▼─────────────────┐
             │ Core Harness                       │
             │ Identity · Hook · Gate · Policy    │
             │ Schema · Transaction · Audit       │
             └───────┬──────────┬──────────┬──────┘
                     │          │          │
          ┌──────────▼───┐ ┌────▼─────┐ ┌──▼────────────┐
          │ Note Store    │ │ Retriever│ │ Trigger Engine│
          │ Markdown/YAML │ │ + Index  │ │ state events  │
          └──────────┬────┘ └────┬─────┘ └──┬────────────┘
                     │           │           │
               ┌─────▼───────────▼───────────▼─────┐
               │ Promote + Reconciler              │
               │ revision · link · drift · repair  │
               └───────────────┬───────────────────┘
                               │ controlled adapters
          ┌────────────────────▼──────────────────────────────┐
          │ Existing Canonical Sources and Project Event Log │
          │ Spec · ADR · Code · Issue · Experiment · Evidence│
          └───────────────────────────────────────────────────┘
```

### 6.1 组件职责

#### Note Skills Skill

- 为模型提供少量稳定操作；
- 负责把任务语义转换成结构化调用；
- 展示检索结果的权威、状态、来源和相关原因；
- 不绕过 Harness 直接写文件。

#### Core Harness

- 确认项目身份与记忆根目录；
- 执行 Hook、Gate、安全策略与权限检查；
- 分配稳定 ID，校验状态转换；
- 保证写入、Promote 和索引更新的幂等与可恢复性；
- 连接项目既有事件日志，避免另建竞争性全局日志。

#### Note Store

- 保存 Markdown + YAML Frontmatter；
- 以语义对象为单位组织；
- 是 Note Skills 的原始记录层；
- 支持 Git diff、人工审阅和离线检索。

#### Index / Retriever

- 生成可重建的元数据与 Trigger 索引；
- 支持 exact ID、结构化筛选、关系遍历和全文检索；
- 在上下文预算内返回摘要，按需展开正文；
- 默认过滤终止、被替代或已归档对象。

#### Trigger Engine

- 监听 Canonical State 或可信项目事件；
- 计算 milestone、dependency、date、component 等条件；
- 只激活与呈现 Note，不自动执行工作或修改正式状态。

#### Promoter

- 将成熟 Note 映射到既有 Canonical Source；
- 生成精确变更、执行必要 Gate、回读并建立双向链接；
- 防止 Note 在 Promote 后继续充当第二套当前真值。

#### Reconciler

- 检查重复、冲突、断链、状态漂移和索引漂移；
- 只自动修复可重建派生物；
- 对 Canonical Source 的变更只提出建议或进入既有审批流程。

### 6.2 责任边界

| 责任主体 | 应负责 | 不应负责 |
| --- | --- | --- |
| 模型 | 语义提取、摘要、候选分类、相关性解释、变更建议 | 稳定 ID、权限、事务、唯一性、最终权威判断 |
| Harness | Hook、Gate、Schema、状态机、原子写入、索引、Trigger、Reconcile | 独立发明项目目标或科学结论 |
| 人类/项目治理 | 接受关键决策、批准 Promote、确认高风险冲突与科学权边界 | 依靠记忆手工维护所有派生索引 |
| Worker Agent | 在授权范围内产生候选 Note 或 Result | 直接把 Note 提升为 Canonical Fact |

---

## 7. Note Skills 与 Source of Truth 的区分

### 7.1 两者回答不同问题

**Note Skills 回答：**

- 我们以前考虑过什么？
- 为什么当时没有做？
- 哪些问题仍然开放？
- 哪个假设需要验证？
- 什么条件满足后应重新考虑？

**Canonical Source 回答：**

- 当前被采用的规范是什么？
- 当前代码与接口是什么？
- 当前里程碑、任务或实验状态是什么？
- 哪个实验确实运行过，使用了什么配置和数据？
- 哪个结论经过了规定的接受流程？

### 7.2 权威优先级

默认检索与冲突解释顺序为：

```text
Canonical current state
  > 项目正式承认的 active Decision / ADR
  > active Note Skills Note
  > superseded / archived Note
  > Raw discussion
```

`type: decision` 本身不自动获得正式权威。只有存在明确接受证据，且该项目治理合同承认这一 Decision 对象时，它才属于第二层；否则它仍是普通 Memory。项目存在 ADR 或正式决策登记时，应尽快 Promote 到该位置。

### 7.3 面向开发 Agent 的映射

| 信息 | 推荐 Source of Truth | Memory 的作用 |
| --- | --- | --- |
| 当前需求与边界 | PRD、Spec、Issue、验收合同 | 保存早期讨论、被拒方案和推迟功能 |
| 当前架构 | Architecture、ADR、代码 | 保存尚未接受的架构想法与理由 |
| 当前实现 | 代码、迁移、配置 | 保存未来重构提醒与风险 |
| 当前质量状态 | 测试、CI、Review 结果 | 保存未解决问题和复查 Trigger |

### 7.4 面向实验 Agent 的映射

| 信息 | 推荐 Source of Truth | Memory 的作用 |
| --- | --- | --- |
| 实验定义 | 冻结的 ExperimentSpec / Protocol | 保存候选实验、未决变量和推迟方案 |
| 实验执行 | RunManifest、日志、Artifact Hash | 保存“下一轮应尝试什么”的想法 |
| 证据 | EvidenceCard、受控数据与来源链 | 保存证据缺口、假设与风险提醒 |
| 科学结论 | Claim、评审或裁决记录 | 保存候选解释，但不能自动提升为已支持结论 |

### 7.5 冲突处理规则

当 Note 与 Canonical Source 冲突时：

1. Retrieval 明确显示两者及权威等级；
2. Agent 以 Canonical Source 为当前工作依据；
3. Reconciler 将 Note 标记为 `needs_review` 或建议 `superseded`；
4. 不静默重写历史 Note，不让语义搜索“折中”出第三种说法；
5. 如果 Canonical Source 本身可能过时，进入项目既有治理流程，而不是由 Memory 反向覆盖。

---

## 8. Note 数据模型

### 8.1 一条 Note 是一个语义单元

每条 Note 应满足：

- 只有一个主要主题；
- 有稳定 ID；
- 能独立解释，不依赖完整聊天上下文；
- 有状态、来源、关系和重激活方式；
- 能被更新、关闭、替代或 Promote；
- 不复制整个 Canonical 文件。

### 8.2 ID 与文件名

建议 ID 格式：

```text
PM-<TYPE>-<SEQUENCE>
```

示例：

```text
PM-DEF-0003
PM-DEC-0012
PM-QUE-0007
PM-ASM-0004
PM-RSK-0011
PM-IDE-0009
```

建议文件名包含 ID 与稳定 slug：

```text
PM-DEF-0003-multi-agent-scheduling.md
```

标题变化不应改变 ID。重命名文件时，索引应保留同一对象身份。

### 8.3 通用 Frontmatter 示例

```yaml
---
schema_version: 1
id: PM-DEF-0003
project_id: experiment-agent
type: deferred_work
status: deferred
priority: P1
title: 多 Agent 实验调度
summary: P0 完成后重新评估是否引入多 Agent 调度。
rationale: >-
  当前 Demo 优先验证单 Agent 闭环；过早加入多 Agent 会增加 Harness、
  权限和验收复杂度，妨碍对核心闭环的判断。
created_at: 2026-08-29T10:30:00+08:00
updated_at: 2026-08-29T10:30:00+08:00
created_by:
  kind: agent
  id: development-agent
authority: memory
confidence: explicit_discussion
sensitivity: internal
tags:
  - multi-agent
  - orchestration
  - experiment
source_refs:
  - kind: conversation
    ref: chatgpt-conversation://example-id
    turn_id: example-turn-id
    observed_at: 2026-08-29T10:25:00+08:00
    excerpt_sha256: "<sha256>"
related_files:
  - path: docs/demo.md
    relation: context
  - path: src/agent/
    relation: affected_component
relations:
  depends_on:
    - P0-DEMO
  related_to:
    - PM-RSK-0011
  supersedes: []
  superseded_by: null
trigger:
  mode: any
  conditions:
    - kind: milestone
      key: P0
      operator: equals
      value: complete
next_action: 复核并发需求、权限模型与单 Agent 瓶颈，再决定是否进入正式设计。
promotion:
  status: not_promoted
  target: null
  promotion_id: null
---
```

建议正文模板：

```markdown
## Context

说明这条信息在什么讨论或任务中出现。

## What to reactivate

未来重新读到这条 Note 时，真正需要恢复的判断是什么。

## Alternatives and unresolved points

记录替代方案、反对理由或尚未解决的变量。

## Close / promotion criteria

定义何时可以关闭、拒绝、替代或 Promote。
```

### 8.4 通用必填字段

| 字段 | 作用 |
| --- | --- |
| `schema_version` | 支持未来迁移 |
| `id` | 稳定身份，不依赖路径 |
| `project_id` | 防止跨项目污染 |
| `type` | 决定验证规则和检索策略 |
| `status` | 控制默认检索和生命周期 |
| `title` / `summary` | 支持低成本预览 |
| `rationale` | 保存“为什么”，避免只留结果 |
| `created_at` / `updated_at` | 时间边界与审计 |
| `source_refs` | 原始来源与可追溯性 |
| `authority` | 防止被误当作 Canonical Source |
| `trigger` 或明确的无 Trigger 原因 | 支持未来重激活 |
| `next_action` | 说明重新激活后应做什么 |
| `promotion` | 避免 Promote 后形成双重真值 |

### 8.5 类型特定字段与状态

| 类型 | 典型状态 | 额外必填信息 |
| --- | --- | --- |
| `deferred_work` | `deferred`、`ready`、`in_progress`、`done`、`dropped`、`promoted` | 推迟原因、Trigger、Next Action、依赖 |
| `decision` | `proposed`、`accepted`、`rejected`、`superseded`、`promoted` | 决策内容、候选方案、理由、接受证据 |
| `open_question` | `open`、`answered`、`closed`、`promoted` | 明确问题、所需证据、回答/关闭标准 |
| `assumption` | `unvalidated`、`supported`、`invalidated`、`expired`、`promoted` | 假设、验证方法、失效影响 |
| `risk` | `open`、`mitigated`、`accepted`、`realized`、`closed` | 概率、影响、信号、缓解方案、Owner |
| `idea` | `captured`、`incubating`、`rejected`、`promoted`、`archived` | 潜在价值、为什么现在不做、复查条件 |

类型状态由 Schema 条件约束，不允许任意字符串。生成索引可把这些状态映射为 `active` 或 `terminal`，但该映射是派生数据。

### 8.6 关系模型

MVP 至少支持：

- `depends_on`：依赖哪个里程碑、任务或 Note；
- `related_to`：弱语义关联；
- `supersedes` / `superseded_by`：版本与替代链；
- `derived_from`：从哪个 Note 或来源推导；
- `promoted_to`：进入哪个 Canonical Object；
- `implemented_by`：对应哪个提交、任务或实验；
- `verified_by`：由哪个测试、Run 或评审验证。

关系目标优先使用稳定对象 ID；文件路径只是可读定位，不应成为唯一身份。

### 8.7 来源引用

来源引用应尽可能包含：

- 来源类型与稳定 URI/对象 ID；
- 会话 Turn、文档段落、事件或 Commit；
- 观察时间；
- 有界支持片段或片段哈希；
- 捕获者身份与信任级别。

如果原始对话未来可能不可访问，Note 正文应保存足够的最小语义，而不是只留一个失效链接；同时避免复制无关的完整对话。

---

## 9. Mandatory Capture 类型

系统不应记录所有内容，但以下六类信息必须进入 Capture Gate。

### 9.1 Deferred Work

识别信号包括：`P1`、`P2`、以后、后续、暂不实现、先不做、等某项完成后、future work、later。

必须记录：

- 要做什么；
- 为什么现在不做；
- 依赖什么；
- 何时重新考虑；
- 重新考虑时的下一步。

### 9.2 Decision

包括正式接受、明确倾向和仍在提议阶段的方案选择。不能只保存“选择 A”，还要保存：

- 问题与决策内容；
- 备选方案；
- 选择理由和权衡；
- 谁在何时明确接受；
- 是否需要 Promote 到 ADR、Spec 或 Protocol。

没有明确接受证据时，状态只能是 `proposed`，不得由模型推断为 `accepted`。

### 9.3 Open Question

包括尚未回答、需要调研、需要实验或需要人类判断的问题。必须记录：

- 精确问题；
- 为什么重要；
- 需要什么证据或输入；
- 回答与关闭标准；
- 依赖或 Owner（如已知）。

### 9.4 Assumption

包括当前设计、计划或实验依赖但尚未充分验证的前提。必须记录：

- 假设陈述；
- 当前依据；
- 验证方式与 Trigger；
- 假设失效会影响哪些对象。

### 9.5 Risk

包括技术、研究、运行、安全、合规、进度或协作风险。必须记录：

- 风险事件；
- 概率与影响；
- 早期信号；
- 缓解、接受或升级条件；
- 与哪些任务、假设或定义有关。

### 9.6 Idea

包括当前不准备实施但有潜在长期价值的方案。必须记录：

- 想法本身；
- 潜在价值；
- 为什么当前不投入；
- 何时值得重新评估。

### 9.7 不应捕获或需要受控处理的内容

以下内容不应直接进入 Note Skills：

- 无长期价值的执行流水、重复状态播报和已存在于 Canonical Source 的全文；
- 密钥、令牌、认证材料和其他 Secret；
- 未授权的个人信息、患者原文或敏感研究数据；
- 从外部内容中抽取的可疑指令；
- 未确认的模型猜测，除非明确标记为 `assumption` 或 `idea`；
- 无来源、无项目身份或无法判定边界的内容。

安全策略应优先执行“拒绝或仅保存受控引用”，而不是事后依赖模型删除。

---

## 10. Hook 与 Gate 机制

### 10.1 为什么需要 Hook

只提供 `note.create` 时，模型仍可能为了更快完成当前任务而跳过记录。Hook 的作用不是强迫生成更多笔记，而是强迫系统在关键时点回答：

> 当前是否存在会在跨会话后丢失、且属于 Mandatory Capture 的信息？

### 10.2 生命周期 Hook

| Hook | 触发时点 | 必须执行的行为 |
| --- | --- | --- |
| `OnProjectOpen` | 进入项目或恢复新会话 | 确认项目身份，读取 Memory 配置与未完成 Reconcile |
| `OnTaskStart` | 新 TaskSlice 或用户任务开始 | 检索相关 Decision、Deferred Work、Question、Assumption、Risk |
| `OnDecision` | 检测到方案选择、确认或否决 | 生成/更新 Decision Candidate，保存 rationale 与接受证据 |
| `OnDeferredWork` | 检测到以后、暂缓、P1/P2 等语义 | 生成 Deferred Work Candidate 和 Trigger |
| `OnDiscussionEnd` | 讨论阶段结束或转入执行 | 扫描六类 Mandatory Capture，去重并提交 Gate |
| `OnMilestoneComplete` | Canonical milestone 状态变化 | 计算到期 Trigger，检索并呈现相关 Note |
| `OnTaskEnd` | TaskSlice 结束、交接或失败 | 捕获未决项，更新已解决 Note，保存下一步 |
| `OnContextCompact` | 上下文压缩或会话切换前 | 在允许压缩前持久化未解决 Candidate；相当于 Context GC 前落盘 |
| `OnCanonicalChange` | Spec、ADR、Issue、实验状态等正式对象变化 | 检查 Promote backlink、冲突、stale 与 Trigger |

并非每个平台都能直接拦截上下文压缩。无法实现 `OnContextCompact` 时，应使用最接近的会话结束、handoff 或 token 阈值 Hook，并把能力差异写入实现合同。

### 10.3 Capture Gate 流程

```text
Hook event
  → collect bounded context and changed objects
  → detect candidates
  → classify into six mandatory types
  → redact / policy check
  → deduplicate against active notes
  → normalize fields and source refs
  → validate schema and state transition
  → atomic write or update
  → rebuild/update derived index
  → emit auditable receipt
```

### 10.4 模型与确定性逻辑的分工

模型适合：

- 识别“为什么推迟”和“未来何时再看”；
- 把一段讨论拆成多个语义对象；
- 生成标题、摘要、理由和候选 Trigger；
- 判断两个对象是否可能语义重复。

Harness 必须确定性保证：

- 每个 Candidate 都获得 `captured`、`merged`、`rejected_by_policy` 或 `skipped_with_reason` 之一；
- 必填字段、ID、状态与引用合法；
- 写入不越过项目根目录与权限边界；
- `accepted` Decision 有明确接受证据；
- Sensitive 内容不会写入；
- 对同一 Hook 重试不会生成重复 Note；
- 失败不会被报告为已捕获。

### 10.5 Gate 严格度

建议三档：

| 等级 | 场景 | 行为 |
| --- | --- | --- |
| Blocking | Context Compact、明确 Decision、明确 Deferred Work | Candidate 未处理或写入失败时阻止静默完成 |
| Warning | Discussion End、Task End | 允许继续，但必须留下失败/跳过理由并在下次恢复时提示 |
| Advisory | 低置信度 Idea、弱相关外部信息 | 可不创建 Note，但不得伪装为确定性事实 |

“阻止”只针对持久化流程或状态提交，不应让模型在无法写笔记时无限循环。达到重试上限后，应安全失败并把未持久化风险明确交给用户或上层 Harness。

### 10.6 去重与合并

去重建议使用两层策略：

1. 确定性候选集：同项目、同类型、同关联对象、处于活动状态；
2. 语义判断：标题、摘要、Trigger 与来源是否描述同一对象。

合并时只追加来源、关系或新信息，不得无痕覆盖旧 rationale。若语义已经改变，应创建 revision 或使用 `supersedes`。

### 10.7 Capture Receipt

每次 Hook 应返回简短结果，例如：

```yaml
hook: OnDiscussionEnd
event_id: EVT-20260829-0017
candidates: 4
created:
  - PM-DEF-0003
  - PM-QUE-0007
updated:
  - PM-RSK-0011
skipped:
  - fingerprint: sha256:example
    reason: duplicate_of:PM-IDE-0009
errors: []
```

该 Receipt 应进入项目既有的事件或审计机制；若项目已有唯一 Worklog，不应另建竞争性全局日志。

---

## 11. 检索与 Trigger-based Retrieval

### 11.1 任务开始前的强制 Retrieval

`OnTaskStart` 至少执行：

1. 识别项目、任务类型、目标、里程碑、相关组件和文件；
2. 查询到期 Trigger；
3. 查询与任务相关的 active Decision、Deferred Work、Open Question、Assumption 和 Risk；
4. 排除默认不可见的 `superseded`、`rejected`、`archived` 和终态对象；
5. 用有限摘要注入 Working Context；
6. 仅在需要时读取完整 Note 与来源。

### 11.2 查询优先级

精确事实查询遵循：

```text
exact ID / canonical manifest
  → structured metadata filter
  → explicit relation and provenance traversal
  → lexical search
  → semantic retrieval plugin
```

Embedding 或 RAG 不应成为身份、版本、状态、排序和 Provenance 的权威来源。

### 11.3 结构化过滤

MVP 应支持按以下字段筛选：

- `project_id`；
- `type`；
- `status`；
- `priority`；
- `tags`；
- `related_files` / component；
- `depends_on`；
- `trigger due`；
- `created_at` / `updated_at`；
- `authority`；
- `promoted` / `superseded` 状态。

示例：

```text
search(
  project_id="experiment-agent",
  type="deferred_work",
  status=["deferred", "ready"],
  priority=["P0", "P1"],
  trigger_due=true
)
```

### 11.4 Retrieval Result Envelope

返回结果不能只包含自由文本。建议结构：

```yaml
id: PM-DEF-0003
title: 多 Agent 实验调度
type: deferred_work
status: ready
authority: memory
relevance_reason:
  - trigger P0_COMPLETE is satisfied
  - current task touches experiment orchestration
summary: P0 完成后重新评估是否引入多 Agent 调度。
next_action: 复核并发需求、权限模型与单 Agent 瓶颈。
source_refs:
  - chatgpt-conversation://example-id
canonical_conflict: false
```

模型在使用结果时应保留 `authority: memory` 标签，不得把摘要改写成正式项目事实。

### 11.5 Context 预算

建议采用两阶段读取：

- 第一阶段只注入 ID、类型、状态、相关原因、摘要、Trigger 与 Next Action；
- 第二阶段由 Agent 根据任务需要展开 1–N 条完整 Note；
- 原始讨论仅在需要判断理由、歧义或来源时展开。

这能防止 Note Skills 本身成为新的上下文噪声源。

### 11.6 Trigger 数据模型

```yaml
trigger:
  mode: all
  conditions:
    - kind: milestone
      key: P0
      operator: equals
      value: complete
    - kind: dependency
      key: PM-QUE-0007
      operator: status_in
      value:
        - answered
        - closed
```

MVP 建议支持：

- `milestone`：里程碑状态变化；
- `dependency`：任务、Note、Decision 或实验对象状态变化；
- `component`：某模块、文件或数据对象重新进入活动范围；
- `date`：到期复查；
- `event`：发布、实验结束、评审完成、定义修订等可信事件。

### 11.7 Trigger 语义

Trigger 满足后：

1. Note 从检索角度变为 `due` 或建议状态转为 `ready`；
2. 系统在当前任务启动或事件处理时呈现该 Note；
3. Agent/用户决定 Promote、启动任务、继续推迟、修改 Trigger 或关闭；
4. 系统不得仅因 Trigger 满足就自动执行代码、启动实验或接受结论。

Trigger 的条件值必须来自 Canonical State 或可信事件，不得由 Note 自己声称“P0 已完成”并自我触发。

### 11.8 Trigger 失效与不确定性

当依赖对象不存在、状态字段含义不明或版本无法确定时：

- 不猜测条件已经满足；
- 将 Trigger 标记为 `needs_review`；
- 提供缺失对象与失败原因；
- 由 Reconciler 或人类修复映射。

---

## 12. Promote：从记忆到正式项目状态

### 12.1 为什么必须 Promote

Note 不能永远充当半正式文件。典型演进链为：

```text
IDEA
  → accepted Decision
  → Architecture / ADR / Spec
  → Task / ExperimentSpec
  → Implementation / Run
```

如果成熟内容已经进入正式文件，而旧 Note 仍以活动状态出现，项目就会产生两个真相。

### 12.2 可 Promote 的典型映射

| Note 类型 | 典型目标 |
| --- | --- |
| `idea` | Decision Candidate、ADR、设计提案 |
| `decision` | ADR、Architecture、Protocol、Spec |
| `deferred_work` | Backlog、Issue、TaskSlice、Experiment proposal |
| `open_question` | Decision、研究问题、验收项、调查任务 |
| `assumption` | Spec constraint、Protocol assumption、Risk register |
| `risk` | 正式风险登记、Gate、测试或监控项 |

实验性 Candidate 不得直接 Promote 为“已支持的 Claim”。它必须经过项目规定的实验、证据与裁决链。

### 12.3 Promote 事务

```text
1. Resolve source Note and current revision
2. Resolve the existing canonical target and governance policy
3. Generate an exact proposed diff or new canonical object
4. Validate authority, schema, dependencies and conflicts
5. Obtain required human/Gate approval
6. Apply the canonical mutation atomically
7. Read back target ID/version/hash
8. Update Note: status=promoted, promoted_to=target
9. Add target backlink: derived_from=Note ID
10. Rebuild index and run Reconcile
```

### 12.4 Promote 不变量

- 不允许在目标不明确时自动新建第二份规范；
- 不允许绕过既有 Canonical 写入流程；
- 不允许只改 Note 状态但没有成功写入并回读目标；
- 不允许只写目标但丢失来源 Note；
- Promote 重试必须幂等，同一 `promotion_id` 不生成重复对象；
- 半完成事务必须被 Reconciler 发现；
- Note 不删除，保留历史并明确停止作为活动建议。

### 12.5 Promote 后的读取规则

默认 Retrieval 返回正式目标摘要，而不是继续返回 Note 正文；只有在用户询问历史理由、替代方案或来源时，才沿 `promoted_to` / `derived_from` 展开 Note。

---

## 13. Reconcile：一致性与漂移修复

### 13.1 Reconcile 范围

#### Note 内部一致性

- ID 重复；
- 类型与状态不匹配；
- 必填字段、Trigger 或来源缺失；
- `supersedes` 链成环；
- 同一 Decision 同时存在多个 active revision；
- 来源、关系或文件指针失效。

#### Memory 与 Canonical Source 一致性

- Note 陈述的当前状态与 Canonical Source 冲突；
- `promoted_to` 目标不存在或版本变化；
- 正式目标缺少 `derived_from` backlink；
- Canonical 变更后相关 Assumption、Risk 或 Decision 尚未复查；
- Trigger 已满足但 Deferred Work 长期未处理；
- 已完成任务对应 Note 仍显示 `deferred` 或 `open`。

#### 派生状态一致性

- 索引缺项、重复或与 Note 不一致；
- Trigger cache 与 Canonical State 不一致；
- 已删除索引无法重建；
- Retrieval 默认返回了应隐藏的 superseded/archived Note。

### 13.2 Reconcile 触发时点

- `OnProjectOpen`；
- `OnTaskStart` 与 `OnTaskEnd`；
- `OnCanonicalChange`；
- Promote 前后；
- 批量导入或 Schema 迁移后；
- 可选的定期维护任务。

### 13.3 自动修复边界

可以自动修复：

- 可重建索引与缓存；
- 规范化路径、排序和缺失的派生字段；
- 确定性 backlink（前提是目标和操作 ID 唯一）；
- 明确的终态过滤错误。

只能建议或进入 Gate：

- 修改 Canonical Source；
- 将 Decision 判为 accepted 或 superseded；
- 合并两个存在实质语义差异的 Note；
- 判定 Assumption 已被支持/推翻；
- 判定实验、Evidence 或 Claim 的科学状态。

### 13.4 状态语义

`stale` 或 `needs_review` 表示依赖变化后需要复核，不表示内容自动变成错误，更不表示科学结论已经被推翻。Reconciler 应报告：

- 发现了什么变化；
- 哪些对象受影响；
- 当前已知权威来源；
- 推荐的复核或修复动作；
- 是否做过自动修复。

---

## 14. Provenance：从讨论到实现与结论

### 14.1 Provenance 目标

系统应能回答：

- 这条 Note 来自哪次讨论或哪个项目事件？
- 谁把一个 Idea 接受为 Decision？
- Decision 被 Promote 到哪个规范版本？
- 哪个任务、提交或实验实现了它？
- 哪个测试、Run 或评审验证了它？
- 为什么后来被替代？

### 14.2 开发 Agent 的来源链

```text
Raw discussion
  → PM-IDE / PM-DEC / PM-DEF
  → ADR / Spec / Issue
  → Commit / Migration / Build Artifact
  → Test / Review / Release evidence
```

### 14.3 实验 Agent 的来源链

```text
Raw discussion
  → PM-QUE / PM-ASM / PM-RSK / PM-IDE
  → Research Question / Decision / ExperimentSpec
  → RunManifest + Artifact Hash
  → EvidenceCard
  → Claim + adjudication record
```

Note Skills 可以保存“考虑做某实验”或“某种解释值得验证”，但不能跳过 ExperimentSpec、Run、Evidence 和裁决直接生成受支持的 Claim。

### 14.4 最小 Provenance 字段

- 稳定对象 ID 与 revision；
- `derived_from` / `promoted_to` / `implemented_by` / `verified_by`；
- 创建、更新与接受时间；
- 操作者或 Agent 身份；
- 来源 URI、Turn、段落、事件或 Commit；
- 关键内容哈希；
- 状态变化理由；
- 必要的审批或 Gate 记录。

### 14.5 历史查询

精确历史查询应沿 ID 与 Provenance 链遍历，而不是要求语义搜索“回忆大概发生了什么”。例如：

```text
为什么当前使用 filesystem-first memory？

Architecture section
  ← derived_from DEC-006
  ← promoted_from PM-IDE-0003
  ← source discussion / turn
```

---

## 15. MVP 能力

### 15.1 MVP 必须形成闭环

MVP 不能只有 CRUD。最小闭环包括：

1. 六类 Mandatory Capture；
2. 结构化 Markdown + YAML Frontmatter；
3. 稳定 ID、状态校验、来源和关系；
4. `OnDiscussionEnd`、`OnTaskStart`、`OnTaskEnd`、`OnMilestoneComplete` 和可用情况下的 `OnContextCompact`；
5. exact ID、元数据过滤和全文检索；
6. milestone/dependency Trigger；
7. 受控 Promote 与回读；
8. 确定性 Reconcile；
9. 可重建派生索引；
10. 项目级权限、敏感信息拒绝与审计回执。

### 15.2 模型侧最小操作

```text
note_skills.capture
note_skills.search
note_skills.read
note_skills.update
note_skills.close
note_skills.promote
```

可保留 `note.create/search/read/update/close/promote` 作为底层或兼容命名，但对外概念建议统一为 `note_skills`。

### 15.3 建议目录

以下是新项目的默认建议。若仓库已有 ADR、Backlog、Worklog、事件日志或索引生成规则，应通过 Adapter 映射到现有位置，而不是机械复制本目录。

```text
<repo>/
├── .note-skills/
│   ├── README.md                 # 权威边界、使用规则、禁止事项
│   ├── config.yaml               # project_id、canonical adapters、策略
│   ├── schema/
│   │   └── note.schema.json
│   ├── notes/
│   │   ├── decisions/
│   │   ├── deferred/
│   │   ├── questions/
│   │   ├── assumptions/
│   │   ├── risks/
│   │   └── ideas/
│   └── index/                    # 全部可重建，不是 Source of Truth
│       ├── notes.json
│       └── triggers.json
├── tools/
│   └── note_skills/
│       ├── capture
│       ├── retrieve
│       ├── promote
│       ├── reconcile
│       └── validate
└── tests/
    └── note_skills/
```

目录规则：

- `notes/` 中的 Markdown 是 Memory 原始对象；
- `index/` 可删除并重建，不手工编辑；
- 正式规范、ADR、Issue、实验与 Evidence 继续留在项目原有 Canonical 路径；
- 不创建 `.note-skills/current.md`、第二套 Worklog 或第二个正式状态 Registry；
- Hook Receipt 优先写入项目既有事件/审计机制；
- 项目已有同类 Note 或决策目录时，优先复用并只增加 Schema/Adapter。

### 15.4 MVP 检索实现

第一版使用：

- 文件枚举；
- YAML 元数据过滤；
- ID 和关系查询；
- 全文关键词检索；
- 生成式查询扩展作为可选辅助。

第一版不要求：

- Embedding；
- Vector DB；
- Neo4j；
- 自动多跳语义规划；
- 自动知识图谱构建。

### 15.5 MVP 可执行不变量

1. 每条 Note 的 `(project_id, id)` 唯一；
2. `type` 与 `status` 组合必须合法；
3. 每条 Note 至少有一个有效 `source_ref`；
4. `accepted` Decision 必须有明确接受证据；
5. 每个 active Deferred Work 必须有 Trigger 或明确的人工复查日期/理由；
6. `supersedes` 链无环且同一 Decision 不存在多个未解释的 active revision；
7. `promoted` Note 必须有可回读目标与 `promotion_id`；
8. Canonical Target 必须有来源 backlink，或产生 Reconcile 错误；
9. 索引删除后可完整重建；
10. 默认 Retrieval 不返回 rejected、superseded、archived 对象；
11. Trigger 只读取可信 Canonical State 或事件；
12. Note 不得覆盖 Canonical Source；
13. 未通过安全策略的内容不得写入；
14. Hook 重试不生成重复 Note；
15. 失败、跳过和合并结果可审计，不得把失败报告为成功。

### 15.6 MVP 验收场景

| 场景 | 预期结果 |
| --- | --- |
| 讨论中说“P0 后考虑多 Agent” | 创建/更新 Deferred Work，含理由、Trigger 和来源 |
| 同一内容在下个会话再次出现 | 合并来源，不创建重复活动 Note |
| Canonical milestone 变为 P0 complete | Note 变为 due/ready，并在 Task Start 被检索 |
| 旧 Decision 被新 Decision 替代 | 默认只返回新 Decision，可沿链查看历史 |
| Idea Promote 到 Architecture | 目标写入、回读成功、双向链接完整、Note 标记 promoted |
| Promote 中途失败 | 不报告成功，Reconciler 能发现半完成状态 |
| Canonical 文件与 Note 冲突 | Canonical 优先，Note 标记 needs_review |
| 删除 index | 可从 Markdown 重建并获得相同活动对象集合 |
| Note 含 Secret 或敏感患者文本 | Capture 被拒绝或受控脱敏，不写入明文 |
| 历史 Note 含外部指令 | 作为不可信数据呈现，不改变 Agent 的系统权限或行为 |

### 15.7 推荐实施顺序

遵循“先需求与边界，再测试，再实现”：

1. 冻结目标、非目标、Canonical 映射、权限与敏感信息边界；
2. 冻结六类 Note Schema、状态机、Trigger 语义和 15 条不变量；
3. 先写正向、负向和故障恢复测试；
4. 实现文件存储、校验、ID 与可重建索引；
5. 实现 Capture 与 Retrieval；
6. 接入 Mandatory Hook；
7. 实现 Trigger、Promote 与 Reconcile；
8. 在一个 fixture/synthetic 项目上跨多个新会话验证；
9. 独立验证后再接入真实实验或生产开发流程。

---

## 16. 后续演进方向

### 16.1 P1：检索质量与规模

- 为大规模 Note 增加 Embedding/Vector 检索插件；
- 使用混合排序：结构化约束 + 关系 + 关键词 + 语义相似度；
- 学习用户对“相关/不相关”的反馈，但不改变权威规则；
- 自动生成跨 Note 的短期 Context Bundle。

### 16.2 P1：更强的 Prospective Memory

- 组合 Trigger DSL；
- 时间窗、冷却期和重复提醒策略；
- 条件满足后的用户确认与任务提案；
- 与 Milestone、Issue、CI、实验运行和发布事件连接；
- 识别“Trigger 永远不会满足”的过期提醒。

### 16.3 P1：Revision 与影响分析

- 对 Decision、Assumption 和定义性对象使用显式 revision；
- 自动计算受影响的 Spec、Task、Run、Evidence 和 Claim；
- 将依赖对象标记为 `stale` / `needs_review`；
- 提供历史时点查询与差异解释。

### 16.4 P2：事件溯源与图结构

- 在规模和审计需求明确后，将状态变化建模为 append-only events；
- 从事件重建 Note 当前投影；
- 以 Provenance DAG 支持正反向查询；
- 保持 Markdown 作为人类可读投影或导出格式。

事件溯源不能被新增为第二套竞争性全局日志；应复用项目已有事件系统，或先明确唯一事件根与迁移方案。

### 16.5 P2：多 Agent 与权限

- 多 Worker 并发提交 Capture Candidate；
- 基于 TaskSlice 的写入范围；
- Resident Agent 负责整合，Worker 只提交 ResultBundle/Candidate；
- 冲突合并、租约、幂等键和责任交接；
- 项目、团队和敏感等级的访问控制。

### 16.6 P2：可视化与人工治理

- Deferred Work 与 Trigger 时间线；
- Decision supersedes 图；
- Assumption/Risk 到实现或实验的影响图；
- Promote 队列与 Reconcile 报告；
- 人工接受、拒绝、推迟与批量复查界面。

UI 是派生视图，不持有唯一真值。

### 16.7 P3：跨项目联邦记忆

- 项目间只共享显式发布、脱敏和授权的 Note；
- 保留原项目 ID、来源和许可；
- 避免把一个项目的 Decision 错当成另一个项目的当前约束；
- 支持“模板化经验”与“项目事实”的明确分离。

---

## 17. 风险与缓解

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| 过度捕获 | Note 泛滥，检索噪声增加 | 只强制六类语义对象；要求 Trigger/Next Action；定期归档 |
| 捕获不足 | 关键 P1、理由或风险继续丢失 | Blocking Hook、失败回执、上下文压缩前检查 |
| 第二套真值 | Notes 与规范冲突 | authority 字段、Canonical precedence、Promote、Reconcile |
| 旧信息污染 | Agent 使用 superseded 方案 | 默认状态过滤、revision 链、冲突提示 |
| Trigger 误触发 | 错误提醒或过早行动 | Trigger 只读可信状态；激活不等于自动执行 |
| 模型误判 accepted | 未经确认的方案被当作决策 | 接受证据必填，Harness 验证，必要时 Human Gate |
| 索引漂移 | 搜不到已经存在的 Note | 索引全部可重建，Reconciler 对照原始 Note |
| Promote 半完成 | Note 与 Canonical 失配 | promotion_id、原子流程、回读、双向链接与恢复检查 |
| Prompt Injection | 历史 Note 改变 Agent 权限或目标 | Note 作为不可信数据；权威标签；工具权限由 Harness 决定 |
| 敏感信息泄露 | Secret、患者或个人信息进入 Git | Capture 前策略检查、脱敏、受控引用、项目权限 |
| Context 重新膨胀 | 检索结果挤占当前任务 | 两阶段读取、摘要预算、相关原因和 Top-K 限制 |
| 复杂度过早膨胀 | 系统建设超过实际价值 | Markdown/metadata/grep 起步，RAG/图谱/UI 后置 |

---

## 18. 待决策项

在进入实现前，项目需要明确：

1. 当前仓库中哪些文件分别是需求、架构、决策、任务、实验和结论的 Canonical Source；
2. 是否已有唯一 Worklog / Event Log，Hook Receipt 应接入哪里；
3. `.note-skills/` 是否是合适根目录，还是应复用已有目录；
4. 哪些 Decision 需要人类显式接受，接受证据采用什么格式；
5. 哪些 Hook 在当前 Agent Runtime 中可以真正阻塞；
6. Trigger 可读取哪些可信项目状态和事件；
7. 原始对话的可访问性、保存期限和最小引用策略；
8. 敏感信息、医疗数据和跨项目引用的禁止边界；
9. MVP 试点项目、fixture 数据与跨会话验收方式；
10. Promote 的目标映射、审批和回滚机制。

这些问题未冻结前，可以继续完善 Proposed 文档与测试设计，但不应声称 Note Skills 已经成为可靠的项目基础设施。

---

## 19. 必备主题覆盖检查

| 要求主题 | 覆盖章节 | 状态 |
| --- | --- | --- |
| 背景与问题定义 | §1 | 已覆盖 |
| 核心判断 | §3 | 已覆盖 |
| 设计原则 | §4 | 已覆盖 |
| 总体架构 | §6 | 已覆盖 |
| Memory 与 Source of Truth 区分 | §5、§7 | 已覆盖 |
| Note 数据模型 | §8 | 已覆盖 |
| Mandatory Capture 类型 | §9 | 已覆盖 |
| Hook 机制 | §10 | 已覆盖 |
| 检索 | §11.1–§11.5 | 已覆盖 |
| Trigger-based Retrieval | §11.6–§11.8 | 已覆盖 |
| Promote | §12 | 已覆盖 |
| Reconcile | §13 | 已覆盖 |
| Provenance | §14 | 已覆盖 |
| MVP 能力 | §15 | 已覆盖 |
| 文件目录建议 | §15.3 | 已覆盖 |
| 后续演进方向 | §16 | 已覆盖 |

---

## 20. 结论

超长程任务连续性的关键，不是让模型永远保留全部上下文，而是让重要但尚未成为正式真值的信息拥有明确的捕获、检索、触发、提升、替代和追溯机制。

因此，本项目不应只实现一个“模型觉得有必要时才调用”的 Notes Skill，而应实现四个相互约束的层次：

```text
Model-facing Note Skills Skill
  + Mandatory Harness Hooks and Gates
  + Searchable Note Skills Store
  + Promote / Reconcile / Provenance lifecycle
```

Note Skills 保存项目历史与未来意图；Canonical Source 保存项目当前真值。只有在这一边界稳定、Hook 可执行、Retrieval 能重新激活、Promote 不产生第二套真值、Reconcile 能发现漂移时，Agent 才真正具备与人一起工作数月的连续性。

本文件当前是 **Proposed 架构基线**。它完成了设计讨论的结构化整理，但不构成实现完成、运行验证或生产可用性证明。
