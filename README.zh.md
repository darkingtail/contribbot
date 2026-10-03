# contribbot

> /kənˈtrɪbɒt/ — contrib + bot，两个 b 合并只读一个

[English](README.md) | 中文

正在演进为仓库级巡检 Agent 的开源协作助手。

稳定的 MCP 工具与 Skills 负责任务管理、上游追踪、Issue/PR 工作流和多项目总览。Phase 3 运行时已经支持可恢复巡检、多项目调度、知识进化和隔离修复。

## Phase 3 巡检（实验性）

运行一次仓库维护闭环：

```bash
uv sync --project packages/agent
uv run --project packages/agent contribbot patrol darkingtail/contribbot
```

Patrol 通过 contribbot MCP 工具观察仓库状态，调用 Codex 生成结构化判断，保存报告和完整审计轨迹；发现知识候选时先询问，再创建可审查的知识提案。MVP 不执行任何 GitHub 公共写入。

```bash
# 从任意目录巡检全部已维护仓库
uv run --project D:/dev/darkingtail/contribbot/packages/agent contribbot patrol-all

# 运行一次定时配置；无变化时保持静默
uv run --project packages/agent contribbot patrol-schedule --once --config agent.json

# 在隔离 worktree 中修改并验证，不 commit / push / 创建 PR
uv run --project packages/agent contribbot remediate D:/dev/my-repo \
  --prompt "修复失败测试" --validate "pnpm test"
```

行为、安全边界和审计文件详见 [仓库巡检 Agent](docs/agent/patrol.md)。

## 前置要求

- GitHub 实际操作：已登录的 [GitHub CLI](https://cli.github.com/)（`gh auth login`）
  或 `GITHUB_TOKEN`。MCP 启动和已有项目的离线读取不要求 GitHub 登录。
- GitLab 首次初始化：能够访问选定实例；私有访问的凭据由可信启动环境按
  精确 HTTPS 实例绑定。详见[凭据接口](docs/tools.md#gitlab-首次只读初始化)。

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

| Skill | 说明 | 备注 |
| --- | --- | --- |
| `contribbot:project-onboard` | 初始化管理主体，确认 tracking 选择 | 首次同步另行授权 |
| `contribbot:daily-sync` | 日常维护与已配置来源的变更研判 | parent 同步和 tracking 分开 |
| `contribbot:start-task` | 选择 Todo、激活并拟定方案 | 方案确认后再实施 |
| `contribbot:todo` | 添加、激活、推进、领取、完成、取消和归档 | 完成不自动归档 |
| `contribbot:issue` | 浏览、查看、创建、关闭和评论 | 公开写入需要授权 |
| `contribbot:pr` | 浏览、摘要、创建、更新、审查和回复 | PR 进度与 Todo 主状态分开 |
| `contribbot:pre-submit` | PR review、CI 状态和安全检查 | 检查通过不等于发布授权 |
| `contribbot:weekly-review` | 贡献统计与任务进展回顾 | 归档另行决定 |
| `contribbot:fork-triage` | 评估二开分支的 cherry-pick | 不自动执行挑选结果 |
| `contribbot:dashboard` | 单项目或跨项目总览 | 各主体的身份和数据分别展示 |

## 项目模式

当前源码使用 schema v3。模式由已核实的 `parent` 关系和用户的
`tracking` 选择推导，不额外保存“项目类型”字段。

| 模式 | 条件 | 可用流程 | 备注 |
| --- | --- | --- | --- |
| **none** | 无已确认 parent，且未配置追踪 | 本地 Todo 与已支持的仓库工具 | 不把 parent 未知当作不存在 |
| **fork** | 已确认 parent，未配置追踪 | 经授权同步 fork | 不自动追踪 parent |
| **tracking** | 无已确认 parent，已配置追踪 | commit / release 追踪 | 来源由用户明确选择 |
| **fork+tracking** | 已确认 parent，已配置追踪 | fork 同步与来源追踪 | 两种操作分别处理 |

`tracking.pending` 不等于 `tracking.none`：未回答仍保持未决定。
`project_init` 首次创建 `parent.unknown` 的最小配置，已有配置可离线读取。
显式 `parent_refresh` 核实 GitHub.com 项目的直接 parent，仅更新本地关系快照。
`unavailable` 保留旧快照与旧核实时间，不算本轮新证据；
不会初始化、同步代码、改 tracking、项目生命周期或 Todo。
schema 整体升级尚未验收，见[当前进度](docs/progress/README.md)。

### 每个仓库保留自己的数据

管理 `darkingtail/antdv-next` 时，Todo、Consult 和 Knowledge 始终属于该
仓库，即使它是 fork。`parent` 只描述直接来源，不把存储重定向过去，
也不替某次 PR 决定目标。

以下是最小配置形状示例，不代表已经核实实际 fork 关系：

```yaml
# ~/.contribbot/projects/v1/<repository-digest>/config.yaml
schema_version: 3
repository:
  platform: github
  instance: https://github.com
  path: darkingtail/antdv-next
lifecycle:
  status: active
parent:
  status: unknown
tracking:
  status: pending
```

每次仓库范围 MCP 调用都传入完整 `{platform, instance, path}` 对象。
宿主可记住已确认的项目，但 MCP 不保存隐式项目绑定。schema v3 能表示
GitHub 和 GitLab 实例。GitLab 首次初始化已实现单次只读身份 GET，可使用
精确实例绑定的凭据；已有合法配置仍可离线读取。当前验证仅使用假 token
和模拟响应，未验证真实部署。GitLab 的 Issue/MR、parent 核实及远端追踪
尚未实现，这些远端流程仍仅支持 GitHub.com。能表示身份不等于有访问权限。

## 数据存储

仓库级数据存储在 `~/.contribbot/projects/v1/<repository-digest>/`。
digest 来自完整平台、实例和路径，读取时核对配置身份；旧 owner/repo
目录不自动迁移或清空。

```
~/.contribbot/projects/v1/<repository-digest>/
├── config.yaml              # 恰好五个根字段：
│                            #   schema_version、repository、lifecycle、parent、tracking
│
├── todos.yaml               # 未归档 todos，包含 done / cancelled
│                            #   id: 稳定 Todo 身份
│                            #   ref: issue 编号（#123）或自定义标识
│                            #   title、type（bug/feature/docs/chore）
│                            #   status: idea|backlog|active|paused|done|cancelled
│                            #   PR 进度独立；完成或取消不自动归档
│                            #   difficulty: easy|medium|hard
│                            #   pr、branch、claimed_items
│
├── todos/                   # 实现文档（每个 todo 一个）
│   ├── 123.md               #   todo_add 时创建，todo_activate 时补充 issue 详情
│   └── playground.md        #   LLM 在此生成实现方案
│
├── todos.archive.yaml       # 另行明确归档的 todos（done + cancelled）
│                            #   用 todo_compact 清理旧条目
│
├── upstream.yaml            # schema_version: 1；sources 以来源 digest 为键
│                            #   每个来源含 repository、versions、daily
│
├── upstream.archive.yaml   # 已归档的上游 daily commits
│                            #   由 upstream_compact 移入
│
├── upstream/                # 上游实现文档
│   └── <source-digest>/
│       └── {version}.md
│
├── templates/               # 自定义模板（首次使用时自动生成带注释的默认模板）
│   ├── todo_record.md       #   todo 实现文档模板
│   └── todo_claim.md        #   GitHub claim 评论模板
│
├── knowledge/               # 项目知识沉淀（通过 knowledge_write）
│   └── {name}/README.md
│
├── patrol/                  # Phase 3 巡检报告与审计文件
│   ├── latest.md
│   └── runs/{run-id}/       # report、snapshot、analysis、trace
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

只有 `project_init` 在核实身份后创建最小配置。`repo_config` 用来读取或
保存明确的追踪选择；项目不存在时返回 `not_initialized`，不自动创建。

| 字段 | 说明 | 备注 |
| --- | --- | --- |
| `schema_version` | `3` | 拒绝旧配置形状，不自动转换 |
| `repository` | 管理主体的 `{platform, instance, path}` | 普通配置更新不能改变身份 |
| `lifecycle` | 本地项目 active / archived | 与 Todo 和远端仓库状态分开 |
| `parent` | 直接 fork 来源事实快照 | unknown / none / confirmed；不是操作授权 |
| `tracking` | 用户明确选择的来源 | pending / none / configured；来源使用完整身份 |

权限按远端操作分别核实，不持久化 `role` / `org`。精确字段、时间语义、
身份规范化和存储规则见 [schema v3 契约](docs/plans/2026-09-29-project-config-contract.md)。

## 参与开发

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

MIT
