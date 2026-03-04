# Todo 系统重新设计

[TOC]

## 背景

当前 todo 系统是简单的 checkbox 列表（`- [ ] #281 ...`），缺少结构化字段、生命周期管理和实现记录。
contrib 的终态是 Agent，需要结构化数据支撑自主决策。

## 设计目标

- 存储从 markdown checkbox 升级为 YAML 结构化数据
- 支持 todo 生命周期：idea → backlog → active → pr_submitted → done
- active 状态触发重操作：拉取 issue 详情 + 评论总结、评估难度、创建实现记录文件
- 查看详情时自动刷新 PR reviews
- 上游版本同步独立管理，与 todo 分离

## 数据模型

### `todos.yaml` — todo 索引

只管本仓库 issue 和纯想法，不含上游同步。

```yaml
todos:
  - ref: "#281"
    title: 补充模型下载镜像配置文档
    type: docs                               # bug | feature | docs | chore
    status: active                           # idea | backlog | active | pr_submitted | done
    difficulty: easy                         # easy | medium | hard | null
    pr: 420                                  # 关联 PR 编号
    created: 2026-03-01
    updated: 2026-03-03

  - ref: null                                # 纯想法
    title: 研究 WebSocket 方案替代轮询
    type: feature
    status: idea
    difficulty: null
    pr: null
    created: 2026-03-03
    updated: 2026-03-03
```

### `upstream.yaml` — 上游同步索引

按上游仓库组织，每个仓库下包含版本模式（versions）和每日模式（daily）两种互补的同步追踪。

- **版本模式**：release 粒度，上游发新版时结构化追踪同步进度
- **每日模式**：commit 粒度，每日拉取上游 master commits，持久化并去重

```yaml
ant-design/ant-design:
  # ── 版本模式 ──
  versions:
    - version: "6.3.1"
      status: active                         # active | done
      items:
        - title: 同步 Segmented 组件 block 属性
          type: feature
          difficulty: hard
          status: active                     # active | pr_submitted | done
          pr: null
        - title: 修复 Segmented disabled 样式
          type: bug
          difficulty: easy
          status: done
          pr: 430

    - version: "6.3.0"
      status: done
      items:
        - title: 同步 Button loading 动画
          type: feature
          difficulty: medium
          status: done
          pr: 410

  # ── 每日模式 ──
  daily:
    last_checked: "2026-03-03"
    commits:
      - sha: "abc1234"
        message: "feat(Button): add loading delay prop"
        type: feat                           # feat | fix | refactor | docs | chore | ...
        date: "2026-03-03"
        action: null                         # null | skip | todo | issue | pr
        ref: null                            # 关联的 issue/PR/todo 编号
      - sha: "def5678"
        message: "fix(Modal): prevent scroll lock on iOS"
        type: fix
        date: "2026-03-02"
        action: pr
        ref: "#180"                          # 已自动检测到目标仓库存在对应 PR
```

### 每日模式去重逻辑

- 用 **sha** 去重：已记录的 commit 不重复添加
- 自动检测：拉取新 commits 后，搜索目标仓库是否已有对应的 issue/PR（通过 commit message 关键词匹配），自动填充 `action` 和 `ref`

### ref 格式（仅 todos.yaml）

| 格式 | 含义 | 自动生成链接 |
|------|------|-------------|
| `#281` | 本仓库 issue | `https://github.com/{owner}/{repo}/issues/281` |
| `null` | 纯想法 | 无 |

### todo 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| ref | string \| null | 否 | 本仓库 issue 引用 |
| title | string | 是 | 简短说明 |
| type | enum | 是 | bug / feature / docs / chore |
| status | enum | 是 | idea / backlog / active / pr_submitted / done |
| difficulty | enum \| null | 否 | easy / medium / hard，进入 active 时自动评估 |
| pr | number \| null | 否 | 关联 PR 编号 |
| created | date | 是 | 创建时间 |
| updated | date | 是 | 最后更新时间 |

### upstream item 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | 同步项说明 |
| type | enum | 是 | feature / bug / chore |
| difficulty | enum \| null | 否 | easy / medium / hard |
| status | enum | 是 | active / pr_submitted / done |
| pr | number \| null | 否 | 关联 PR 编号 |

## 文件结构

```
~/.contrib/{owner}/{repo}/
├── todos.yaml                          # todo 索引
├── todos/                              # todo 实现记录
│   ├── 281.md                          # 本仓库 issue
│   └── idea-1.md                       # 纯想法
├── upstream.yaml                       # 上游同步索引
└── upstream/                           # 上游同步实现记录（层级式）
    └── ant-design/ant-design/
        ├── 6.3.0.md
        └── 6.3.1.md
```

### 文件命名规则

| 类型 | 文件路径 |
|------|---------|
| 本仓库 issue `#281` | `todos/281.md` |
| 纯想法 | `todos/idea-{自增ID}.md` |
| 上游同步 `ant-design/ant-design@6.3.1` | `upstream/ant-design/ant-design/6.3.1.md` |

### 实现记录模板 — issue 类

```markdown
# #281 补充模型下载镜像配置文档

## Issue 信息
- 链接: https://github.com/agentscope-ai/CoPaw/issues/281
- 标签: documentation
- 作者: zhangsan
- 创建时间: 2026-02-15

## 评论总结
- @user1: 建议用环境变量方案，不要改默认配置
- @user2: ModelScope 需要单独处理 token 认证
- 共识：先支持 HF_ENDPOINT，再加 ModelScope

## 分析
涉及文件：docs/configuration.md
当前 README 完全没有提及镜像配置，用户在国内下载模型经常超时。

## 实现计划
1. [ ] 调研 HF_ENDPOINT 环境变量用法
2. [ ] 补充 ModelScope 下载示例
3. [ ] 添加 troubleshooting 段落

## PR 反馈
### PR #420 — 2026-03-02
- @reviewer1: 建议加一个网络检测的 tip
- @reviewer2: LGTM
- 状态: changes_requested

### Round 2 — 2026-03-03
- 已补充网络检测说明，re-request review
```

### 实现记录模板 — 上游同步类

```markdown
# ant-design/ant-design@6.3.1

## Release 信息
- 链接: https://github.com/ant-design/ant-design/releases/tag/6.3.1
- 发布时间: 2026-02-28

## 同步项
- feat: Segmented 组件新增 block 属性 → **active**
- fix: Segmented disabled 样式修正 → **done** (PR #430)

## 实现计划
### Segmented block 属性
1. [ ] 对齐 Segmented props 定义
2. [ ] 迁移样式变更
3. [ ] 补充测试用例

## PR 反馈
### PR #430 — Segmented disabled 样式
- @reviewer1: LGTM
- 状态: merged
```

## 生命周期与自动化

### Todo 生命周期

```
todo_add "#281 补充镜像文档"
  → 自动拉 issue label → type: docs
  → status: idea

todo_activate 1
  → 拉 issue 详情 + 评论总结
  → 评估难度 → difficulty: easy
  → 创建 todos/281.md 骨架
  → status: active

todo_update 1 --pr 420
  → status: pr_submitted
  → 记录 PR 编号

todo_detail 1
  → 展示 todos/281.md
  → 自动拉取 PR #420 最新 reviews 追加到反馈段（5 分钟内不重复拉取）

todo_done 1
  → status: done
```

### 状态触发的自动操作

| 状态变更 | 自动操作 |
|----------|---------|
| → `idea` | 如有 ref `#issue`，自动拉 issue label 填充 type |
| → `active` | 拉 issue 详情 + 评论总结、评估难度、创建实现记录文件 |
| → `pr_submitted` | 记录 PR 编号 |
| 查看 `detail` | 自动刷新 PR reviews（5 分钟缓存） |
| → `done` | 归档 |

## 工具 API

### Todo 工具

| 工具 | 说明 | 参数 |
|------|------|------|
| `todo_list` | 列出所有 todo，表格输出 | `repo`, `status?` |
| `todo_add` | 添加 todo | `text`, `ref?`, `repo` |
| `todo_activate` | 提升为 active，触发重操作 | `item`, `repo` |
| `todo_detail` | 查看单条详情 + 自动刷新 PR | `item`, `repo` |
| `todo_update` | 更新状态/关联 PR/追加备注 | `item`, `status?`, `pr?`, `note?`, `repo` |
| `todo_done` | 标记完成 | `item`, `repo` |

### Upstream 工具 — 版本模式（复用/扩展现有 `upstream_sync_check`）

| 工具 | 说明 | 参数 |
|------|------|------|
| `upstream_sync_check` | 检查上游新版本（已有） | `version?`, `upstream_repo?`, `target_repo?`, ... |
| `upstream_list` | 列出所有上游同步状态 | `repo`, `upstream_repo?` |
| `upstream_detail` | 查看某版本同步详情 | `upstream_repo`, `version`, `repo` |
| `upstream_update` | 更新同步项状态/关联 PR | `upstream_repo`, `version`, `item`, `status?`, `pr?`, `repo` |

### Upstream 工具 — 每日模式

| 工具 | 说明 | 参数 |
|------|------|------|
| `upstream_daily` | 拉取上游 master 近期 commits，去重追加，自动检测已有 issue/PR | `upstream_repo`, `days?`(默认 7), `repo` |
| `upstream_daily_act` | 对某条 commit 标记动作 | `upstream_repo`, `sha`, `action`(skip/todo/issue/pr), `ref?`, `repo` |

## 输出格式

### `todo_list` 输出

分组表格，按 ref 序号升序排序（无 ref 的排最后按创建时间）。

Active 表格：

| # | Ref | Type | Title | Difficulty | Status | PR |
|---|-----|------|-------|------------|--------|----|
| 1 | [#159](...) | feature | 补充单元测试 + 完善贡献指南 | 🟡 medium | active | — |
| 2 | [#281](...) | docs | 补充模型下载镜像配置文档 | 🟢 easy | active | — |
| 3 | [#313](...) | bug | Win UTF-8 BOM 导致无限循环 | 🟡 medium | pr_submitted | [#420](...) |

Backlog & Ideas 表格（无难度列）：

| # | Ref | Type | Title | Status |
|---|-----|------|-------|--------|
| 4 | [#295](...) | feature | WebUI ECharts 图表内联渲染 | backlog |
| 5 | — | feature | 研究 WebSocket 方案替代轮询 | idea |

Done 表格：

| # | Ref | Type | Title | Difficulty | PR |
|---|-----|------|-------|------------|----|
| 1 | [#63](...) | feature | Notification 单元测试 | 🟢 easy | [#65](...) |

### `upstream_list` 输出

```markdown
## Upstream — ant-design/ant-design
> Versions: 1 active · 1 done | Daily: 最后检查 2026-03-03

### 版本同步
| Version | Status | Items | Progress |
|---------|--------|-------|----------|
| [6.3.1](...) | active | 2 items | 1/2 done |
| [6.3.0](...) | done | 1 item | 1/1 done |

### 每日 Commits（待处理）
| # | Date | Type | Commit | Action | Ref |
|---|------|------|--------|--------|-----|
| 1 | 03-03 | feat | Button: add loading delay prop | — | — |
| 2 | 03-02 | refactor | utils: extract useWave hook | — | — |

> 3 已处理 · 2 待处理 · 共 5 条
```

`upstream_daily` 单独调用时展示所有 commits（含已处理），`upstream_list` 只展示待处理的摘要。

## 迁移

现有数据量小（antdv-next 7 条，CoPaw 4 条），迁移策略：

1. 解析现有 `todos.md` 的 checkbox 格式
2. 提取 issue 编号、类型标签、标题
3. 写入 `todos.yaml`（所有条目初始状态为 `idea`，已完成的为 `done`）
4. 保留旧 `todos.md` 为 `todos.md.bak`
5. 现有 `sync/` 目录数据迁移到 `upstream/` 结构（如有）
