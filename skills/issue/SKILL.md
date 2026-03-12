---
name: contribbot:issue
description: "Issue 管理：浏览、查看详情、创建、关闭、评论。触发词：'issue'、'问题列表'、'创建 issue'、'关闭 issue'。"
metadata:
  author: darkingtail
  version: "3.0.0"
  argument-hint: <owner/repo> [action] [args...]
---

# Issue — Issue 管理

通过 MCP 工具管理 Issues。

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。

## 动作路由

根据用户意图分流（如不明确，默认 **list**）：

| 意图 | 动作 | MCP 工具 |
|------|------|----------|
| 浏览 issues | list | `issue_list` |
| 查看详情 | detail | `issue_detail` |
| 创建 issue | create | `issue_create` |
| 关闭 issue | close | `issue_close` |
| 写评论 | comment | `comment_create` |

---

## list

调用 `issue_list`，参数：
- `repo`
- `state`（可选）：open / closed，默认 open
- `labels`（可选）：按标签过滤
- `query`（可选）：关键词搜索

---

## detail

调用 `issue_detail`，参数：`repo`、`issue_number`。

---

## create

调用 `issue_create`，参数：
- `repo`
- `title`
- `body`（可选）
- `labels`（可选）
- `auto_todo`（可选）：是否自动创建对应 todo
- `upstream_sha`（可选）：关联的 upstream commit SHA
- `upstream_repo`（可选）：upstream commit 来源

创建后如有 `auto_todo`，工具会自动创建对应 todo。
如有 `upstream_sha`，工具会自动更新对应 upstream commit 状态。

---

## close

调用 `issue_close`，参数：
- `repo`
- `issue_number`
- `comment`（可选）：关闭时附加评论
- `todo_item`（可选）：同时标记对应 todo 为 done

---

## comment

调用 `comment_create`，参数：
- `repo`
- `issue_number`
- `body`
