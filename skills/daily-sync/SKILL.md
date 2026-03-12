---
name: contribbot:daily-sync
description: "每日上游同步工作流。按项目模式自动分流：none 走维护日常，fork/upstream 走上游追踪。触发词：'daily sync'、'每日同步'、'日常巡检'。"
metadata:
  author: darkingtail
  version: "3.0.0"
  argument-hint: <owner/repo>
---

# Daily Sync — 每日上游同步

通过 MCP 工具按项目模式自动分流的每日工作流。

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。

## 步骤

### 1. 检查项目模式

调用 `repo_config`（repo）获取 config。

根据 fork 和 upstream 字段判断模式：
- fork + upstream → fork+upstream
- fork only → fork
- upstream only → upstream
- neither → none

如果未初始化，提示用户先用 `contribbot:project-onboard`。

---

### 分支 A: none 模式

并行调用：
- `project_dashboard`（repo）— issues/PRs/commits 概况
- `actions_status`（repo）— CI 状态
- `security_overview`（repo）— 安全告警

输出摘要：Open issues / Open PRs / CI 状态 / 安全告警数。

---

### 分支 B: fork 模式

1. **同步 fork**：调用 `sync_fork`（repo）

2. **拉取新 commits**：调用 `upstream_daily`（repo、upstream_repo={fork_source}）
   - 首次会引导选择锚点版本
   - 后续增量拉取

3. **跳噪音**：调用 `upstream_daily_skip_noise`（repo、upstream_repo={fork_source}）

4. **审阅 pending commits**：展示剩余 pending，逐条让用户决策：
   - `skip` — 调用 `upstream_daily_act`（action=skip）
   - `todo` — 调用 `upstream_daily_act`（action=todo）
   - `issue` — 调用 `upstream_daily_act`（action=issue）

---

### 分支 C: upstream 模式

与分支 B 类似，追踪源改为 config 中的 upstream 字段。

额外评估维度：
- 变更在目标技术栈是否有意义
- 实现难度（从零重写 vs 简单适配）

可选：调用 `upstream_sync_check`（repo、upstream_repo）— 版本级同步状态对比。

---

### 分支 D: fork+upstream 模式

依次执行分支 B（fork source）和分支 C（external upstream），输出合并摘要。

---

## 最终输出格式

```
## Daily Sync 摘要 — {repo}

**模式**: {mode}
**日期**: {date}

### Fork Source: {fork_repo}（如有）
| 指标 | 数量 |
|------|------|
| 新增 commits | N |
| 跳过噪音 | N |
| 已关联 issue/todo | N |
| 待处理 | N |

### Upstream: {upstream_repo}（如有）
| 指标 | 数量 |
|------|------|
| 新增 commits | N |
| 跳过噪音 | N |
| 已关联 issue/todo | N |
| 待处理 | N |

### 维护状态（none 模式）
- Open issues: N
- Open PRs: N
- CI: passing/failing
- 安全告警: N
```
