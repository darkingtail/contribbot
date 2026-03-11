---
name: contribbot:project-onboard
description: "新项目接入：检测 fork/upstream 关系、初始化配置、选择追踪锚点、首次拉取。触发词：'onboard'、'接入项目'、'新项目'、'初始化项目'。"
metadata:
  author: darkingtail
  version: "2.0.0"
  argument-hint: <owner/repo>
---

# Project Onboard — 新项目接入

引导用户将一个新项目接入 contribbot 追踪体系。

数据格式参考：`references/data-format.md`

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。
- 需要 `gh` CLI 已认证。

## 步骤

### 1. 检测项目信息

```bash
gh api repos/{owner}/{repo} --jq '{name: .name, full_name: .full_name, fork: .fork, parent: .parent.full_name, description: .description, language: .language}'
```

自动检测：
- 是否是 fork（`fork: true`，`parent` 有值）
- 组织信息（owner 部分）

### 2. 确定上游关系

根据检测结果引导：

**如果是 fork**：
- fork source 自动识别（parent 字段）
- 询问：是否还有跨栈追踪的外部 upstream？
  - 有 → fork+upstream 模式，让用户提供 upstream repo
  - 无 → fork 模式

**如果不是 fork**：
- 询问：是否需要追踪某个外部仓库的变更？
  - 有 → upstream 模式，让用户提供 upstream repo
  - 无 → none 模式

### 3. 确认角色

询问用户在该项目的 GitHub 权限等级：admin / maintain / write / triage / read

### 4. 初始化配置

创建目录和 config.yaml：

```bash
mkdir -p ~/.contribbot/{owner}/{repo}
```

写入 `~/.contribbot/{owner}/{repo}/config.yaml`：
```yaml
role: {role}
org: {org 或 null}
fork: {fork_source 或 null}
upstream: {upstream_repo 或 null}
```

展示配置结果和推断的模式，确认正确。

### 5. 首次上游拉取（fork/upstream/fork+upstream 模式）

**如果是 fork 模式**：
```bash
gh repo sync {owner}/{repo}
```

**如果有上游追踪**（fork source 或 external upstream）：

列出 releases 供用户选锚点：
```bash
gh release list -R {upstream_repo} --limit 10 --json tagName,publishedAt
```

如无 releases，用 tags：
```bash
gh api repos/{upstream_repo}/tags --jq '.[].name' | head -10
```

推荐选最新 release/tag 作为起点。用户选择后，初始化 upstream.yaml：

```yaml
versions: []
daily:
  "{upstream_repo}":
    lastFetched: "{today}"
    sinceTag: "{selected_tag}"
    commits: []
```

拉取增量 commits：
```bash
gh api "repos/{upstream_repo}/compare/{sinceTag}...HEAD" --jq '.commits[] | {sha: .sha[0:7], message: .commit.message, author: .commit.author.name, date: .commit.author.date}'
```

将 commits 写入 upstream.yaml（action: pending）。

### 6. 首次 triage（可选）

如果有 pending commits，询问用户：
- 现在处理？→ 跳噪音 + 逐条决策
- 留待后续？→ 通过 `contribbot:daily-sync` 处理

### 7. 输出摘要

```
## Project Onboard 完成 — {repo}

**模式**: {mode}
**角色**: {role}
**组织**: {org}

### 配置
| 字段 | 值 |
|------|-----|
| fork | {fork_repo 或 null} |
| upstream | {upstream_repo 或 null} |

### 追踪状态
| 追踪源 | 锚点 | Pending Commits |
|--------|------|-----------------|
| {source} | {anchor_tag} | {n} |

### 下一步
- 使用 `contribbot:daily-sync` 进行日常上游同步
- 使用 `contribbot:start-task` 开始处理任务
```
