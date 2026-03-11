---
name: contribbot:daily-sync
description: "每日上游同步工作流。按项目模式自动分流：none 走维护日常，fork/upstream 走上游追踪。触发词：'daily sync'、'每日同步'、'日常巡检'。"
metadata:
  author: darkingtail
  version: "1.0.0"
  argument-hint: <owner/repo>
---

# Daily Sync — 每日上游同步

按项目模式（ProjectMode）自动分流的每日工作流。需要 contribbot MCP Server。

## 前置

用户提供 `repo`（owner/repo 格式）。如未提供，询问。

## 步骤

### 1. 检查项目模式

```
repo_config(repo) → 获取 mode（none/fork/upstream/fork+upstream）
```

根据返回的 fork 和 upstream 字段判断模式，进入对应分支。

---

### 分支 A: none 模式（无上游对齐）

无上游可追踪，执行维护日常：

1. **`project_dashboard(repo)`** — 项目全貌：open issues、open PRs、最近 commits、latest release
2. **`issue_list(repo, state="open")`** — 检查是否有新 issue 需要响应
3. **`actions_status(repo)`** — CI 是否健康
4. **`security_overview(repo)`** — 安全告警

输出摘要：
- Open issues 数量（标注新增）
- CI 状态
- 安全告警数量
- 需要关注的事项

---

### 分支 B: fork 模式（同源对齐）

1. **`sync_fork(repo)`** — 同步 fork 到上游最新
2. **`upstream_daily(repo)`** — 拉取 fork source 新 commits
   - 如果是首次（无锚点），会返回 releases/tags 列表，引导用户选择锚点
   - 如果已有锚点，返回增量 commits
3. **`upstream_daily_skip_noise(repo)`** — 批量跳过 CI/deps/build/style 噪音
4. 审阅剩余 pending commits，建议动作：
   - `skip` — 无关
   - `todo` — 记到本地 todo
   - `issue` — 创建 tracking issue
   - 对每条使用 **`upstream_daily_act(repo, ...)`** 标记

输出摘要：新增 / 跳过 / 已关联 / 待处理 数量。

---

### 分支 C: upstream 模式（跨栈追踪）

1. **`upstream_daily(repo)`** — 拉取外部 upstream 新 commits
   - 首次同分支 B，引导选锚点
2. **`upstream_daily_skip_noise(repo)`** — 跳噪音
3. 审阅 pending commits，评估跨栈复刻价值：
   - 这个变更在目标技术栈有意义吗？
   - 实现难度？
   - 对每条使用 **`upstream_daily_act(repo, ...)`** 标记
4. **`upstream_sync_check(repo)`** — 对比 release 级同步状态（可选，当需要全局视角时）

输出摘要：新增 / 跳过 / 已关联 / 待处理 数量 + 同步覆盖率。

---

### 分支 D: fork+upstream 模式（fork 同步 + 跨栈复刻）

依次执行分支 B 和分支 C：

1. **Fork source 追踪**（分支 B 全流程）
2. **External upstream 追踪**（分支 C 全流程）

输出合并摘要，按追踪源分列。

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
- Open issues: N（+N 新增）
- CI: passing/failing
- 安全告警: N
```
