---
name: contribbot:pre-submit
description: "提交前检查：审查 PR 变更、CI 状态、review 评论、安全告警，确认合并就绪。触发词：'pre-submit'、'提交检查'、'合并前检查'。"
metadata:
  author: darkingtail
  version: "2.0.0"
  argument-hint: <owner/repo> <pr_number>
---

# Pre-Submit — 提交前检查

PR 合并前的全面检查清单。

数据格式参考：`references/data-format.md`

## 前置

- 用户提供 `repo`（owner/repo 格式）和 `pr`（PR 编号）。如未提供，询问。
- 需要 `gh` CLI 已认证。

## 步骤

### 1. PR 概览

```bash
gh pr view {pr} -R {owner}/{repo} --json number,title,body,files,additions,deletions,state,isDraft
```

确认 PR 描述清晰、变更范围合理。

### 2. Review 评论检查

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/reviews --jq '.[] | {user: .user.login, state: .state, body: .body}'
gh api repos/{owner}/{repo}/pulls/{pr}/comments --jq '.[] | {id: .id, user: .user.login, body: .body, path: .path, line: .line}'
```

逐条检查：
- 是否有未回复的评论
- 是否有 CHANGES_REQUESTED 未解决
- 如需回复：
  ```bash
  gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies -f body="..."
  ```

### 3. CI 状态

```bash
gh pr checks {pr} -R {owner}/{repo}
```

确认所有 required checks 通过。

### 4. 安全检查

```bash
gh api repos/{owner}/{repo}/dependabot/alerts --jq '[.[] | select(.state=="open")] | length'
```

确认无 critical/high 级别未处理告警。

### 5. Todo 关联（如有）

读取 `~/.contribbot/{owner}/{repo}/todos.yaml`，查找关联该 PR 的 todo。如有，更新 status 为 `pr_submitted`、设置 pr 字段、更新日期，写回文件。

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
