---
name: contribbot:todo
description: "Todo 全生命周期管理：查看、添加、详情、推进执行、更新、领取、完成、取消、删除、归档。触发词：'todo'、'任务列表'、'添加任务'、'任务进度'、'领取任务'、'完成任务'、'取消任务'、'归档'。"
metadata:
  author: darkingtail
  version: "3.0.0"
  argument-hint: <repository> [action] [args...]
---

# Todo — 任务日常管理

通过 MCP 工具管理 todo 全生命周期。

当前源码只接受 `idea/backlog/active/paused/done/cancelled`，PR 进度独立。
旧 Todo 状态 `pr_submitted` / `not_planned` 的读写均拒绝，不自动转换。

## 已启用版本化执行的 Todo

首次检查本地执行能力时，先读 [执行入口发现](references/execution.md#执行入口发现)。
开发态入口随本 Skill 提供，不以 PATH 中没有 `contribbot-exec` 就认定缺失，
也不使用 Python 的 `uv tool list` 判断 Node 工具是否可用。

已有 managed workflow 时，先用 `todo_context` / `todo_resume` 读取稳定 Todo ID、
execution ID、方案和恢复建议，再读 [执行闭环](references/execution.md)。
不要用 `todo_progress` 或省略 completion 的 `todo_done` 替代 managed 验收或收尾。
无 workflow 的任务使用下面的非受管入口，不冒充“已验证”。
若当前连接没有这些工具，说明运行时能力不足，不捏造调用或静默改 YAML。

## 前置

- 从已确认的会话项目或用户线索取得完整 `{platform, instance, path}`；
  每次仓库范围 MCP 工具显式传该对象。无法核实目标时再问用户。

## 动作路由

根据用户意图分流（如不明确，默认 **list**）：

| 意图 | 动作 | MCP 工具 | 备注 |
|------|------|----------|------|
| 查看任务 | list | `todo_list` | 包含终态未归档 |
| 添加任务 | add | `todo_add` | 记录不等于实施授权 |
| 查看详情 | detail | `todo_detail` | 历史不等于当前验证 |
| 更新任务 | update | `todo_update` | 不能绕过重开/收尾 |
| 推进执行 | progress | `todo_progress` | managed 按执行闭环分流 |
| 暂缓或取消受管执行 | control | `todo_control` | 只受理明确决定；不冒充进程已停止 |
| 领取子任务 | claim | `todo_claim` | GitHub 公开操作须授权 |
| 取消未开工或非受管任务 | cancel | `todo_cancel` | 精确稳定 ID、生命周期版本和明确决定；不自动归档 |
| 完成任务 | done | `todo_done` | 不自动归档 |
| 恢复展示 | restore | `todo_restore` | 保留终态，不启动执行 |
| 重新打开 | reopen | `todo_reopen` | 回到 backlog，不启动执行 |
| 删除任务 | delete | `todo_delete` | 明确确认破坏性操作 |
| 归档 | archive | `todo_archive` | 预览后明确选定快照 |
| 清理归档 | compact | `todo_compact` | 与归档不同，会删除历史 |
| 请求顾问意见 | consult | `consult_prepare/request/status/read/decide` + Runner | 读取相邻 `consult/SKILL.md`；建议不算验收，不自动变更任务 |

---

## list

调用 `todo_list`，参数：`repo`，可选 `status` 过滤。

---

## add

调用 `todo_add`，参数：
- `repo`
- `text`：任务描述
- `ref`（可选）：GitHub issue 编号，自动拉取 issue 信息并从 labels 推断 type

注意：ref 不可与已有 todo 重名（实现文档以 ref 命名，重名会覆盖）。自动生成的 slug ref 已有去重逻辑，手动传 ref 时需确认唯一。

添加完成后，根据对话上下文判断用户是否已有实现想法、设计思路或技术方案：
- **有** → 先展示想法摘要给用户确认，确认后调用 `todo_update(note=想法摘要)` 记录到实现文档，告知已记录 + 文档路径。
- **无** → 仅添加。

---

## detail

调用 `todo_detail`，参数：`repo`、`item`（列表全局编号、完整 ref、精确标题或标题关键词）。优先使用完整 ref，避免标题歧义。

返回实现记录及关联 PR 的独立进度、观察时间和来源。每次最多只读查询 20 个 PR，
并发上限 4；未读取或失败项明确标为 unknown，不当作关闭或合并。
PR 观察不是验收证据，不自动完成、取消或归档 Todo；现有 PR review 反馈继续刷新。
用户报告 PR 已合并时先保留“据报告已合并，待核实”及来源，不改写为已核实。
显式计划远端交付由本地 `inspect`/收尾入口现场查询并核对 scoped 内容，
不是使用本节的 PR 详情缓存。具体声明和限制见执行参考。

只恢复到普通列表，用稳定 ID 调用 `todo_restore`，保留结束状态。
明确重新打开用 `todo_reopen`，回到 backlog 但不创建执行。
用户明确“重开并继续工作”时，可用稳定 ID 调用 `todo_activate` 一次编排；
仅查看或恢复历史不授予开工权限。不要重新添加同名 Todo。

---

## update

调用 `todo_update`，参数：
- `repo`、`item`（列表全局编号、完整 ref、精确标题或标题关键词）
- 可选字段：`status`、`pr`、`branch`、`note`

常见场景：
- 关联 PR：`pr=285`，追加关联、保留原有 PR，不改变主状态
- 设置分支：`branch=fix/281`
- 改状态：用户明确推进到待办时使用 `status=backlog`

`status` 仅可写 `idea/backlog/active`；旧状态在任何写入前拒绝。
来源/参考 PR 不自动成为必须完成的交付项。

不要用 `todo_update(status=done)` 完成任务；用 `todo_done` 关闭执行并保留终态未归档。
终态不能借 PR 关联或状态更新复活，必须明确重新打开。

---

## progress

调用 `todo_progress`，参数：
- `repo`、`item`
- 可选 `phase`：`understand / execute / check / finish`
- 可选 `next`：下一次恢复时应直接执行的动作
- 可选 `blocked_on`：阻塞项；传 `null` 清除
- 可选 `evidence`：追加来源、定位符、观察时间、摘要和候选 revision

每次完成一个有意义的执行单元后更新。`revision / test / worktree` 类型 Evidence 必须带 `revision`。

---

## claim

领取 issue 中的工作项，发布评论到 GitHub 通知其他维护者。

调用 `todo_claim`，参数：
- `repo`、`item`（列表全局编号、完整 ref、精确标题或标题关键词）
- `items`：要领取的工作项描述数组

流程：
1. 先确保 todo 已 activate（有 issue 详情）
2. 从 issue 内容中识别可领取的工作项（子任务、表格行、职责范围等，由 LLM 判断）
3. 让用户选择要领取的项
4. 调用 `todo_claim` 发布评论 + 本地记录

评论模板保存在当前项目的 v3 数据目录 `templates/todo_claim.md`；
不要从 `owner/repo` 猜目录。

---

## cancel

未开工或非受管 Todo：先用 `todo_context(repo, todo_id)` 读取精确稳定 ID 与
`todo.lifecycle_revision`（缺省为 `0`，不是 `workflow_revision`），不为取消先激活。
调用 `todo_cancel(repo, todo_id, expected_lifecycle_revision, decision)`，记录真实用户决定。
锁内核对身份与版本；版本变化需重读并重新确认，不猜测新版本。
结果为 `cancelled` 未归档；没有执行时不补造执行，已有普通执行以 `abandoned` 结束。
不回滚代码、不操作 GitHub；当前受管执行必须走下面的 control 路径。

## control

受管执行中用户明确暂停/取消时，用 `todo_control` 保存
`request_control`，携带稳定 Todo/execution ID、请求 ID、精确 revision、
control_id、pause/cancel、真实 decision 和 note。停止请求不等于安全停止，
不强杀进程、不回滚、不归档，也不关闭 Issue。
先观察、恢复并处置原操作；本地 `settle-pause` 核实后才是 paused。
明确继续/撤回停止用本地 `continue`，同轮恢复但需要新的 yield 和适用检查；
`todo_resume` 仍只读上下文/修复文档，不会恢复派工。
明确取消先记录 `kind=cancel`，再以匹配 decision 的本地 stopped 收尾记为 cancelled。
源码能力是否已连接须实际核实；缺能力时报告限制，不回退旧状态或静默改 YAML。
旧写入器不能和这些新字段共用实时数据根，开发验证使用隔离数据。

---

## done

先完成已授权且可执行的检查与审阅，再汇总当前成果、实际缺口和需要用户判断的内容。
缺少完成决定时结合结果询问一次；待评价结果已存在、其余收尾条件已满足，
且用户明确验收整项并要求结束时，同一条真实反馈可以支持其实际观察并评价的
人工验收对象和完成决定。先记录有依据的反馈，再核对全部门禁后完成，
不机械再问“是否 done”，也不要求用户照抄固定口令。不代填未观察的其他人工项，
但一条反馈确实覆盖多项时不用拆成多次确认。
方案确认、阶段认可或检查全绿不能替代整项完成决定。

managed Todo 使用执行闭环的本地 `close` 或带 `completion` 的 `todo_done`；
关联 Issue 关闭也必须携带同一完整收尾意图。具体参数与恢复边界见
[一次验收与完成](references/execution.md#一次验收与完成)及执行参考。
提前表达完成但缺少本轮真实结果时，应说明缺项，不补造人工通过，
也不自动消费“以后测试通过就完成”的条件授权。以下为非受管路径。

调用 `todo_done`，参数：`repo`、`item`（列表全局编号、完整 ref、精确标题或标题关键词）。

完成结果返回稳定 Todo ID，普通列表保留已完成未归档，且不计入待做。
重试 managed 完成使用原完整意图；不要因失败移除 completion 走非受管入口。

如果 todo 有关联 issue，询问是否同时关闭：
→ 是：调用 `issue_close`，参数：`repo`、`issue_number`

---

## delete

调用 `todo_delete`，参数：`repo`、`item`（列表全局编号、完整 ref、精确标题或标题关键词）。

展示条目信息，**确认后**执行删除。有执行历史时，确认后传 `force=true`；默认拒绝删除历史。

---

## archive

先调用 `todo_archive(repo)`，只预览、不写入。

用户确认具体范围后，只把所选条目的 `todo_id` 与 `snapshot` 作为 `selections` 传回。
空数组不操作；快照变化先重新展示并确认，不自动归档后来新增的终态。
缺稳定 ID 的旧终态可经明确决定用 `prepare=true` 分配身份并重新预览，不能同时归档。
逐项报告结果；部分成功不说整批成功。归档失败不撤销完成，也不重跑执行。
当前显式归档中断时，按原 `todo_id/snapshot` 选择重试；恢复展示中断按原请求处理。
不再恢复旧完成/归档合并请求，也不把已有标记本身当作新的用户许可。
完成不必每次催问归档；用户不答复就保留原记录。

---

## compact

调用 `todo_compact`，参数：
- `repo`
- `before`（日期）或 `keep`（条数），二选一
- `force`：删除含执行历史的归档时必须显式传 `true`，且需要先确认

不传参数时显示归档统计和含执行历史的条数，让用户决定清理策略。
