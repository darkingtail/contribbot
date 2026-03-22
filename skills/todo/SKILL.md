---
name: contribbot:todo
description: "Todo 全生命周期管理：查看、添加、详情、更新、领取、完成、删除、归档。触发词：'todo'、'任务列表'、'添加任务'、'领取任务'、'完成任务'、'归档'。"
metadata:
  author: darkingtail
  version: "3.0.0"
  argument-hint: <owner/repo> [action] [args...]
---

# Todo — 任务日常管理

通过 MCP 工具管理 todo 全生命周期。

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。

## 动作路由

根据用户意图分流（如不明确，默认 **list**）：

| 意图 | 动作 | MCP 工具 |
|------|------|----------|
| 查看任务 | list | `todo_list` |
| 添加任务 | add | `todo_add` |
| 查看详情 | detail | `todo_detail` |
| 更新任务 | update | `todo_update` |
| 领取子任务 | claim | `todo_claim` |
| 不做了 | not_planned | `todo_update(status=not_planned)` |
| 完成任务 | done | `todo_done` |
| 删除任务 | delete | `todo_delete` |
| 归档 | archive | `todo_archive` |
| 清理归档 | compact | `todo_compact` |

---

## list

调用 `todo_list`，参数：`repo`，可选 `status` 过滤。

---

## add

调用 `todo_add`，参数：
- `repo`
- `text`：任务描述
- `ref`（可选）：GitHub issue 编号，自动拉取 issue 信息并从 labels 推断 type

添加完成后，根据对话上下文判断用户是否已有实现想法、设计思路或技术方案：
- **有** → 调用 `todo_update(note=想法摘要)` 记录到实现文档。输出简短摘要（1-2 句话），告知用户已记录到文档，附文档路径。
- **无** → 仅添加。

---

## detail

调用 `todo_detail`，参数：`repo`、`item`（ref 编号）。

返回实现记录 + 自动刷新 PR review 状态。

---

## update

调用 `todo_update`，参数：
- `repo`、`item`（ref 编号）
- 可选字段：`status`、`pr`、`branch`、`note`

常见场景：
- 关联 PR：`pr=285`
- 设置分支：`branch=fix/281`
- 改状态：`status=pr_submitted`

---

## claim

领取 issue 中的工作项，发布评论到 GitHub 通知其他维护者。

调用 `todo_claim`，参数：
- `repo`、`item`（ref 编号）
- `items`：要领取的工作项描述数组

流程：
1. 先确保 todo 已 activate（有 issue 详情）
2. 从 issue 内容中识别可领取的工作项（子任务、表格行、职责范围等，由 LLM 判断）
3. 让用户选择要领取的项
4. 调用 `todo_claim` 发布评论 + 本地记录

评论模板可通过 `~/.contribbot/{owner}/{repo}/templates/todo_claim.md` 文件自定义。

---

## not_planned

调用 `todo_update`，参数：`repo`、`item`、`status=not_planned`。

标记为"决定不做"，自动归档到 `todos.archive.yaml`。

---

## done

调用 `todo_done`，参数：`repo`、`item`（ref 编号）。

如果 todo 有关联 issue，询问是否同时关闭：
→ 是：调用 `issue_close`，参数：`repo`、`issue_number`

---

## delete

调用 `todo_delete`，参数：`repo`、`item`（ref 编号）。

展示条目信息，**确认后**执行删除。

---

## archive

调用 `todo_archive`，参数：`repo`。

将所有 done 状态的 todo 移入归档。

---

## compact

调用 `todo_compact`，参数：
- `repo`
- `before`（日期）或 `keep`（条数），二选一

不传参数时显示归档统计，让用户决定清理策略。
