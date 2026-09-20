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
| `todo_list` | 查看本地 todos（YAML），按 ref# 排序，分 Active/Backlog&Ideas/Paused/Done/Cancelled 表格 |
| `todo_add` | 添加 todo，支持 `ref` 参数自动拉 issue label 识别类型 |
| `todo_activate` | 激活 todo：拉 issue 详情 + 评论总结、评估难度、检测已有 claim |
| `todo_detail` | 查看实现记录，自动刷新 PR reviews（5 分钟缓存） |
| `todo_context` | 读取结构化 Todo 与执行；`todo.lifecycle_revision` 缺省为 0 |
| `todo_update` | 状态仅可写 idea/backlog/active；追加笔记或关联 PR，关联不改变主状态 |
| `todo_done` | 完成但不归档；managed 必须携带完整 completion |
| `todo_cancel` | 取消未开工或非受管 Todo：repo、todo_id、expected_lifecycle_revision、decision；不创建执行、不归档 |
| `todo_control` | 记录受管执行的 pause/cancel 请求；取消须以匹配 decision 的本地 stopped 安全收尾 |
| `todo_claim` | 领取 issue 工作项：评论到 GitHub + 本地记录，自动升 active，模板可配置 |
| `todo_delete` | 删除 todo |
| `todo_archive` | 预览 done/cancelled；另行确认精确 ID 与快照后归档 |
| `todo_compact` | 清理归档数据，按日期或条数 |

Todo 仅接受 idea/backlog/active/paused/done/cancelled。旧 Todo 状态的读写均拒绝，
不自动转换；上游条目的 pr_submitted 不受影响。取消版本从 todo_context 获取，
使用 todo.lifecycle_revision，不是 workflow_revision。

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
| Tool | `knowledge_write` | 直接创建/更新项目知识 |
| Tool | `knowledge_propose_update` | 创建可审计的知识更新提案（不写 canonical） |
| Tool | `knowledge_proposals` | 列出提案（pending/applied/rejected） |
| Tool | `knowledge_apply_update` | 应用已批准提案 + provenance 脚注 |
| Tool | `knowledge_reject_update` | 驳回 pending 提案 |

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
├── knowledge.proposals.yaml            # 知识演进提案索引（pending/applied/rejected）
├── todos.archive.yaml                  # 显式归档的终态 todos（done + cancelled）
├── upstream.archive.yaml               # 已归档的上游 daily commits
├── templates/                          # 自定义模板（首次使用自动生成）
│   ├── todo_record.md                  # todo 实现文档模板
│   └── todo_claim.md                   # claim 评论模板
├── knowledge/                          # 项目知识沉淀
└── sync/                               # 同步记录
```

## 每日进度记录

- 用户要求每天记录项目现状与进度，文档入口为 `docs/progress/README.md`，
  按 Asia/Shanghai 日期维护 `docs/progress/YYYY-MM-DD.md`，同一天更新同一份文件。
- 当天有实质推进、验证结果、阻塞变化或用户决定时及时补充，不能只留在对话里，
  也不等每日定时检查才记录。无新增进展时如实注明，不编造工作或补造验收。
- 固定区分前面（发现任务）、中间（执行任务）、后面（交付与沉淀）的当前状态，
  同时记录今日变化、验证证据及限制、阻塞与待决事项、下一步和 Git/运行时/数据状态。
- 区分已设计、已实现、已验证、待用户验收；历史测试注明日期和对应候选，
  不冒充当天重跑。与旧文档或看板矛盾时核实依据并说明，不盲目照抄旧 Next。
- 进度文档不是任务数据库或操作授权；记录本身不完成、取消或归档 Todo，
  不自动提交、推送、清空数据、修改配置或开始新的产品开发。

## 设计规范

- **提问先交代背景** — 向用户提出疑问或请求决策前，先讲清具体场景、已知事实与不确定点、为什么需要用户判断，以及不同选择会影响什么；不让用户在缺少背景时选择技术结论。
- 所有列表/表格输出必须带**备注列**（提供上下文信息）
- 工具间数据不共享状态，每次调用独立
- repo 参数必须显式传 "owner/repo"，无默认值
- **工具不做定性** — 子任务识别、分支命名、噪音过滤的项目级判断交给 LLM
- **模板文件化** — templates/ 目录，首次使用自动生成带注释的默认模板
- **todo 即有文档** — todo_add 时立即创建实现文档
- **用户确认优先** — activate 时 LLM 先出方案大纲，用户确认后再写入
- **结束与归档分开** — done / cancelled 保留未归档；todo_archive 默认预览，用户明确选择精确快照后才归档。恢复展示不等于重开，重开不等于开工。
