---
name: contribbot:pr
description: "PR 管理：浏览、摘要、创建、更新、查看 review 评论、回复 review。触发词：'pr'、'pull request'、'创建 PR'、'回复 review'。"
metadata:
  author: darkingtail
  version: "3.0.0"
  argument-hint: <owner/repo> [action] [args...]
---

# PR — Pull Request 管理

通过 MCP 工具管理 Pull Requests。

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。

## 动作路由

根据用户意图分流（如不明确，默认 **list**）：

| 意图 | 动作 | MCP 工具 |
|------|------|----------|
| 浏览 PRs | list | `pr_list` |
| PR 摘要 | summary | `pr_summary` |
| 创建 PR | create | `pr_create` |
| 更新 PR | update | `pr_update` |
| 查看 review | reviews | `pr_review_comments` |
| 回复 review | reply | `pr_review_reply` |

---

## list

调用 `pr_list`，参数：
- `repo`
- `state`（可选）：open / closed / merged，默认 open
- `query`（可选）：关键词搜索

---

## summary

调用 `pr_summary`，参数：`repo`、`pr_number`。

返回：author、status、变更文件、CI checks、reviews、mergeable。

---

## create

调用 `pr_create`，参数：
- `repo`
- `title`
- `head`（可选）：源分支
- `base`（可选）：目标分支
- `body`（可选）
- `draft`（可选）
- `todo_item`（可选）：关联 todo ref，自动更新 todo 状态为 pr_submitted

---

## update

调用 `pr_update`，参数：
- `repo`
- `pr_number`
- 可选字段：`title`、`body`、`state`、`draft`

---

## reviews

调用 `pr_review_comments`，参数：`repo`、`pr_number`。

返回每条评论的 ID、文件、行号、内容、作者。

---

## reply

先调用 `pr_review_comments` 获取评论列表，让用户选择要回复的评论。

然后调用 `pr_review_reply`，参数：
- `repo`
- `pr_number`
- `comment_id`
- `body`
