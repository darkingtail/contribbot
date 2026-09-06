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

先调用 `project_guidance`（repo）读取项目规范文档和本地 Knowledge。

分支命名依据按以下优先级处理：

1. 项目规范文档（如 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING.md` 或仓库中明确的开发文档）
2. contribbot Knowledge
3. 最近实际使用的分支样本（如当前宿主能够提供）
4. 默认命名规则

如果规范文档没有说明分支命名，不要声称已经读取到规范；可以使用默认命名并明确标注依据。

调用 `todo_activate`，参数：`repo`、`item`、`branch`（建议的分支名，如无法判断可省略使用默认值）。

工具会自动：
- 更新 status 为 active
- 拉取关联 issue 详情 + 评论总结
- 评估难度
- 记录分支名（不自动创建远程分支）

activate 完成后，基于 issue 内容（body + 评论 + 标签）生成实现方案**大纲**，展示给用户：

```
## 实现方案（草案）

### 问题分析
...

### 实现思路
...

### 关键改动点
...

### 注意事项
...
```

等待用户反馈：
- **确认** → 调用 `todo_update(note=实现方案)` 写入文档，告知已写入 + 文档路径
- **调整** → 根据用户意见修改后再确认
- **跳过** → 不写入，用户后续自己补充

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

### 7. 沉淀可复用知识（可选）

如果在调查/激活过程中发现了**可复用的项目知识**（架构约定、CI 行为、调试技巧、维护者偏好等），
不要直接 `knowledge_write` 静默写入，而是提案待审：

调用 `knowledge_propose_update`，参数：
- `repo`、`target`（知识条目名）、`action`（create/append/revise）
- `source_type: todo`、`source_ref`（todo 的 ref）
- `title`、`rationale`（为什么值得沉淀）、`proposed_content`（完整 markdown）

提示用户提案已创建（返回 `kp-N`），待 review 后用 `knowledge_apply_update` 应用。
