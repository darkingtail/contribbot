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

调用 `todo_activate`，参数：`repo`、`item`。

工具会自动：
- 更新 status 为 active
- 拉取关联 issue 详情 + 评论总结
- 评估难度
- 创建实现记录文件

### 4. 查看详情

调用 `todo_detail`，参数：`repo`、`item`。

返回实现记录 + PR review 状态（如有关联 PR）。

### 5. 总结

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
