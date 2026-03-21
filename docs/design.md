# contribbot 设计文档

## 定位

开源协作助手。服务于开源贡献者和仓库维护者，帮助高效参与开源项目：收集信息、追踪上游变更、管理任务、沉淀经验。

**核心价值**：上游 commit 级追踪 + triage 决策 + 项目知识沉淀。没有直接竞品（详见 [竞品分析](concepts/competitive-research.md)）。

---

## 项目模式

### ProjectMode — 上下游对齐关系

ProjectMode 描述项目与上游的对齐关系，和 role（GitHub 权限等级）正交。两者独立：任何权限的用户都可能处于任何模式。

通过 `config.yaml` 的 `fork` + `upstream` 字段自动推断（`inferMode`），无需额外 mode 字段：

| fork | upstream | 模式 | 含义 |
|------|----------|------|------|
| 有 | 有 | **fork+upstream** | fork 同步 + 跨栈复刻追踪 |
| 有 | 无 | **fork** | 同源对齐，选择性 cherry-pick |
| 无 | 有 | **upstream** | 非 fork 跨栈追踪 |
| 无 | 无 | **none** | 无上游对齐关系 |

```typescript
// src/core/storage/repo-config.ts
/**
 * ProjectMode — 项目的上下游对齐关系，和 role（权限）正交。
 */
export type ProjectMode = 'none' | 'fork' | 'upstream' | 'fork+upstream'
export function inferMode(config: RepoConfigData): ProjectMode {
  const hasFork = config.fork !== null
  const hasUpstream = config.upstream !== null
  if (hasFork && hasUpstream) return 'fork+upstream'
  if (hasFork) return 'fork'
  if (hasUpstream) return 'upstream'
  return 'none'
}
```

### ProjectMode 与 Role 的关系

| 维度 | 含义 | 值 |
|------|------|---|
| **mode** | 上下游对齐关系 | none / fork / upstream / fork+upstream |
| **role** | GitHub 权限等级 | admin / maintain / write / triage / read |

两者正交——admin 可以是任意 mode，fork 模式的用户可以是任意 role。

> **role 的预期用途**：当前仅作为信息展示。Phase 3 Agent 可据此做权限感知决策（如 role=read 时不尝试创建 issue）。

### 六种场景（fork × upstream × 二开）

| # | fork | upstream | 二开 | 场景 | 例子 |
|---|------|----------|------|------|------|
| 1 | 无 | 无 | 无 | **none** — 无上游对齐 | contribbot |
| 2 | 有 | 无 | 无 | **纯 fork 贡献** — 修 bug 提 PR | fork React 修 issue |
| 3 | 有 | 无 | 有 | **fork + 二开** — 下游消费者 | plane / feature/dev |
| 4 | 有 | 有 | 无 | **fork + 跨栈复刻** — 贡献 + 对齐另一个上游 | antdv-next 对齐 ant-design |
| 5 | 有 | 有 | 有 | **fork + 二开 + 跨栈** — 最复杂 | 理论存在，暂无实例 |
| 6 | 无 | 有 | 无 | **非 fork 跨栈追踪** — 从零建项目追踪外部仓库 | antdv-style 对齐 antd-style |

排除的不现实组合：
- 无 fork + 有 upstream + 有二开：没 fork 谁，二开不成立
- 无 fork + 无 upstream + 有二开：自己的项目自己的分支，不算二开

场景合并关系：
- **#2 ≈ #1 + sync_fork** — 纯 fork 贡献不需要 commit 级追踪
- **#4 和 #6 追踪机制相同** — 都是跨栈复刻追踪，#4 额外需要 sync_fork
- **#5 = 同源追踪 + 跨栈追踪叠加**

### 实际项目

| 项目 | 模式 | 说明 |
|------|------|------|
| **contribbot** | none | 无上游对齐关系 |
| **plane** | fork | fork of makeplane/plane，main 全量对齐，feature/dev 二开分支选择性 cherry-pick |
| **antdv-next** | fork+upstream | fork of antdv-next/antdv-next，upstream: ant-design/ant-design（React → Vue 跨栈复刻） |
| **antdv-style** | upstream | 非 fork，从零建项目追踪 ant-design/antd-style |

---

## 三层核心能力

| 层 | 能力 | 覆盖场景 | 关键工具 |
|----|------|---------|---------|
| 1. 基础 | issue/PR/todo 管理 | 所有模式 | todo_*, issue_*, pr_*, project_dashboard |
| 2. 同源追踪 | fork commit cherry-pick 决策 | #3、#5 | upstream_daily, upstream_daily_act |
| 3. 跨栈追踪 | 外部仓库 commit 复刻决策 | #4、#5、#6 | upstream_daily, upstream_sync_check |

### 两种追踪的本质区别

| | 同源追踪（层2） | 跨栈追踪（层3） |
|---|---|---|
| 关系 | 上游 → 下游消费者 | 上游 → 跨栈复刻 |
| 视角 | "影响我吗？和二开冲突吗？我需要吗？" | "要不要在另一个技术栈实现？难度多大？" |
| 代码关系 | 同源，可直接 cherry-pick | 异源，必须重写 |
| 对齐单位 | commit / PR | feature / bugfix 意图 |

---

## 统一追踪设计

### 核心决策

1. **统一存储** — fork 追踪和跨栈追踪共用 `upstream.yaml`，来源 repo key 天然区分
2. **config.yaml 不改** — 保持 `role`、`org`、`fork`、`upstream` 四个字段，不加 mode/branch
3. **追踪源类型从 config 推断** — upstream.yaml 不存 type 字段
4. **action 枚举不改** — `skip | todo | issue | pr | synced` 覆盖所有场景
5. **不存 cherry-pick / branch 信息** — 追踪层只管 triage 决策，sync 操作不是 contribbot 的责任

### 数据结构

#### config.yaml

```yaml
role: write                         # admin | maintain | write | triage | read
org: antdv-next                     # 组织名（null = 个人仓库）
fork: darkingtail/antdv-next        # 有值 = 有 fork 关系
upstream: ant-design/ant-design     # 有值 = 跨栈追踪
```

#### upstream.yaml

```yaml
"ant-design/ant-design":            # key = 追踪源 repo
  versions:
    - version: "6.3.0"
      status: active                # active | done
      items:
        - title: "feat: xxx"
          type: feature
          difficulty: null           # easy | medium | hard | null
          status: active             # active | pr_submitted | done
          pr: null
  daily:
    last_checked: "2026-03-09"
    commits:
      - sha: abc123
        message: "fix: xxx"
        type: fix
        date: "2026-03-08"
        action: null                 # skip | todo | issue | pr | synced
        ref: null                    # 关联的 issue/PR
```

fork 追踪时，key 变成 fork source（如 `makeplane/plane`），结构完全一样。

#### todos.yaml

```yaml
- ref: "#259"                        # issue 编号或自定义标识
  title: "研究 Cascader showSearch + loadData 共存方案"
  type: feature                      # bug | feature | docs | chore
  status: active                     # idea | backlog | active | pr_submitted | done
  difficulty: medium                 # easy | medium | hard | null
  pr: 42                             # 关联 PR
  branch: "feat/259-cascader-search" # 工作分支（LLM 建议或默认生成）
  claimed_items:                     # 领取的工作项（todo_claim 写入）
    - "重构 Cascader 组件"
    - "修复 loadData 兼容性"
  created: "2026-03-05"
  updated: "2026-03-06"
```

---

## 关键机制

### resolveRepo — Fork 解析

用户传入 fork repo（如 `darkingtail/plane`）时，自动解析到 parent repo（`makeplane/plane`），确保数据统一存储。

解析顺序（快到慢）：
1. 内存缓存
2. 本地已有 config.yaml → 直接是 canonical 路径
3. 扫描现有 config，查找 fork 字段匹配
4. GitHub API 查询是否为 fork，解析到 parent

所有工具函数统一使用 `resolveRepo()` 获取 canonical owner/name。

### upstream_daily 锚点机制

1. **无锚点无 sinceTag** → 展示 releases 列表（无 releases 则 fallback 到 tags），引导选择基准版本
2. **无锚点有 sinceTag** → 初始化：从 releases 或 raw tag 建立锚点
3. **有锚点** → 正常运行：检测新 release，compare anchor..HEAD，去重，auto-detect 已有 issue/PR

### 噪音过滤

通用噪音规则（适用于所有上游仓库）：
- 类型：`ci`、`build`、`style`
- Scope：`deps`
- Message：`bump`、`upgrade dep`、`update dependency`

项目特定过滤由 LLM 通过 skills 上下文处理，不硬编码。

---

## 职责边界

contribbot 的职责：**收集信息、呈现决策、管理任务**。

### Phase 1（MCP Server，寄宿模式）

由宿主（Claude Code 等）控制执行，所有写操作需要用户确认：
- 创建/关闭 issue、创建 PR、评论 — 宿主层确认
- Git 分支管理（cherry-pick、merge）— 不做，由用户手动操作
- 代码变更 — 不做
- 二开分支策略 — 不管，用户只需提供基准版本作为 `since_tag`

### Phase 3（Agent，自主模式）

Agent 自主执行，按安全等级分层：
- **自动执行**：拉取上游 commits、噪音过滤、信息收集
- **自主但可配置**：创建 tracking issue、标记 todo、Git 操作（cherry-pick、merge、branch）
- **始终需要人类确认**：关闭 issue、合并 PR、force push 等不可逆操作

安全边界的具体设计是 Phase 3 的前置条件之一。

---

## 架构

```
src/
├── core/                  ← 纯函数，无 IO 框架依赖
│   ├── clients/
│   │   └── github.ts      # GitHub API 封装（gh CLI / GITHUB_TOKEN）
│   ├── storage/            # YAML 持久化
│   │   ├── todo-store.ts
│   │   ├── upstream-store.ts
│   │   ├── repo-config.ts  # + inferMode
│   │   └── record-files.ts # + 模板化创建 + issue 详情 enrich
│   ├── enums.ts            # as const 枚举 + 运行时校验
│   ├── tools/              # 三层工具分类
│   │   ├── core/           # 23 tools — contribbot 独有
│   │   ├── linkage/        # 4 tools — GitHub + 本地联动
│   │   └── compat/         # 14 tools — 纯 GitHub 封装
│   └── utils/
│       ├── config.ts       # 路径工具
│       ├── format.ts       # 输出格式化
│       ├── frontmatter.ts  # YAML frontmatter 解析
│       ├── fs.ts           # 安全文件写入
│       ├── resolve-repo.ts # fork → parent 解析
│       └── github-helpers.ts
├── mcp/
│   ├── index.ts            # MCP Server 入口（stdio）
│   └── server.ts           # 工具注册 + INSTRUCTIONS + Prompts
└── index.ts                # 统一导出
```

### 数据目录

```
~/.contribbot/{owner}/{repo}/
├── config.yaml
├── todos.yaml
├── todos/                   # todo 实现记录（todo_add 时创建，todo_activate 时 enrich）
│   ├── 281.md
│   └── idea-1.md
├── upstream.yaml
├── upstream/                # 上游实现记录
│   └── {upstream-owner}/{upstream-repo}/
│       └── {version}.md
├── todos.archive.yaml                  # 已完成 todos 归档
├── templates/               # 可自定义模板（首次使用自动生成带注释的默认模板）
│   ├── todo_record.md       # todo 实现文档模板
│   └── todo_claim.md        # claim 评论模板
├── knowledge/               # 项目知识沉淀
└── sync/                    # 同步记录
```

---

## 演进路线

```
Phase 1: Tools（原子操作）        ✅ 已完成
Phase 2: Skills（工具编排模板）    ✅ 已完成
Phase 3: Agents（自主决策）        🔲 内置 LLM，自主调用 Skills
```

| Phase | 状态 | 说明 |
|-------|------|------|
| 1. Tools | ✅ | 41 tools + 1 resource + 4 prompts，寄宿于 Claude Code 等宿主 |
| 2. Skills | ✅ | 10 skills（MCP 工具编排层），三层工具分类（core/linkage/compat） |
| 3. Agents | 🔲 | 独立运行的开源协作 Agent：Docker 部署、聊天入口、定时巡检、记忆系统 |

**Knowledge vs Skills**：`knowledge_write` 产出的是项目知识沉淀（markdown 经验文档）；Skills 是 MCP 之上的工作流编排层（可执行 workflow）。两者互补：知识文档作为 workflow 的上下文输入。

Phase 3 愿景：不只是 Agent SDK 包装，而是像 [nanobot](https://github.com/HKUDS/nanobot) 一样的**独立开源协作 Agent**：
- 独立部署运行（Docker）
- 聊天入口（飞书/Telegram/Discord）
- 定时巡检（每日拉上游 commits、检测 release）
- 记忆系统（跨 session 项目上下文）
- 四种模式自动识别和工作流切换

---

## 设计规范

- 所有列表/表格输出带**备注列**（提供上下文信息）
- 工具间数据不共享状态，每次调用独立
- repo 参数必须显式传 `"owner/repo"`，无默认值
- 所有枚举使用 `as const` + `z.enum()` 运行时校验
- 错误处理统一通过 `wrapHandler` → `isError: true`
- 无硬编码默认值（不绑定任何特定项目）

### 工具不做定性

工具层只负责数据的读写和传递，不做需要理解力的判断：
- **子任务/工作项识别** → LLM 读 issue body 识别，工具只接收结果
- **分支命名** → LLM 分析仓库规范建议，工具提供 fallback 默认值
- **噪音过滤** → 工具做通用规则（CI/deps/build），项目级判断交给 LLM
- **实现方案** → LLM 基于 issue 内容生成，工具只负责写入

### 模板机制

用户可自定义的输出格式通过独立文件管理，不放 config.yaml：
- 存放位置：`~/.contribbot/{owner}/{repo}/templates/{tool_name}.md`
- 首次使用时自动生成带注释的默认模板（说明可用变量）
- 文件名与工具名对应（`todo_record.md`、`todo_claim.md`）
- 渲染时剥离注释头，不泄漏到 GitHub 评论

### Todo 生命周期

```
todo_add → 创建索引 + 实现文档（模板）
         → LLM 推断上下文有想法？→ todo_update(note) 记录

todo_activate → enrich issue 详情到已有文档
             → LLM 生成实现方案 → todo_update(note) 写入

todo_claim → 评论到 GitHub（模板化）+ 本地记录 claimed_items + 自动升 active

todo_detail → 查看文档 + 自动刷新 PR review

todo_done → 标记完成
todo_archive → 归档
```
