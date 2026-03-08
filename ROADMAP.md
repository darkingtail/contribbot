# Roadmap

contribbot 从 antdv-next 专属工具演进为通用开源贡献助手。核心逻辑写一次，多种接口包装。

```
contribbot
├── core/          ← 纯函数，无 IO 框架依赖
├── mcp/           ← Phase 1: MCP Server (stdio)   ✅
├── api/           ← Phase 2: REST API (HTTP)       🔲
└── agent/         ← Phase 3: Agent SDK             🔲
```

---

## Phase 1: MCP Server ✅

作为全局 MCP Server 寄宿于 Claude Code / Gemini CLI / OpenCode 等宿主。

### 已完成

| 能力 | 数量 | 说明 |
|------|------|------|
| Tools | 37 | 覆盖项目概览、todo 管理、issues/PRs 读写、上游同步、质量检查、依赖管理、贡献统计 |
| Resources | 1 | `skill://{repo}/{name}` — skills 知识库自动枚举 |
| Prompts | 4 | daily-sync、start-task、pre-submit、weekly-review |

### 关键特性

- **读写闭环**: issue/PR 创建、关闭、评论、review 回复
- **Todo 生命周期**: idea → backlog → active(自动建分支) → pr_submitted → done(自动归档)
- **上游追踪**: 版本同步对比 + 每日 commit 抓取 + 噪音过滤
- **一任务一分支**: activate 自动生成分支名并在 fork 远程创建
- **类型安全**: `as const` 枚举 + `z.enum()` 运行时校验 + `noUncheckedIndexedAccess`
- **错误处理**: `wrapHandler` 统一 try/catch → `isError: true`

### 已完善

- [x] MCP Prompts — 4 个预设工作流模板
- [x] 多项目 skill 自动加载 — project_dashboard 进入项目时推送相关 skills
- [x] upstream_daily 版本锚定重构 — 从天数轮询改为版本锚点追踪

---

## Phase 2: REST API ⏸️

暂缓。Agent 直接调 core 函数，不需要 HTTP 中间层。需要时再补。

---

## Phase 3: Agent SDK 🔲

用 Claude Agent SDK 包装，内置 LLM 推理，可自主执行多步任务。Agent 直接调用 core 层函数。

### 目标能力

- 自主执行: "检查 6.4.0 同步状态并为未同步的 feat 创建 tracking issues"
- 定时巡检: 每日自动拉取上游 commits，跳过噪音，对有价值的变更建 issue
- 智能分类: 自动评估 issue 难度、分配优先级
- PR 辅助: 根据 review comments 自动建议修改方案
- 项目接入: 新项目一键 onboard（自动检测 fork/upstream、初始化配置、引导锚点选择）

### 前置条件

- core 层已完备 ✅
- Claude Agent SDK 成熟度
- 安全边界设计（哪些操作需要人类确认）

---

## 演进原则

1. **Core 优先** — 新功能先写纯函数，再接入各接口层
2. **渐进增强** — 每个 Phase 独立可用，不依赖后续 Phase
3. **单项目验证** — 先在 antdv-next 上打磨，再泛化到其他项目
4. **最小权限** — 写操作（创建 issue/PR、关闭、评论）始终需要明确意图
