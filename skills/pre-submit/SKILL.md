---
name: contribbot:pre-submit
description: "提交前检查：审查 PR 变更、CI 状态、review 评论、安全告警，确认合并就绪。触发词：'pre-submit'、'提交检查'、'合并前检查'。"
metadata:
  author: darkingtail
  version: "1.0.0"
  argument-hint: <owner/repo> <pr_number>
---

# Pre-Submit — 提交前检查

PR 合并前的全面检查清单。需要 contribbot MCP Server。

## 前置

- 用户提供 `repo`（owner/repo 格式）和 `pr`（PR 编号）。如未提供，询问。

## 步骤

### 1. PR 概览

```
pr_summary(repo, pr) → PR 描述、变更文件、diff 统计
```

确认 PR 描述清晰、变更范围合理。

### 2. Review 评论检查

```
pr_review_comments(repo, pr) → 所有 review 评论（ID、diff、内容）
```

逐条检查：
- 是否有未回复的评论
- 是否有 requested changes 未解决
- 如有需要回复的，使用 `pr_review_reply(repo, pr, comment_id, body)` 回复

### 3. CI 状态

```
actions_status(repo) → CI 运行结果
```

确认：
- 所有 required checks 通过
- 无 failing workflow

### 4. 安全检查

```
security_overview(repo) → 安全告警
```

确认：
- 本次 PR 未引入新的安全告警
- 无 critical/high 级别未处理告警

### 5. Todo 关联（如有）

如果该 PR 关联了 todo，确认 todo 状态已更新：

```
todo_update(repo, item, status="pr_submitted", pr=pr_number)
```

### 6. 输出报告

```
## Pre-Submit Report — {repo} PR #{pr}

| 检查项 | 状态 | 详情 |
|--------|------|------|
| PR 描述 | pass/warn | {备注} |
| Review 评论 | pass/warn/fail | {N 条未回复} |
| CI 状态 | pass/fail | {workflow 名称和状态} |
| 安全告警 | pass/warn | {N 条告警} |
| Todo 关联 | pass/skip | {todo ref} |

### 合并就绪度: Ready / Not Ready

{如 Not Ready，列出阻塞项}
```
