---
name: contribbot:start-task
description: "开始一个任务：进入项目上下文、选择 todo、激活并查看详情。触发词：'start task'、'开始任务'、'开工'。"
metadata:
  author: darkingtail
  version: "1.0.0"
  argument-hint: <owner/repo> [todo item]
---

# Start Task — 开始任务

进入项目上下文，选择并激活一个 todo，了解完整背景后开始工作。需要 contribbot MCP Server。

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。
- 可选提供 `item`（todo 索引或关键词）。

## 步骤

### 1. 进入项目上下文

```
repo_config(repo) → 获取模式和配置
project_dashboard(repo) → 项目全貌
```

如果是 fork 模式，提醒用户是否需要先 `sync_fork` 同步上游（避免基于过时代码工作）。

### 2. 查看 Todo 列表

```
todo_list(repo) → Active / Backlog & Ideas / Done 三表
```

### 3. 选择 Todo

- 如果用户指定了 `item`：直接使用
- 如果未指定：根据以下维度推荐：
  - 优先级（ref# 关联的 issue label）
  - 难度（已评估的优先选）
  - 状态（backlog 优先于 idea）
  - 上下文（是否与当前上游变更相关）

### 4. 激活 Todo

```
todo_activate(repo, item) → 拉取 issue 详情 + 评论总结、评估难度、创建实现记录文件
```

### 5. 查看详情

```
todo_detail(repo, item) → 实现记录内容，含 PR reviews（如有）
```

### 6. 总结

输出任务启动摘要：

```
## Task Ready — {repo}

**Todo**: #{ref} {title}
**类型**: {type}（bug/feat/chore/...）
**难度**: {difficulty}
**关联 Issue**: #{issue_number}

### 背景
{issue 摘要 + 评论要点}

### 建议方案
{基于 issue 内容和项目上下文的实现建议}

### 相关资源
- Issue: {url}
- 实现记录: {record_file_path}
```
