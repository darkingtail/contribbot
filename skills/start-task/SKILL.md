---
name: contribbot:start-task
description: "开始一个任务：进入项目上下文、选择 todo、激活并查看详情。触发词：'start task'、'开始任务'、'开工'。"
metadata:
  author: darkingtail
  version: "3.0.0"
  argument-hint: <owner/repo> [todo item]
---

# Start Task — 开始任务

通过 MCP 工具进入项目上下文，选择并激活一个 todo，了解完整背景后开始工作。

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。
- 可选提供 `item`（todo 索引或关键词）。

## 步骤

### 1. 进入项目上下文

并行调用：
- `repo_config` — 获取项目模式（repo）
- `project_dashboard` — 项目全貌（repo）
- `todo_list` — 当前 todos（repo）

如果是 fork 模式，提醒用户是否需要先同步 fork：
→ 是：调用 `sync_fork`（repo）

### 2. 选择 Todo

- 如果用户指定了 `item`：按索引或 ref 匹配
- 如果未指定：根据优先级推荐（backlog > idea，有 ref 的优先）

### 3. 激活 Todo

先分析仓库的分支命名规范（查看已有分支名称），建议合适的分支名。

调用 `todo_activate`，参数：`repo`、`item`、`branch`（建议的分支名，如无法判断可省略使用默认值）。

工具会自动：
- 更新 status 为 active
- 拉取关联 issue 详情 + 评论总结
- 评估难度
- 记录分支名（不自动创建远程分支）

activate 完成后，基于 issue 内容（body + 评论 + 标签）生成实现方案，调用 `todo_update(note=实现方案)` 写入文档。方案应包含：
- 问题分析
- 实现思路
- 关键改动点
- 注意事项

写入后输出简短的计划总结（3-5 句话概括核心思路），然后告知用户完整方案已写入文档，附文档路径。

### 4. 领取工作项（issue-linked todo）

如果 `todo_activate` 返回的 issue 内容中包含可领取的工作项（子任务、表格行、职责范围等任意形式）：

1. 从 issue 内容中识别所有可领取的工作项
2. 列出清单，让用户选择要领取的
3. 用户选择后，调用 `todo_claim`，参数：`repo`、`item`、`items`（选中的工作项描述）

工具会自动：
- 在 GitHub issue 上发布评论（模板可配置）
- 本地记录领取的工作项
- 自动将 todo 状态升为 active

如果 issue 没有可领取的工作项，跳过此步。

### 5. 查看详情

调用 `todo_detail`，参数：`repo`、`item`。

返回实现记录 + PR review 状态（如有关联 PR）。

### 6. 总结

输出任务启动摘要：

```
## Task Ready — {repo}

**Todo**: #{ref} {title}
**类型**: {type}
**难度**: {difficulty}
**关联 Issue**: #{ref}

### 背景
{issue 摘要 + 评论要点}

### 建议方案
{基于 issue 内容和项目上下文的实现建议}

### 相关资源
- Issue: https://github.com/{owner}/{repo}/issues/{ref}
- 实现记录: ~/.contribbot/{owner}/{repo}/todos/{ref}.md
```
