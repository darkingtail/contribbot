---
name: contribbot:dashboard
description: "项目仪表盘：查看单项目全貌或跨项目概况。触发词：'dashboard'、'项目概况'、'全局视图'。"
metadata:
  author: darkingtail
  version: "3.0.0"
  argument-hint: "[owner/repo]"
---

# Dashboard — 项目仪表盘

通过 MCP 工具查看项目状态。不提供 repo 时展示跨项目视图。

## 前置

- `repo`（可选）：owner/repo 格式。提供则单项目，不提供则跨项目。

## 路由

| 场景 | 触发 |
|------|------|
| 单项目 | 提供 repo |
| 跨项目 | 不提供 repo / 说"全局"、"所有项目" |

---

## 单项目仪表盘

并行调用以下 MCP 工具：

1. `repo_config` — 获取项目模式（repo）
2. `project_dashboard` — 项目全貌：issues/PRs/commits/release（repo）
3. `repo_info` — 仓库元信息：stars/forks/topics/license（repo）
4. `todo_list` — 本地 todo 统计（repo）
5. `upstream_list` — 上游追踪统计（repo，如有追踪源）

整合为统一视图输出。

---

## 跨项目仪表盘

调用 `project_list` — 返回所有已跟踪项目的 todos/upstream 统计。
