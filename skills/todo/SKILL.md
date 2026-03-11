---
name: contribbot:todo
description: "Todo 日常管理：查看、添加、更新、完成、删除 todo。触发词：'todo'、'任务列表'、'添加任务'、'完成任务'。"
metadata:
  author: darkingtail
  version: "1.0.0"
  argument-hint: <owner/repo> [action] [args...]
---

# Todo — 任务日常管理

查看、添加、更新、完成、删除 todo。覆盖 todo 全生命周期的日常操作。

数据格式参考：`references/data-format.md`

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。
- 需要 `gh` CLI 已认证（仅 add 关联 issue 时需要）。

## 动作路由

根据用户意图分流（如不明确，默认 **list**）：

| 意图 | 动作 | 示例 |
|------|------|------|
| 查看任务 | list | "看看任务"、"todo" |
| 添加任务 | add | "加个任务"、"新建 todo" |
| 更新任务 | update | "更新任务"、"关联 PR" |
| 完成任务 | done | "完成了"、"搞定了" |
| 删除任务 | delete | "删掉这个"、"不做了" |

---

## list — 查看任务列表

读取 `~/.contribbot/{owner}/{repo}/todos.yaml`，按状态分组展示。

### 输出格式

```
## Todos — {owner}/{repo}

### Active（进行中）
| # | Ref | Title | Type | Difficulty | PR | Branch |
|---|-----|-------|------|------------|-----|--------|
| 1 | 281 | 修复 XXX | bug | medium | #285 | fix/281 |

### Backlog & Ideas（待办）
| # | Ref | Title | Type | Status | Created |
|---|-----|-------|------|--------|---------|
| 2 | 300 | 新功能 | feat | backlog | 2026-03-01 |
| 3 | idea-1 | 优化构建 | idea | idea | 2026-03-05 |

### Done（已完成）
| # | Ref | Title | Type | PR |
|---|-----|-------|------|----|
| 4 | 250 | 旧 bug | bug | #260 |

共 {n} 条（Active: {a}, Backlog: {b}, Ideas: {i}, Done: {d}）
提示：已完成的 todo 可通过 weekly-review 归档。
```

如果 todos.yaml 不存在或为空，提示：`暂无 todo。使用 "add" 添加第一个。`

---

## add — 添加任务

### 参数

- `ref`（可选）：GitHub issue 编号。提供时自动拉取 issue 信息。
- `title`（必须）：如有 ref 可自动从 issue 获取。
- `type`（可选）：bug / feat / chore / refactor / docs / idea。有 ref 时从 label 推断。
- `status`（可选）：idea / backlog，默认 backlog。有 ref 默认 backlog，无 ref 默认 idea。

### 步骤

1. 如有 `ref`，拉取 issue 信息：
```bash
gh issue view {ref} -R {owner}/{repo} --json number,title,labels,state
```

2. 从 labels 推断 type：
   - `bug` label → type: bug
   - `enhancement` / `feature` label → type: feat
   - `documentation` label → type: docs
   - 无匹配 → 询问用户或默认 feat

3. 构造 todo 条目：
```yaml
- ref: "{ref}"           # issue 编号 或 idea-{N}
  title: "{title}"
  type: {type}
  status: {status}
  difficulty: null
  pr: null
  branch: null
  created: "{today}"
  updated: "{today}"
```

4. 追加到 `~/.contribbot/{owner}/{repo}/todos.yaml` 的 `todos` 数组。如文件不存在，创建：
```yaml
todos:
  - ref: ...
```

5. 如果是无 ref 的 idea，ref 使用 `idea-{N}`（N 为当前 idea 计数 +1）。

### 输出

```
## Added — {owner}/{repo}

✓ #{ref} {title}（{type}, {status}）
```

---

## update — 更新任务

### 参数

- `ref`（必须）：要更新的 todo 的 ref。
- 可更新字段：`status`、`pr`、`branch`、`difficulty`、`title`、`type`。

### 步骤

1. 读取 todos.yaml，找到匹配 ref 的条目。
2. 更新指定字段，同时更新 `updated` 为今天。
3. 写回 todos.yaml。

### 常见场景

- **关联 PR**：`update 281 pr=285`
- **设置分支**：`update 281 branch=fix/281`
- **调整难度**：`update 281 difficulty=hard`
- **改状态**：`update 281 status=pr_submitted`

### 输出

```
## Updated — {owner}/{repo}

#{ref} {title}
  {field}: {old} → {new}
```

---

## done — 完成任务

### 参数

- `ref`（必须）：要标记完成的 todo 的 ref。
- `close_issue`（可选）：是否同时关闭 GitHub issue，默认否。

### 步骤

1. 读取 todos.yaml，找到匹配 ref 的条目。
2. 更新 status 为 `done`，更新 `updated` 为今天。
3. 写回 todos.yaml。
4. 如果 `close_issue` 且 ref 是 issue 编号：
```bash
gh issue close {ref} -R {owner}/{repo}
```

### 输出

```
## Done — {owner}/{repo}

✓ #{ref} {title} 已完成
{如关联 PR} PR: #{pr}
{如关闭 issue} Issue #{ref} 已关闭
```

---

## delete — 删除任务

### 参数

- `ref`（必须）：要删除的 todo 的 ref。

### 步骤

1. 读取 todos.yaml，找到匹配 ref 的条目。
2. 展示该条目信息，**确认后**从 todos 数组中移除。
3. 写回 todos.yaml。
4. 如果存在实现记录文件 `todos/{ref}.md`，询问是否一并删除。

### 输出

```
## Deleted — {owner}/{repo}

✗ #{ref} {title} 已删除
```
