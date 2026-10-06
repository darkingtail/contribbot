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
- 如果项目为 archived，保留归档状态并提示；不得因初始化自动调用 project_restore。
- 初始化完成后，后续 contribbot 工具调用必须显式使用该 `owner/repo`。

## 外部 upstream 确认（不可跳过）

读取 project_init 输出的稳定标记 `<!-- contribbot:upstream-status=pending|configured|none -->`（实际仅一个状态）：

- `pending`：询问用户“是否需要追踪某个外部仓库的变更？若需要，请提供 owner/repo”。不能根据项目名字或 fork parent 猜测外部仓库。
- 明确有：用输出的 canonical repo 调用 `repo_config(repo, upstream="owner/repo")`。
- 明确无：必须调用 `repo_config(repo, upstream="")` 持久记录，不能跳过。
- 未回答、取消、EOF：保持 pending，不能写成明确无；不要宣称配置已完整确认。
- `configured` / `none`：不重复询问。旧配置 upstream 为 null 且没有确认标记时仍是 pending。
- 完成选择后重新读取 project_init；后续工具用 canonical repo，而不是 fork alias。
- 确认 upstream 不意味着获准巡检、首次同步、公开写入或恢复归档。

## CLI 备用入口

```bash
uv run --project packages/agent contribbot init
```

TTY 未确认时询问；非交互不等待输入并报告 pending。
可显式使用 `contribbot init --upstream owner/repo` 或 `contribbot init --no-upstream`（二者互斥）。
`--no-input` 禁止提问；可与一个明确选项组合，未给选项则保留 pending。
