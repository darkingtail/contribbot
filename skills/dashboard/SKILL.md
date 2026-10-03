---
name: contribbot:dashboard
description: "项目仪表盘、项目归档与恢复：查看单项目或跨项目概况。触发词：'dashboard'、'项目概况'、'全局视图'、'归档项目'、'恢复项目'。"
metadata:
  author: darkingtail
  version: "3.0.0"
  argument-hint: "[repository]"
---

# Dashboard — 项目仪表盘

通过 MCP 工具查看项目状态。不提供 repo 时展示跨项目视图。

## 前置

- 单项目先从用户线索或已确认的会话上下文取得完整
  `{platform, instance, path}`，仓库范围工具显式传该对象；
  跨项目视图不传 `repo`。简称不直接交给 MCP。

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

调用 `project_list` — 默认返回活跃项目的 todos/upstream 统计。
用户要求所有项目时传 `status: "all"`，要求归档项目时传 `status: "archived"`。

## 项目归档与恢复

- 项目状态与 Todo 状态无关；不要用 `todo_archive` 代替项目归档。
- 用户明确要求归档某项目：调用 `project_archive({ repo })`，然后
  `project_status({ repo })` 读取 JSON 校验为 `archived`。
- 用户明确要求恢复维护：调用 `project_restore({ repo })`，读回状态为 `active`。
- 项目身份不清楚时先核实；不要从同名项目或 parent 猜测，也不要批量归档。
- 不删除目录、不关闭 GitHub issue/PR、不归档 GitHub 仓库、不标记未完成任务为完成。
- 归档后历史数据保留，默认巡检不选中；显式巡检/恢复旧 Run 也会被阻止。
- `project_init` 不自动恢复归档项目，恢复须由用户明确要求。
