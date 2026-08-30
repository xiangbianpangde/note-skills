# Lifecycle — Gate、检索、Trigger、Promote、Reconcile

SKILL.md 的步骤 2–5 引用本文件。

## 1. Capture Gate 流程

```text
收集候选 → 分类（六类）→ 安全检查 → 去重 → 规范化字段与来源
→ 校验（必填字段、状态合法、ID 唯一）→ 写入 → 更新 receipt
```

- 每条候选结果只能是 `captured`（新建或合并）或 `skipped`（含理由）；六类各自记 `none` 表示讨论中未出现。
- 去重：先取确定性候选集（同 project、同 type、关联同一对象、处于活动状态），再语义判断是否同一对象。合并只追加来源/关系/新信息，不改写旧 rationale；语义实质变化时用 `supersedes` 建 revision。
- 幂等：同一讨论重复执行 Gate 不得产生重复 note；重试时先查已有对象。
- 持久化：agent_end 钩子把候选写成 `.project-memory/pending/<envelope>.json`（脱敏摘要 + 来源引用 + 哈希）；capture/acknowledge 必须带 `candidate_ids` 逐条解析。
- 写入失败：如实记入 receipt 的 `errors`，不得报成功；不无限重试。

## 2. 检索流程（任务开始）

1. 查询优先级：到期 trigger → 精确 ID → 结构化过滤（type/status/priority/tags）→ 与当前 `event.prompt` 词项的相关性排序（加权字段评分，旧但相关的笔记优先）→ 全文关键词。
2. 默认过滤终态与 `superseded`/`rejected`/`archived`。
3. 两阶段读取：第一阶段只注入摘要 envelope；按需再展开全文；原始讨论仅在需要判断理由或歧义时展开。

Result Envelope 必含字段：`id`、`type`、`status`、`review_status`、`authority`、`relevance_reason`（非空）、`summary`、`next_action`、`source_refs`、`canonical_conflict`。`canonical_conflicts` 适配器输出（来自 canonical state 文件，非笔记自述）会把命中置为 `needs_review`，但不改写笔记生命周期状态。

预算：第一阶段注入总量保持在小型任务可承受范围（经验值 ≤ 数 KB），防止记忆层本身成为上下文噪声。

## 3. Trigger 模型

- 条件种类：`milestone`（里程碑状态）、`dependency`（对象状态）、`component`（模块/文件重新进入活动范围）、`date`（到期复查）、`event`（可信项目事件）。
- 条件值只读 canonical 状态或可信事件；note 不得自己声称条件已满足并自我触发。
- 条件满足 → note 标记 `due`/`ready`，在下次任务开始或事件处理时呈现；呈现 ≠ 自动执行。
- 依赖缺失、状态含义不明、版本无法确定 → 不猜，标记 `needs_review` 并说明缺失对象。

## 4. Promote 事务

```text
1. 确定 source note 与当前 revision
2. 确定 canonical 目标与治理规则
3. 生成精确 diff 或新对象草稿
4. 校验权限、依赖与冲突
5. planPromotion() 生成精确 before/after 字节与 SHA-256，并在 Pi UI 展示完整目标内容
6. 获得用户直接 UI 确认后，记录一次性内容绑定 approval_ref（before_sha256/after_sha256/目标/模式/载荷哈希），明确写入模式：新对象用 `append_block`；已有定义用 `replace_file` + 完整批准内容
7. promote() 在 approval+note+target 三重锁内 CAS 校验目标未变、消费 approval_ref、原子写入 canonical；禁止以追加方式修改已有定义并留下新旧两段
8. 回读目标 ID/版本/哈希
9. note 置 status=promoted、promotion 记录目标与 promotion_id
10. 目标加 derived_from=<note ID> 双向链接
11. 重建索引并跑 Reconcile
```

不变量：目标或写入模式不明不自动新建/修改规范；目标在批准后被并发改写 = CONFLICT 且不覆盖；只改 note 状态但未成功写入并回读目标 = 失败；同一 `promotion_id` 重试不产生重复对象；同一 `approval_ref` 只能消费一次；不同 Note 并发 Promote 到同一目标只能有一个成功；promote 后 note 保留历史但停止作为活动建议。Capture/Promote 的确定性 receipt 必须绑定真实 `tool_call_id`，模型自述不算工具证据。

## 5. Reconcile

- 检查：ID 重复、类型/状态不匹配、必填缺失、`supersedes` 成环、同 decision 多 active revision、来源失效、`promoted_to` 目标缺失、索引与 note 不一致、note 与 canonical 冲突、trigger 已满足但长期未处理。
- 时机：项目打开、任务开始/结束、canonical 变更后、promote 前后。
- 自动修复仅限可重建派生物（索引、缓存、确定性 backlink）；对 canonical 的修改只能建议。
- `stale`/`needs_review` 表示需复核，不表示内容错误或结论被推翻。

## 6. 跨会话恢复

新会话打开项目时：确认 project_id 与记忆根 → 读取未完成 receipt 与 needs_review 项 → 执行 SKILL.md 步骤 1 的检索 → 在答复中列出"已恢复哪些记忆、各自来源与权威级别"。原始对话不可访问时，以 note 正文保存的最小语义为准，不得虚构来源。

## 7. 能力边界：模型行为 vs Harness 可硬保证

| 项 | 谁保证 |
| --- | --- |
| 识别候选、分类、写 rationale/trigger | 模型（语义判断，非确定） |
| Gate 检查点执行、receipt 如实报告 | 模型行为约定 + 钩子提醒 |
| ID 唯一、schema 校验、原子写入、索引重建、去重指纹、幂等键 | 只有确定性工具/脚本可硬保证；无工具时由模型自查并在 receipt 声明未验证 |
| trigger 条件求值 | 读 canonical 状态的确定性逻辑 |
| promote 写入与回读 | 编辑工具 + 用户批准记录 |

没有确定性脚本支撑时，不要声称"系统保证了唯一性/事务性"，只能在 receipt 中说明为模型自查结果。
