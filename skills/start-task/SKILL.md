---
name: contribbot:start-task
description: "开始一个任务：进入项目上下文、选择 todo、激活并查看详情。触发词：'start task'、'开始任务'、'开工'。"
metadata:
  author: darkingtail
  version: "2.0.0"
  argument-hint: <owner/repo> [todo item]
---

# Start Task — 开始任务

进入项目上下文，选择并激活一个 todo，了解完整背景后开始工作。

数据格式参考：`references/data-format.md`

## 前置

- 用户提供 `repo`（owner/repo 格式）。如未提供，询问。
- 可选提供 `item`（todo 索引或关键词）。
- 需要 `gh` CLI 已认证。

## 步骤

### 1. 进入项目上下文

读取 `~/.contribbot/{owner}/{repo}/config.yaml` 获取模式。

快速了解项目状态：
```bash
gh issue list -R {owner}/{repo} --state open --json number,title,labels --limit 10
gh pr list -R {owner}/{repo} --state open --json number,title,state --limit 5
```

如果是 fork 模式，提醒用户是否需要先同步 fork：
```bash
gh repo sync {owner}/{repo}
```

### 2. 查看 Todo 列表

读取 `~/.contribbot/{owner}/{repo}/todos.yaml`，按状态分组展示：

- **Active**：status = active 或 pr_submitted
- **Backlog & Ideas**：status = backlog 或 idea
- **Done**：status = done

每条显示：序号、ref、title、type、status、difficulty。

### 3. 选择 Todo

- 如果用户指定了 `item`：按索引或 title/ref 关键词匹配
- 如果未指定：根据优先级推荐（backlog > idea，有 ref 的优先）

### 4. 激活 Todo

将选中 todo 的 status 更新为 `active`，更新 `updated` 日期，写回 todos.yaml。

如果 todo 有 ref（issue 编号），拉取 issue 详情：
```bash
gh issue view {ref} -R {owner}/{repo} --json number,title,body,labels,comments,state
```

创建实现记录文件 `~/.contribbot/{owner}/{repo}/todos/{ref}.md`（如不存在），写入：
```markdown
# {ref}: {title}

## Issue 摘要
{issue body 摘要}

## 评论要点
{关键评论总结}

## 实现笔记
（待填写）
```

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
