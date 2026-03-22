# contribbot

> /kənˈtrɪbɒt/ — contrib 中的 b 不发音，同 contribute

[English](README.md) | 中文

开源协作助手。帮助开发者高效参与开源项目的维护和贡献。

MCP 工具 + Skills — 任务管理、上游追踪、Issue/PR 工作流、多项目总览。

## 前置要求

- [GitHub CLI](https://cli.github.com/) (`gh`) — 已登录 (`gh auth login`)

## 安装

### Claude Code

```bash
# 第一步：添加 marketplace（仅首次需要）
claude plugin marketplace add https://github.com/darkingtail/contribbot

# 第二步：安装
claude plugin install contribbot
```

安装后自动获得 Skills + MCP Server（`contribbot-mcp`）。Skills 提供引导式工作流，MCP Server 提供工具。

### 其他平台

contribbot 的 MCP Server 兼容所有支持 MCP 的工具。详见 [其他平台配置](docs/platforms.md)（Claude Desktop、Gemini CLI、Codex CLI、Cursor、Windsurf 等）。

## contribbot 能帮你做什么

大多数 AI 编码工具能读 GitHub issue、创建 PR。contribbot 做得更多——它追踪**你在做什么**、**上游改了什么**、**谁在做什么**，解决多人维护同一仓库时的协调问题。

### 和 GitHub CLI 的区别

|               | gh CLI | contribbot                         |
| ------------- | ------ | ---------------------------------- |
| 读取 Issue/PR | ✅     | ✅                                 |
| 创建 Issue/PR | ✅     | ✅ + 自动关联本地 todo             |
| 追踪个人任务  | ❌     | ✅ 完整的 todo 生命周期 + 实现文档 |
| 追踪上游变更  | ❌     | ✅ commit 级追踪 + triage 决策     |
| 多人协调      | ❌     | ✅ 领取工作项，自动评论到 GitHub   |
| Fork 对齐     | ❌     | ✅ 同步 fork + cherry-pick 决策    |
| 跨栈追踪      | ❌     | ✅ 追踪 React → Vue 功能对齐       |
| 项目知识      | ❌     | ✅ 按仓库持久化的知识沉淀          |

### Skills

Skills 是引导式工作流，编排 MCP 工具完成复杂任务。在 Claude Code 中通过名称或自然语言触发。

| Skill                        | 说明                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `contribbot:project-onboard` | 新项目接入 — 检测 fork/upstream 关系、初始化配置、首次同步     |
| `contribbot:daily-sync`      | 每日巡检 — 同步 fork、拉取上游 commits、跳噪音、triage         |
| `contribbot:start-task`      | 开始任务 — 选择 todo、激活、LLM 生成实现方案（用户确认后写入） |
| `contribbot:todo`            | 任务管理 — 添加、激活、领取、更新、完成、归档、清理            |
| `contribbot:issue`           | Issue 管理 — 浏览、详情、创建、关闭、评论                      |
| `contribbot:pr`              | PR 管理 — 浏览、摘要、创建、更新、review、回复                 |
| `contribbot:pre-submit`      | 合并前检查 — PR review、CI 状态、安全告警                      |
| `contribbot:weekly-review`   | 周回顾 — 贡献统计、进展回顾、清理归档                          |
| `contribbot:fork-triage`     | 二开分支 cherry-pick 决策                                      |
| `contribbot:dashboard`       | 项目概况 — 单项目或跨项目总览                                  |

## 项目模式

contribbot 自动检测你的仓库与上游的关系，适配相应的工作流。

| 模式              | 条件                 | 启用的能力                   |
| ----------------- | -------------------- | ---------------------------- |
| **none**          | 无 fork、无 upstream | Issue/PR/todo 管理           |
| **fork**          | 有 fork 来源         | fork 同步 + cherry-pick 决策 |
| **upstream**      | 有外部 upstream      | 跨栈 commit 追踪             |
| **fork+upstream** | 两者都有             | fork 同步 + 跨栈追踪         |

运行 `/contribbot:project-onboard` 自动检测并配置。

### 为什么 fork 仓库的数据存在 parent 目录下

当你在 `darkingtail/plane`（fork of `makeplane/plane`）上工作时，contribbot 把数据存在 `~/.contribbot/makeplane/plane/` —— **parent 仓库**路径下。

原因：多人可能 fork 同一个仓库。以 parent 为基准存储，确保所有人的本地数据对齐到同一个规范仓库，`sync_fork` / `upstream_daily` 始终知道哪个是上游。

你的 fork 记录在 `config.yaml` 的 `fork` 字段中：

```yaml
# ~/.contribbot/makeplane/plane/config.yaml
role: admin
org: null
fork: darkingtail/plane # 你的 fork
upstream: null
```

### 三层核心能力

| 层       | 能力                         | 适用模式                |
| -------- | ---------------------------- | ----------------------- |
| 基础     | Issue/PR/todo 管理           | 所有模式                |
| 同源追踪 | fork 来源的 cherry-pick 决策 | fork、fork+upstream     |
| 跨栈追踪 | 跨技术栈的功能对齐追踪       | upstream、fork+upstream |

## 数据存储

所有数据本地存储在 `~/.contribbot/{owner}/{repo}/`：

```
~/.contribbot/{owner}/{repo}/
├── config.yaml              # 仓库配置
│                            #   role: admin|maintain|write|triage|read
│                            #   org: 组织名或 null
│                            #   fork: 你的 fork 仓库或 null
│                            #   upstream: 跨栈追踪的外部仓库或 null
│
├── todos.yaml               # 活跃 todos
│                            #   ref: issue 编号（#123）或自定义标识
│                            #   title、type（bug/feature/docs/chore）
│                            #   status: idea → backlog → active → pr_submitted → done | not_planned
│                            #   difficulty: easy|medium|hard
│                            #   pr、branch、claimed_items
│
├── todos/                   # 实现文档（每个 todo 一个）
│   ├── 123.md               #   todo_add 时创建，todo_activate 时补充 issue 详情
│   └── playground.md        #   LLM 在此生成实现方案
│
├── todos.archive.yaml       # 已归档的 todos（done + not_planned）
│                            #   用 todo_compact 清理旧条目
│
├── upstream.yaml            # 上游追踪
│                            #   versions: release 级同步状态
│                            #   daily: commit 级 triage（action: skip|todo|issue|pr|synced）
│
├── upstream.archive.yaml   # 已归档的上游 daily commits
│                            #   由 upstream_compact 移入
│
├── upstream/                # 上游实现文档
│   └── {owner}/{repo}/
│       └── {version}.md
│
├── templates/               # 自定义模板（首次使用时自动生成带注释的默认模板）
│   ├── todo_record.md       #   todo 实现文档模板
│   └── todo_claim.md        #   GitHub claim 评论模板
│
├── knowledge/               # 项目知识沉淀（通过 knowledge_write）
│   └── {name}/README.md
│
└── sync/                    # 同步历史记录
```

## 工具架构

工具分三层：

```
tools/
├── core/      contribbot 独有（todo、upstream、knowledge、config）
├── linkage/   GitHub 操作 + 本地数据联动（issue_create、pr_create...）
└── compat/    GitHub API 封装，保证开箱即用
```

- **核心层** — GitHub MCP 无法替代。todo 管理、上游追踪、知识沉淀、仓库配置、归档清理。
- **联动层** — GitHub 操作同时更新本地数据（如 `issue_create` 自动创建 todo）。
- **兼容层** — 纯 GitHub API 封装。确保不装 GitHub MCP 也能正常使用。

完整工具列表：[docs/tools.md](docs/tools.md)

## 自定义

### 模板

模板在首次使用时自动生成（带变量说明注释），编辑即可自定义：

- `templates/todo_record.md` — todo 实现文档格式
  - 变量：`{{title}}`、`{{ref}}`、`{{type}}`、`{{date}}`
- `templates/todo_claim.md` — GitHub claim 评论格式
  - 变量：`{{items}}`、`{{user}}`、`{{repo}}`、`{{issue}}`

### 归档 & 清理

归档数据会随时间增长。用 `todo_compact` / `upstream_compact` 按日期或条数清理。详见 [docs/tools.md](docs/tools.md)。

### 配置

`config.yaml` 在首次使用 `repo_config` 时自动检测生成：

| 字段       | 说明                                     |
| ---------- | ---------------------------------------- |
| `role`     | 你的 GitHub 权限等级（自动检测）         |
| `org`      | 组织名（自动检测）                       |
| `fork`     | 你的 fork 仓库（如果当前是 parent 仓库） |
| `upstream` | 跨栈追踪的外部仓库                       |

## 参与开发

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

MIT
