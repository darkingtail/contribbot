---
name: contribbot:weekly-review
description: "周回顾：贡献统计、todo 进展、上游同步覆盖率、归档已完成项。支持单项目和跨项目模式。触发词：'weekly review'、'周回顾'、'本周总结'。"
metadata:
  author: darkingtail
  version: "2.0.0"
  argument-hint: "[owner/repo]"
---

# Weekly Review — 周回顾

回顾本周工作进展，按项目模式差异化总结。

数据格式参考：`references/data-format.md`

## 前置

- 用户提供 `repo` 则为单项目回顾
- 未提供则为跨项目回顾（扫描 `~/.contribbot/` 下所有项目）
- 需要 `gh` CLI 已认证。

## 跨项目模式

扫描 `~/.contribbot/` 下所有 `{owner}/{repo}/config.yaml`，对每个项目执行精简版单项目回顾，汇总输出。

---

## 单项目模式

### 1. 贡献统计

```bash
# 本周 PRs
gh pr list -R {owner}/{repo} --state all --json number,title,state,createdAt,mergedAt --limit 50
# 筛选本周创建或合并的

# 本周 Issues
gh issue list -R {owner}/{repo} --state all --json number,title,state,createdAt,closedAt --limit 50
# 筛选本周创建或关闭的
```

### 2. Todo 进展

读取 `~/.contribbot/{owner}/{repo}/todos.yaml`：

- **完成**：status = done，且 updated 在本周
- **推进中**：status = active 或 pr_submitted，且 updated 在本周
- **卡住**：status = active 但 updated 不在本周

### 3. 上游同步状态（fork/upstream/fork+upstream 模式）

读取 `~/.contribbot/{owner}/{repo}/upstream.yaml`：

- 统计 daily commits 中各 action 的数量
- 计算 versions 中的同步覆盖率（synced / total items）
- pending 数量

对 none 模式跳过此步。

### 4. 归档

在 todos.yaml 中找 status = done 的 todos，移到 `archive.yaml`，从 todos.yaml 删除。

archive.yaml 格式：
```yaml
todos:
  - ref: "281"
    title: "修复 XXX"
    # ... 所有原字段
    status: done
    archived: "2026-03-11"
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
