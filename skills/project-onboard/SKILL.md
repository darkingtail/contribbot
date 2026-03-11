---
name: contribbot:project-onboard
description: "新项目接入：检测 fork/upstream 关系、初始化配置、选择追踪锚点、首次拉取。触发词：'onboard'、'接入项目'、'新项目'、'初始化项目'。"
metadata:
  author: darkingtail
  version: "1.0.0"
  argument-hint: <owner/repo>
---

# Project Onboard — 新项目接入

引导用户将一个新项目接入 contribbot 追踪体系。需要 contribbot MCP Server。

## 前置

用户提供 `repo`（owner/repo 格式）。如未提供，询问。

## 步骤

### 1. 检测项目信息

```
repo_info(repo) → 仓库元信息（fork 关系、description、language 等）
```

自动检测：
- 是否是 fork（有 parent repo）
- 组织信息

### 2. 询问上游关系

根据检测结果引导：

**如果是 fork**：
- fork source 自动识别（parent repo）
- 询问：是否还有跨栈追踪的外部 upstream？
  - 有 → fork+upstream 模式
  - 无 → fork 模式

**如果不是 fork**：
- 询问：是否需要追踪某个外部仓库的变更？
  - 有 → upstream 模式，让用户提供 upstream repo（owner/repo）
  - 无 → none 模式

### 3. 确认角色

询问用户在该项目的 GitHub 权限等级：
- admin / maintain / write / triage / read

### 4. 初始化配置

```
repo_config(repo, role=..., org=..., fork=..., upstream=...)
```

展示配置结果，确认模式推断正确。

### 5. 首次上游拉取（fork/upstream/fork+upstream 模式）

**如果是 fork 模式**：
```
sync_fork(repo) → 同步 fork 到上游最新
```

**如果有上游追踪（fork source 或 external upstream）**：
```
upstream_daily(repo) → 首次拉取，返回 releases/tags 列表
```

引导用户选择锚点（从哪个版本开始追踪）：
- 推荐选最新 release/tag 作为起点
- 用户也可选择更早的版本（会有更多 commits 需要处理）

选择锚点后再次调用：
```
upstream_daily(repo, sinceTag=选定的锚点) → 拉取锚点之后的增量 commits
```

### 6. 首次 triage（可选）

如果首次拉取有 pending commits：
```
upstream_daily_skip_noise(repo) → 跳噪音
```

询问用户是否现在处理剩余 commits，还是留待后续 daily-sync。

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
- 使用 `daily-sync` 进行日常上游同步
- 使用 `start-task` 开始处理任务
```
