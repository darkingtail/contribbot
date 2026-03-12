---
name: contribbot:todo
description: "Todo 全生命周期管理：查看、添加、详情、更新、完成、删除、归档。触发词：'todo'、'任务列表'、'添加任务'、'完成任务'、'归档'。"
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
| 完成任务 | done | `todo_done` |
| 删除任务 | delete | `todo_delete` |
| 归档 | archive | `todo_archive` |

---

## list

调用 `todo_list`，参数：`repo`，可选 `status` 过滤。

---

## add

调用 `todo_add`，参数：
- `repo`
- `text`：任务描述
- `ref`（可选）：GitHub issue 编号，自动拉取 issue 信息并从 labels 推断 type

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
