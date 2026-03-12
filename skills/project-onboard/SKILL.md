---
name: contribbot:project-onboard
description: "新项目接入：检测 fork/upstream 关系、初始化配置、选择追踪锚点、首次拉取。触发词：'onboard'、'接入项目'、'新项目'、'初始化项目'。"
metadata:
  author: darkingtail
  version: "3.0.0"
  argument-hint: <owner/repo>
---

# Project Onboard — 新项目接入

通过 MCP 工具将新项目接入 contribbot 追踪体系。

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。

## 核心概念：主 repo 解析

contribbot 以**上游仓库（parent）为主 repo** 存储数据。`repo_config` 工具会自动处理 fork 解析——如果传入的是 fork 仓库，会自动解析到 parent 并记录 fork 字段。

## 步骤

### 1. 初始化配置

调用 `repo_config`，参数：`repo`。

工具会自动：
- 检测 fork 关系（解析到 parent）
- 检测权限（role）
- 检测组织（org）
- 初始化项目配置

### 2. 确定上游追踪

查看返回的配置，询问用户：

是否需要追踪某个**外部仓库**的变更？（跨栈复刻，非 fork source）
- 有 → 调用 `repo_config`（repo、upstream={upstream_repo}）设置 upstream
- 无 → 跳过

注意：fork source 不算 upstream。upstream 专指跨栈追踪的外部仓库。

### 3. 首次同步（fork/upstream/fork+upstream 模式）

**如果有 fork**：
调用 `sync_fork`（repo）

**如果有上游追踪**（fork source 或 external upstream）：
调用 `upstream_daily`（repo、upstream_repo）

工具会自动：
- 首次引导选择基准版本（releases/tags）
- 拉取增量 commits

### 4. 首次 triage（可选）

如果有 pending commits：
- 调用 `upstream_daily_skip_noise`（repo、upstream_repo）— 跳噪音
- 询问用户是否现在逐条处理
  - 是 → 逐条调用 `upstream_daily_act`
  - 否 → 留待 `contribbot:daily-sync` 处理

### 5. 输出摘要

```
## Project Onboard 完成 — {repo}

**模式**: {mode}
**角色**: {role}
**组织**: {org}

### 配置
| 字段 | 值 |
|------|-----|
| fork | {fork_repo 或 —} |
| upstream | {upstream_repo 或 —} |

### 追踪状态
| 追踪源 | 锚点 | Pending Commits |
|--------|------|-----------------|
| {source} | {anchor_tag} | {n} |

### 下一步
- 使用 `contribbot:daily-sync` 进行日常上游同步
- 使用 `contribbot:start-task` 开始处理任务
```
