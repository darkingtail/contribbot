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

## 核心概念：主 repo 解析

contribbot 以**上游仓库（parent）为主 repo** 存储数据。如果用户提供的是 fork 仓库，需要先解析到 parent：

- 用户输入 `darkingtail/plane` → 检测到是 fork → parent 是 `makeplane/plane`
- 数据存储路径：`~/.contribbot/makeplane/plane/`
- config.yaml 中 `fork: darkingtail/plane`

## 步骤

### 1. 检测项目信息 + Fork 解析

```bash
gh api repos/{owner}/{repo} --jq '{name: .name, full_name: .full_name, fork: .fork, parent: .parent.full_name, description: .description, language: .language, permissions: .permissions}'
```

**如果是 fork**（`fork: true`）：
- 自动解析到 parent 仓库作为主 repo
- 记录用户的 fork 仓库名（`{original_owner}/{repo}`）
- 后续所有操作和存储以 parent 为准

```
用户输入: darkingtail/plane (fork)
  → 主 repo: makeplane/plane (parent)
  → fork 字段: darkingtail/plane
```

**如果不是 fork**：
- 直接使用输入的 repo 作为主 repo
- 检查当前用户是否有该仓库的同名 fork：
```bash
gh api repos/{current_user}/{repo_name} --jq '{fork: .fork, parent: .parent.full_name}' 2>/dev/null
```
如果有 fork 且 parent 指向主 repo，记录 fork 字段。

### 2. 检测角色和组织

从步骤 1 的 API 返回中直接提取，**不要询问用户**：

**角色**（从 permissions 对象）：
- `permissions.admin` → admin
- `permissions.maintain` → maintain
- `permissions.push` → write
- `permissions.triage` → triage
- 否则 → read

**组织**：
```bash
gh api users/{main_repo_owner} --jq '.type'
```
如果 type 是 `Organization`，记录 org 字段。

### 3. 确定上游追踪

询问：是否需要追踪某个**外部仓库**的变更？（跨栈复刻，非 fork source）
- 有 → 让用户提供 upstream repo
- 无 → upstream 为 null

注意：fork source 不算 upstream。upstream 专指跨栈追踪的外部仓库（如 ant-design/ant-design 之于 antdv-next/antdv-style）。

### 4. 初始化配置

创建目录和 config.yaml（使用**主 repo**路径）：

```bash
mkdir -p ~/.contribbot/{main_owner}/{main_repo}
```

写入 `~/.contribbot/{main_owner}/{main_repo}/config.yaml`：
```yaml
role: {role}
org: {org 或 null}
fork: {user_fork 或 null}
upstream: {upstream_repo 或 null}
```

展示配置结果和推断的模式，确认正确。

### 5. 首次上游拉取（fork/upstream/fork+upstream 模式）

**如果有 fork**（同步 fork 到上游最新）：
```bash
gh repo sync {fork_repo}
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
