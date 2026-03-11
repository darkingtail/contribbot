---
name: contribbot:weekly-review
description: "周回顾：贡献统计、todo 进展、上游同步覆盖率、归档已完成项。支持单项目和跨项目模式。触发词：'weekly review'、'周回顾'、'本周总结'。"
metadata:
  author: darkingtail
  version: "1.0.0"
  argument-hint: "[owner/repo]"
---

# Weekly Review — 周回顾

回顾本周工作进展，按项目模式差异化总结。需要 contribbot MCP Server。

## 前置

- 用户提供 `repo` 则为单项目回顾
- 未提供则为跨项目回顾

## 跨项目模式

### 1. 总览

```
project_list() → 所有已跟踪项目概况（todos/upstream 统计）
```

### 2. 逐项目摘要

对每个活跃项目执行单项目回顾（下方流程），输出精简版。

### 3. 跨项目总结

```
## 周回顾 — {date_range}

### 项目概况
| 项目 | 模式 | 本周 PR | 本周 Issue | Todo 进展 | 上游同步 |
|------|------|---------|-----------|-----------|---------|
| {repo} | {mode} | {n} | {n} | {done}/{total} | {coverage} |

### 亮点
- {本周完成的重要事项}

### 阻塞
- {卡住的事项}

### 下周重点
- {建议的优先事项}
```

---

## 单项目模式

### 1. 贡献统计

```
contribution_stats(repo) → 本周 PR/issue/review 计数
```

### 2. Todo 进展

```
todo_list(repo) → 当前 todos 状态分布
```

分析：
- 本周完成了哪些（Done 列表中本周标记的）
- 哪些在推进（Active 中有进展的）
- 哪些卡住了（Active 但无进展）

### 3. 上游同步状态（fork/upstream/fork+upstream 模式）

```
upstream_list(repo) → 版本同步总览 + 每日 commits 摘要
```

评估：
- 同步覆盖率
- 待处理的 pending commits 数量
- 是否有版本落后

对 none 模式跳过此步。

### 4. 归档

```
todo_archive(repo) → 归档已完成的 todos
```

### 5. 输出报告

```
## 周回顾 — {repo} ({date_range})

**模式**: {mode}

### 贡献统计
| 指标 | 本周 |
|------|------|
| PRs | {n} merged / {n} opened |
| Issues | {n} closed / {n} opened |
| Reviews | {n} |

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
