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
- **推进中**：status = active
- **待办/想法**：status = backlog / idea
- **暂停**：status = paused，不计为完成
- **取消**：status = cancelled，不计为完成
- **卡住**：status = active 但长时间未更新

PR 进度独立；需要时用 `todo_detail` 查看，不因提交或合并 PR 改变 Todo 状态。

### 3. 上游同步状态

调用 `upstream_list`，参数：`repo`。

统计：
- daily commits 各 action 数量
- versions 同步覆盖率
- pending 数量

（none 模式跳过此步）

### 4. 待审知识提案

调用 `knowledge_proposals`，参数：`repo`、`status=pending`。

如有待审提案，列出清单，引导维护者逐条决策：
- **采纳** → `knowledge_apply_update`（proposal_id）
- **驳回** → `knowledge_reject_update`（proposal_id，可附 reason）

无待审提案则跳过。

### 5. 归档 & 清理

调用 `todo_archive(repo)` 只预览。用户明确选择后传入所选 `todo_id` 与 `snapshot`
组成的 `selections`，不默认归档全部、不扩大到确认后新增的完成项。
不回复就保留；done / cancelled 均不自动归档。

如果归档数据量较大（提示用户），可调用 `todo_compact` / `upstream_compact` 清理旧数据。

### 6. 输出报告

```
## 周回顾 — {repo} ({date_range})

**模式**: {mode}

### 贡献统计
| 指标 | 本周 |
|------|------|
| PRs | {n} merged / {n} opened |
| Issues | {n} closed / {n} opened |

### Todo 进展
| 状态 | 数量 | 详情 | 备注 |
|------|------|------|------|
| 完成 | {n} | {列表} | done，未归档 |
| 推进中 | {n} | {列表} | active，PR 进度独立 |
| 待办 | {n} | {列表} | backlog |
| 想法 | {n} | {列表} | idea |
| 暂停 | {n} | {列表} | paused，不是完成 |
| 取消 | {n} | {列表} | cancelled，未归档，不是完成 |
| 卡住 | {n} | {列表 + 原因} | active 中的观察，不是独立状态 |

### 上游同步（如适用）
| 追踪源 | 覆盖率 | Pending |
|--------|--------|---------|
| {source} | {%} | {n} commits |

### 待审知识提案
{n} 条 pending：{已采纳/已驳回/仍待定 概要}

### 归档
展示已结束未归档数量；仅实际获批执行后报告归档成功、失败和未处理的条目。

### 下周建议
- {基于当前状态的优先事项建议}
```
