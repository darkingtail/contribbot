---
name: contribbot:pr
description: "PR 管理：浏览、摘要、创建、更新、查看 review 评论、回复 review。触发词：'pr'、'pull request'、'创建 PR'、'回复 review'。"
metadata:
  author: darkingtail
  version: "1.0.0"
  argument-hint: <owner/repo> [action] [args...]
---

# PR — Pull Request 管理

浏览、创建、更新 PR，查看和回复 review 评论。

数据格式参考：`references/data-format.md`

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。
- 需要 `gh` CLI 已认证。

## 动作路由

根据用户意图分流（如不明确，默认 **list**）：

| 意图 | 动作 | 示例 |
|------|------|------|
| 浏览 PRs | list | "看看 PRs" |
| PR 摘要 | summary | "看看 #285 的情况" |
| 创建 PR | create | "提个 PR"、"创建 pull request" |
| 更新 PR | update | "更新 PR 标题" |
| 查看 review | reviews | "review 评论"、"看看别人怎么说" |
| 回复 review | reply | "回复 review" |

---

## list — 浏览 PRs

```bash
gh pr list -R {owner}/{repo} --state {state} --json number,title,state,createdAt,author,headRefName,isDraft --limit 30
```

### 参数

- `state`（可选）：open / closed / merged / all，默认 open。
- `query`（可选）：关键词搜索。

### 输出

```
## Pull Requests — {owner}/{repo}（{state}）

| # | Title | Author | Branch | Draft | Created |
|---|-------|--------|--------|-------|---------|
| 285 | fix: 修复 XXX | user1 | fix/281 | No | 2026-03-05 |

共 {n} 条
```

---

## summary — PR 摘要

```bash
gh pr view {number} -R {owner}/{repo} --json number,title,body,author,state,headRefName,baseRefName,files,reviews,comments,statusCheckRollup,mergeable,isDraft
```

### 输出

```
## PR #{number} — {title}

**作者**: {author} | **状态**: {state} | **Draft**: {isDraft}
**分支**: {head} → {base} | **Mergeable**: {mergeable}

### 变更文件（{count} files）
| File | Additions | Deletions |
|------|-----------|-----------|
| src/foo.ts | +20 | -5 |

### Reviews
| Reviewer | State | 备注 |
|----------|-------|------|
| reviewer1 | APPROVED | |
| reviewer2 | CHANGES_REQUESTED | 需修改 |

### CI Checks
| Name | Status | 备注 |
|------|--------|------|
| build | pass | |
| test | fail | 需修复 |

### 关联
- Todo: {如在 todos.yaml 中有 pr={number} 的条目}
```

---

## create — 创建 PR

### 参数

- `title`（必须）：PR 标题。
- `head`（可选）：源分支，默认当前分支。
- `base`（可选）：目标分支，默认仓库默认分支。
- `body`（可选）：PR 描述。
- `draft`（可选）：是否为草稿，默认否。
- `todo_ref`（可选）：关联的 todo ref。

### 步骤

1. 创建 PR：
```bash
gh pr create -R {owner}/{repo} --title "{title}" --head "{head}" --base "{base}" --body "{body}" {--draft}
```

2. 如有 `todo_ref`：更新 todos.yaml 中对应条目的 `pr` 字段为新 PR 编号，`status` 改为 `pr_submitted`，更新 `updated`。

### 输出

```
## Created — {owner}/{repo}

PR #{number}: {title}
URL: https://github.com/{owner}/{repo}/pull/{number}
分支: {head} → {base}
{如 draft} 草稿模式
{如 todo_ref} Todo #{todo_ref} 已关联，状态更新为 pr_submitted
```

---

## update — 更新 PR

### 参数

- `number`（必须）：PR 编号。
- 可更新字段：`title`、`body`、`state`（open/closed）、`draft`（true/false）。

### 步骤

更新标题/描述：
```bash
gh pr edit {number} -R {owner}/{repo} --title "{title}" --body "{body}"
```

关闭 PR：
```bash
gh pr close {number} -R {owner}/{repo}
```

标记为 ready：
```bash
gh pr ready {number} -R {owner}/{repo}
```

### 输出

```
## Updated — {owner}/{repo}

PR #{number}: {title}
  {field}: {old} → {new}
```

---

## reviews — 查看 Review 评论

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments --jq '.[] | {id: .id, path: .path, line: .line, body: .body, user: .user.login, created_at: .created_at, in_reply_to_id: .in_reply_to_id}'
```

### 输出

```
## Review Comments — PR #{number}

| ID | File | Line | Reviewer | Comment | Reply To |
|----|------|------|----------|---------|----------|
| 123 | src/foo.ts | 42 | reviewer1 | 这里需要处理边界情况 | — |
| 124 | src/foo.ts | 42 | author | 已修复 | #123 |

共 {n} 条评论，{unresolved} 条未解决
```

---

## reply — 回复 Review 评论

### 参数

- `number`（必须）：PR 编号。
- `comment_id`（必须）：要回复的评论 ID。如未提供，先执行 reviews 展示列表让用户选择。
- `body`（必须）：回复内容。

### 步骤

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments/{comment_id}/replies -f body="{body}"
```

### 输出

```
## Replied — PR #{number}

已回复评论 #{comment_id}
```
