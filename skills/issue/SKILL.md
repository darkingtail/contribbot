---
name: contribbot:issue
description: "Issue 管理：浏览、查看详情、创建、关闭、评论。触发词：'issue'、'问题列表'、'创建 issue'、'关闭 issue'。"
metadata:
  author: darkingtail
  version: "1.0.0"
  argument-hint: <owner/repo> [action] [args...]
---

# Issue — Issue 管理

浏览、查看详情、创建、关闭 issue，写评论。

数据格式参考：`references/data-format.md`

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。
- 需要 `gh` CLI 已认证。

## 动作路由

根据用户意图分流（如不明确，默认 **list**）：

| 意图 | 动作 | 示例 |
|------|------|------|
| 浏览 issues | list | "看看 issues"、"有什么问题" |
| 查看详情 | detail | "看看 #281" |
| 创建 issue | create | "提个 issue"、"报个 bug" |
| 关闭 issue | close | "关闭 #281" |
| 写评论 | comment | "评论 #281" |

---

## list — 浏览 Issues

```bash
gh issue list -R {owner}/{repo} --state {state} --json number,title,labels,createdAt,author,comments --limit 30
```

### 参数

- `state`（可选）：open / closed / all，默认 open。
- `labels`（可选）：按标签过滤，逗号分隔。
- `query`（可选）：关键词搜索。

如有 labels 过滤：
```bash
gh issue list -R {owner}/{repo} --label "{label}" --json number,title,labels,createdAt,author,comments --limit 30
```

如有关键词：
```bash
gh issue list -R {owner}/{repo} --search "{query}" --json number,title,labels,createdAt,author,comments --limit 30
```

### 输出

```
## Issues — {owner}/{repo}（{state}）

| # | Title | Labels | Author | Comments | Created |
|---|-------|--------|--------|----------|---------|
| 281 | 修复 XXX | bug | user1 | 3 | 2026-03-01 |

共 {n} 条
```

---

## detail — Issue 详情

```bash
gh issue view {number} -R {owner}/{repo} --json number,title,body,labels,comments,state,assignees,milestone
```

### 输出

```
## Issue #{number} — {title}

**状态**: {state} | **标签**: {labels} | **指派**: {assignees}

### 描述
{body 摘要}

### 评论（{count} 条）
- **{author}**（{date}）：{comment 摘要}
- ...

### 关联
- PR: {如有关联 PR}
- Todo: {如在 todos.yaml 中有对应 ref}
```

检查 todos.yaml 是否有该 issue 编号的 todo，如有则展示关联信息。

---

## create — 创建 Issue

### 参数

- `title`（必须）：issue 标题。
- `body`（可选）：issue 描述。
- `labels`（可选）：标签，逗号分隔。
- `auto_todo`（可选）：是否自动创建对应 todo，默认否。
- `upstream_sha`（可选）：关联的 upstream commit SHA（来自 daily-sync triage）。
- `upstream_repo`（可选）：upstream commit 来源仓库。

### 步骤

1. 创建 issue：
```bash
gh issue create -R {owner}/{repo} --title "{title}" --body "{body}" --label "{labels}"
```

2. 如 `auto_todo`：在 todos.yaml 中添加对应条目（ref = 新 issue 编号）。

3. 如有 `upstream_sha` + `upstream_repo`：在 body 中附加来源信息：
```
> Upstream: {upstream_repo}@{upstream_sha}
```
并更新 upstream.yaml 中对应 commit 的 action 为 `issue`，ref 为新 issue 编号。

### 输出

```
## Created — {owner}/{repo}

Issue #{number}: {title}
URL: https://github.com/{owner}/{repo}/issues/{number}
{如 auto_todo} Todo 已创建
{如 upstream} 已关联 upstream commit {sha}
```

---

## close — 关闭 Issue

### 参数

- `number`（必须）：issue 编号。
- `comment`（可选）：关闭时附加评论。

### 步骤

1. 如有 comment：
```bash
gh issue close {number} -R {owner}/{repo} --comment "{comment}"
```
否则：
```bash
gh issue close {number} -R {owner}/{repo}
```

2. 检查 todos.yaml 是否有对应 ref 的 todo，如有且 status != done，提示是否同时标记 done。

### 输出

```
## Closed — {owner}/{repo}

Issue #{number}: {title} 已关闭
{如有 todo} Todo #{ref} 已标记 done
```

---

## comment — 写评论

### 参数

- `number`（必须）：issue 或 PR 编号。
- `body`（必须）：评论内容。

### 步骤

```bash
gh issue comment {number} -R {owner}/{repo} --body "{body}"
```

### 输出

```
## Commented — {owner}/{repo}

已在 #{number} 添加评论
```
