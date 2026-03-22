# contribbot

开源协作助手。Monorepo 结构：Skills（Claude Code Plugin）+ MCP Server。支持四种项目模式（ProjectMode）：none / fork / upstream / fork+upstream。

## 项目结构

```
contribbot/
├── packages/
│   └── mcp/                          # contribbot-mcp（npm 包）
│       ├── src/
│       │   ├── core/
│       │   │   ├── clients/
│       │   │   │   └── github.ts     # GitHub API 封装（gh CLI / GITHUB_TOKEN）
│       │   │   ├── storage/          # YAML 持久化
│       │   │   │   ├── todo-store.ts
│       │   │   │   ├── upstream-store.ts
│       │   │   │   ├── repo-config.ts
│       │   │   │   └── record-files.ts
│       │   │   ├── enums.ts          # 统一枚举（as const）
│       │   │   ├── tools/            # 三层工具分类
│       │   │   │   ├── core/         # contribbot 独有（todo_*, upstream_*, repo_config...）
│       │   │   │   ├── linkage/     # GitHub + 本地联动（issue_create, pr_create...）
│       │   │   │   └── compat/      # 纯 GitHub 封装（issue_list, pr_summary...）
│       │   │   └── utils/
│       │   │       ├── config.ts     # 项目路径
│       │   │       ├── format.ts     # markdown 格式化
│       │   │       ├── frontmatter.ts
│       │   │       ├── fs.ts         # 安全文件写入
│       │   │       ├── resolve-repo.ts
│       │   │       └── github-helpers.ts
│       │   ├── mcp/
│       │   │   ├── index.ts          # MCP Server 入口（stdio）
│       │   │   └── server.ts         # 工具注册 + INSTRUCTIONS + Prompts
│       │   └── index.ts              # 统一导出
│       ├── package.json              # contribbot-mcp
│       ├── tsconfig.json
│       └── tsdown.config.ts
├── skills/                           # 10 skills — MCP 工具编排层
│   ├── daily-sync/SKILL.md
│   ├── start-task/SKILL.md
│   ├── pre-submit/SKILL.md
│   ├── weekly-review/SKILL.md
│   ├── project-onboard/SKILL.md
│   ├── fork-triage/SKILL.md
│   ├── todo/SKILL.md
│   ├── issue/SKILL.md
│   ├── pr/SKILL.md
│   └── dashboard/SKILL.md
├── .claude-plugin/                   # Plugin 元数据
├── .mcp.json                         # MCP Server 注册（npx contribbot-mcp）
├── pnpm-workspace.yaml
└── package.json                      # monorepo root
```

## 开发

```bash
pnpm build        # 构建所有子包
pnpm dev          # tsx 直接运行 MCP Server（调试）
pnpm test         # 运行所有测试
```

## 项目模式

通过 `config.yaml` 的 fork + upstream 字段自动推断（`inferMode`）：

| fork | upstream | 模式 | 对齐方式 |
|------|----------|------|---------|
| 有 | 有 | fork+upstream | fork 同步 + 跨栈复刻追踪 |
| 有 | 无 | fork | 同源对齐，选择性 cherry-pick |
| 无 | 有 | upstream | 非 fork 跨栈追踪 |
| 无 | 无 | none | 无上游对齐关系 |

## MCP 工具清单

### 项目概览

| 工具 | 说明 |
|------|------|
| `project_dashboard` | 项目概览：issues/PRs/commits/release |
| `repo_info` | 仓库元信息 |

### Todo 管理（YAML 结构化）

| 工具 | 说明 |
|------|------|
| `todo_list` | 查看本地 todos（YAML），按 ref# 排序，分 Active/Backlog&Ideas/Done 表格 |
| `todo_add` | 添加 todo，支持 `ref` 参数自动拉 issue label 识别类型 |
| `todo_activate` | 激活 todo：拉 issue 详情 + 评论总结、评估难度、创建实现记录文件 |
| `todo_detail` | 查看实现记录，自动刷新 PR reviews（5 分钟缓存） |
| `todo_update` | 更新状态 / 关联 PR / 追加笔记 |
| `todo_done` | 标记完成 |
| `todo_claim` | 领取 issue 工作项：评论到 GitHub + 本地记录，自动升 active，模板可配置 |
| `todo_delete` | 删除 todo |
| `todo_archive` | 归档已完成的 todos |
| `todo_compact` | 清理归档数据，按日期或条数 |

### Issues & PRs

| 工具 | 说明 |
|------|------|
| `issue_list` | Issue 列表（支持 state/label 过滤） |
| `issue_detail` | Issue 详情 |
| `issue_create` | 创建 issue，可关联 upstream commit + 自动建 todo |
| `issue_close` | 关闭 issue，可附评论 + 自动标记 todo done |
| `pr_list` | PR 列表（支持 state 过滤） |
| `pr_summary` | PR 摘要 |
| `pr_create` | 创建 PR，可关联 todo |
| `pr_update` | 更新 PR（标题/描述/状态/草稿） |
| `pr_review_comments` | 列出 PR review 评论（含 ID、diff、内容） |
| `pr_review_reply` | 回复 PR review 评论 |
| `comment_create` | Issue/PR 通用评论 |
| `discussion_list` | Discussion 列表 |
| `discussion_detail` | Discussion 详情 |

### 上游追踪（fork source + 外部 upstream 通用）

| 工具 | 说明 |
|------|------|
| `upstream_sync_check` | 对比上游 release 变更同步状态 |
| `sync_history` | 查看历史同步记录 |
| `upstream_list` | 版本同步总览 + 每日 commits 摘要 |
| `upstream_detail` | 查看某版本同步详情或实现记录 |
| `upstream_update` | 更新同步条目状态 / 关联 PR / 难度 |
| `upstream_daily` | 拉取上游 commits，版本锚定去重，自动检测已有 issue/PR |
| `upstream_daily_act` | 对某条 commit 标记动作（skip/todo/issue/pr） |
| `upstream_daily_skip_noise` | 批量跳过噪音 commits（ci/build/style/deps） |
| `upstream_compact` | 清理已处理的 daily commits，按日期或条数 |

### 质量 & 统计

| 工具 | 说明 |
|------|------|
| `actions_status` | CI 状态 |
| `security_overview` | 安全告警 |
| `contribution_stats` | 个人贡献统计（PR/issue/review） |

### 仓库管理

| 工具 | 说明 |
|------|------|
| `repo_config` | 查看/更新仓库配置（上游、角色、fork 等） |
| `sync_fork` | 同步 fork 到上游最新 |

### 全局

| 工具 | 说明 |
|------|------|
| `project_list` | 所有已跟踪项目概况（todos/upstream 统计） |

### Knowledge（Resource + Tool）

| 类型 | 标识 | 说明 |
|------|------|------|
| Resource | `knowledge://{repo}/{name}` | 只读访问项目知识，支持 list + read |
| Tool | `knowledge_write` | 创建/更新项目知识 |

## 数据存储

所有持久化数据存在 `~/.contribbot/{owner}/{repo}/`：

```
~/.contribbot/{owner}/{repo}/
├── config.yaml                         # 仓库配置（role/org/fork/upstream）
├── todos.yaml                          # todo 索引（YAML 结构化）
├── todos/                              # todo 实现记录
│   ├── 281.md                          # 本仓库 issue
│   └── idea-1.md                       # 纯想法
├── upstream.yaml                       # 上游追踪索引（版本 + 每日 commits）
├── upstream/                           # 上游实现记录
│   └── {upstream-owner}/{upstream-repo}/
│       └── {version}.md
├── todos.archive.yaml                  # 已完成 todos 归档（done + not_planned）
├── upstream.archive.yaml               # 已归档的上游 daily commits
├── templates/                          # 自定义模板（首次使用自动生成）
│   ├── todo_record.md                  # todo 实现文档模板
│   └── todo_claim.md                   # claim 评论模板
├── knowledge/                          # 项目知识沉淀
└── sync/                               # 同步记录
```

## 设计规范

- 所有列表/表格输出必须带**备注列**（提供上下文信息）
- 工具间数据不共享状态，每次调用独立
- repo 参数必须显式传 "owner/repo"，无默认值
- **工具不做定性** — 子任务识别、分支命名、噪音过滤的项目级判断交给 LLM
- **模板文件化** — templates/ 目录，首次使用自动生成带注释的默认模板
- **todo 即有文档** — todo_add 时立即创建实现文档
- **用户确认优先** — activate 时 LLM 先出方案大纲，用户确认后再写入
- **not_planned 自动归档** — 标记 not_planned 时自动移入 todos.archive.yaml
