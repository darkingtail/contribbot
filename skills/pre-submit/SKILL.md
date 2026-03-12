---
name: contribbot:pre-submit
description: "提交前检查：审查 PR 变更、CI 状态、review 评论、安全告警，确认合并就绪。触发词：'pre-submit'、'提交检查'、'合并前检查'。"
metadata:
  author: darkingtail
  version: "3.0.0"
  argument-hint: <owner/repo> <pr_number>
---

# Pre-Submit — 提交前检查

通过 MCP 工具对 PR 做合并前全面检查。

## 前置

- 用户提供 `repo`（owner/repo 格式）和 `pr`（PR 编号）。如未提供，询问。

## 步骤

### 1. PR 概览

调用 `pr_summary`，参数：`repo`、`pr_number`。

确认 PR 描述清晰、变更范围合理。

### 2. Review 评论检查

调用 `pr_review_comments`，参数：`repo`、`pr_number`。

逐条检查：
- 是否有未回复的评论
- 是否有 CHANGES_REQUESTED 未解决
- 如需回复：调用 `pr_review_reply`（repo、pr_number、comment_id、body）

### 3. CI 状态

调用 `actions_status`，参数：`repo`。

确认所有 required checks 通过。

### 4. 安全检查

调用 `security_overview`，参数：`repo`。

确认无 critical/high 级别未处理告警。

### 5. Todo 关联

调用 `todo_list`，参数：`repo`。

查找关联该 PR 的 todo，如有且 status 未更新：
→ 调用 `todo_update`（repo、item、status=pr_submitted、pr={pr_number}）

### 6. 输出报告

```
## Pre-Submit Report — {repo} PR #{pr}

| 检查项 | 状态 | 详情 |
|--------|------|------|
| PR 描述 | pass/warn | {备注} |
| Review 评论 | pass/warn/fail | {N 条未回复} |
| CI 状态 | pass/fail | {check 名称和状态} |
| 安全告警 | pass/warn | {N 条告警} |
| Todo 关联 | pass/skip | {todo ref} |

### 合并就绪度: Ready / Not Ready

{如 Not Ready，列出阻塞项}
```
