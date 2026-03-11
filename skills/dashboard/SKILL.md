---
name: contribbot:dashboard
description: "项目仪表盘：查看单项目全貌或跨项目概况。触发词：'dashboard'、'项目概况'、'全局视图'。"
metadata:
  author: darkingtail
  version: "1.0.0"
  argument-hint: "[owner/repo]"
---

# Dashboard — 项目仪表盘

查看单项目全貌或跨项目概况。不提供 repo 参数时展示跨项目视图。

数据格式参考：`references/data-format.md`

## 前置

- `repo`（可选）：owner/repo 格式。提供则展示单项目，不提供则展示跨项目。
- 需要 `gh` CLI 已认证。

## 路由

| 场景 | 触发 |
|------|------|
| 单项目 | 提供 repo 参数 |
| 跨项目 | 不提供 repo / 说"全局"、"所有项目" |

---

## 单项目仪表盘

### 步骤

1. 读取 `~/.contribbot/{owner}/{repo}/config.yaml` 获取模式（mode）。

2. 获取仓库信息：
```bash
gh api repos/{owner}/{repo} --jq '{name: .name, description: .description, stars: .stargazers_count, forks: .forks_count, open_issues: .open_issues_count, topics: .topics, license: .license.spdx_id, default_branch: .default_branch, fork: .fork, parent: .parent.full_name}'
```

3. 获取 open issues 统计（按 label 分组）：
```bash
gh issue list -R {owner}/{repo} --state open --json number,title,labels,createdAt --limit 50
```

4. 获取 open PRs：
```bash
gh pr list -R {owner}/{repo} --state open --json number,title,author,createdAt,isDraft,headRefName --limit 20
```

5. 获取近期 commits：
```bash
gh api repos/{owner}/{repo}/commits --jq '.[0:10] | .[] | {sha: .sha[0:7], message: .commit.message, author: .commit.author.name, date: .commit.author.date}'
```

6. 获取最新 release：
```bash
gh release list -R {owner}/{repo} --limit 3 --json tagName,publishedAt,name
```

7. 读取 todos.yaml 统计。

8. 读取 upstream.yaml 统计（如有）。

### 输出

```
## Dashboard — {owner}/{repo}

**模式**: {mode} | **Stars**: {stars} | **Forks**: {forks}
**描述**: {description}
**License**: {license} | **Topics**: {topics}

### Open Issues（{count}）
| Label | Count | Latest |
|-------|-------|--------|
| bug | 5 | #281 修复 XXX |
| enhancement | 3 | #300 新功能 |

### Open PRs（{count}）
| # | Title | Author | Branch | Draft |
|---|-------|--------|--------|-------|
| 285 | fix: XXX | user1 | fix/281 | No |

### 近期 Commits
| SHA | Message | Author | Date |
|-----|---------|--------|------|
| abc1234 | feat: add ... | user1 | 2026-03-10 |

### Releases
| Tag | Name | Published |
|-----|------|-----------|
| v1.2.0 | Release 1.2.0 | 2026-03-01 |

### Todos
Active: {a} | Backlog: {b} | Ideas: {i} | Done: {d}

### Upstream（如有）
追踪源: {upstream_repos}
Pending: {p} | Synced: {s} | Skipped: {sk}
每日未处理: {daily_pending}
```

---

## 跨项目仪表盘

### 步骤

1. 扫描 `~/.contribbot/` 下所有项目目录。
2. 对每个项目读取 config.yaml、todos.yaml、upstream.yaml。

### 输出

```
## Dashboard — 全局

| 项目 | 模式 | Active | Backlog | Done | Upstream Pending | 备注 |
|------|------|--------|---------|------|-----------------|------|
| owner/repo1 | fork | 1 | 3 | 2 | 5 | 有未处理上游 |
| owner/repo2 | none | 0 | 1 | 0 | — | 空闲 |

共 {n} 个项目，{total_active} 个活跃任务，{total_pending} 条待处理上游
```
