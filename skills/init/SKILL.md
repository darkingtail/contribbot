---
name: contribbot:init
description: "初始化当前 Git 仓库的 contribbot 上下文：自动识别 owner/repo、读取项目配置并输出下一步。触发词：contribbot init、初始化 contribbot、进入项目上下文。"
metadata:
  author: darkingtail
  version: "1.0.0"
---

# Contribbot Init

在当前会话进入一个仓库时使用。先从当前目录的 `origin` remote 推导
`owner/repo`，再调用 `project_init` 初始化或读取项目配置，最后输出当前项目上下文。

## 规则

- 如果用户明确提供 `owner/repo`，使用用户提供的值。
- 否则读取当前 Git 仓库的 `origin`。
- 不执行巡检、Issue/PR 写入、Todo 创建或知识库写入。
- 初始化完成后，后续 contribbot 工具调用必须显式使用该 `owner/repo`。

## CLI 备用入口

```bash
uv run --project packages/agent contribbot init
```
