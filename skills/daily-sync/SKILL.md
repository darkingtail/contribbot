---
name: contribbot:daily-sync
description: "每日维护与追踪工作流。按 parent 和 tracking 分流：none 走维护日常，已确认来源才追踪变更。触发词：'daily sync'、'每日同步'、'日常巡检'。"
metadata:
  author: darkingtail
  version: "3.0.0"
  argument-hint: <repository>
---

# Daily Sync — 每日上游同步

通过 MCP 工具按项目模式自动分流的每日工作流。

## 前置

- 使用已确认的会话项目，或从用户线索核实完整 `{platform, instance, path}`；
  每次仓库范围工具调用都显式传该对象。无法确认目标时再问用户。

## 步骤

### 1. 检查项目模式

先调用只读 `project_status`（repo 完整对象）读取 JSON 生命周期及管理主体。
若 `status` 为 `archived`，停止巡检/同步并说明需用户明确要求
`project_restore`。不要自动恢复；缺失状态的配置不是 active。
状态无法确认时也停止；后续对同一主体调用 `repo_config` 获取 config。

根据 `parent.status=confirmed` 和 `tracking.status=configured` 判断模式：
- 两者都有 → fork+tracking
- 只有 parent → fork
- 只有 tracking → tracking
- 都没有 → none（`unknown` / `pending` 另行注明，不能冒充确认不存在）

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

1. **同步 fork**：仅在用户明确授权、parent 已确认且工具支持当前平台时
   调用 `sync_fork`（repo）；巡检请求本身不是远端写入授权。

2. **拉取新 commits**：只有用户选择追踪 parent、且来源为 GitHub.com 时，
   调用 `upstream_daily`（repo=主体完整对象、upstream_repo=parent.repository
   的完整对象）。两个参数含义不同，均不能只传 `path`。
   - 首次会引导选择锚点版本
   - 后续增量拉取

3. **跳噪音**：仅在第 2 步实际追踪 parent 且需要处理该来源时，
   调用 `upstream_daily_skip_noise`（repo=主体完整对象、
   upstream_repo=parent.repository 的完整对象）。

4. **审阅 pending commits**：展示剩余 pending，逐条让用户决策：
   - `skip` — 调用 `upstream_daily_act`（action=skip）
   - `todo` — 调用 `upstream_daily_act`（action=todo）
   - `issue` — 调用 `upstream_daily_act`（action=issue）

---

### 分支 C: tracking 模式

对 `tracking.sources` 中逐个已确认且当前工具支持的来源处理。
未支持的平台报告限制，不让 GitHub API 处理它们。

额外评估维度：
- 变更在目标技术栈是否有意义
- 实现难度（从零重写 vs 简单适配）

可选：对支持的 GitHub.com 来源调用 `upstream_sync_check`（repo=主体完整对象、
upstream_repo=tracking.sources 中的完整对象）— 版本级同步状态对比。

---

### 分支 D: fork+tracking 模式

分别处理已授权的 fork 同步与已配置的 tracking sources；parent 若同时
是追踪来源，不重复拉取。输出合并摘要，未执行部分标明原因。

---

## 最终输出格式

```
## Daily Sync 摘要 — {repo}

**模式**: {mode}
**日期**: {date}

### Fork Source: {fork_repo}（如有）
| 指标 | 数量 | 备注 |
|------|------|------|
| 新增 commits | N | 仅本次实际查询的来源 |
| 跳过噪音 | N | 未执行则注明原因 |
| 已关联 issue/todo | N | 仅已核实的关联 |
| 待处理 | N | 尚需决策的记录 |

### Upstream: {upstream_repo}（如有）
| 指标 | 数量 | 备注 |
|------|------|------|
| 新增 commits | N | 仅本次实际查询的来源 |
| 跳过噪音 | N | 未执行则注明原因 |
| 已关联 issue/todo | N | 仅已核实的关联 |
| 待处理 | N | 尚需决策的记录 |

### 维护状态（none 模式）
- Open issues: N
- Open PRs: N
- CI: passing/failing
- 安全告警: N
```
