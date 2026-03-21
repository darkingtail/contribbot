---
name: contribbot:weekly-review
description: "周回顾：贡献统计、todo 进展、上游同步覆盖率、归档已完成项。支持单项目和跨项目模式。触发词：'weekly review'、'周回顾'、'本周总结'。"
metadata:
  author: darkingtail
  version: "3.0.0"
  argument-hint: "[owner/repo]"
---

# Weekly Review — 周回顾

通过 MCP 工具回顾本周工作进展。

## 前置

- 用户提供 `repo` 则为单项目回顾
- 未提供则为跨项目回顾

## 跨项目模式

1. 调用 `project_list` — 所有已跟踪项目概况
2. 调用 `contribution_stats`（repo="all"）— 跨项目贡献统计
3. 对每个活跃项目执行精简版单项目检查
4. 汇总输出

---

## 单项目模式

### 1. 贡献统计

调用 `contribution_stats`，参数：`repo`、`days=7`。

### 2. Todo 进展

调用 `todo_list`，参数：`repo`。

分析：
- **完成**：status = done
- **推进中**：status = active 或 pr_submitted
- **卡住**：status = active 但长时间未更新

### 3. 上游同步状态

调用 `upstream_list`，参数：`repo`。

统计：
- daily commits 各 action 数量
- versions 同步覆盖率
- pending 数量

（none 模式跳过此步）

### 4. 归档 & 清理

调用 `todo_archive`，参数：`repo`。

如果归档数据量较大（提示用户），可调用 `todo_compact` / `upstream_compact` 清理旧数据。

### 5. 输出报告

```
## 周回顾 — {repo} ({date_range})

**模式**: {mode}

### 贡献统计
| 指标 | 本周 |
|------|------|
| PRs | {n} merged / {n} opened |
| Issues | {n} closed / {n} opened |

### Todo 进展
| 状态 | 数量 | 详情 |
|------|------|------|
| 完成 | {n} | {列表} |
| 推进中 | {n} | {列表} |
| 卡住 | {n} | {列表 + 原因} |

### 上游同步（如适用）
| 追踪源 | 覆盖率 | Pending |
|--------|--------|---------|
| {source} | {%} | {n} commits |

### 归档
已归档 {n} 条已完成 todo。

### 下周建议
- {基于当前状态的优先事项建议}
```
