# Roadmap

contribbot — 开源协作助手。三层演进：Tools → Skills → Agents。

```
Phase 1: Tools（原子操作）        ✅ 已完成
Phase 2: Skills（工具编排模板）    🔲
Phase 3: Agents（自主决策）        🔲
```

---

## Phase 1: Tools ✅

作为全局 MCP Server 寄宿于 Claude Code / Gemini CLI / OpenCode 等宿主。38 个原子工具。

### 已完成

| 能力 | 数量 | 说明 |
|------|------|------|
| Tools | 41 | 项目概览、todo 管理、issues/PRs 读写、上游追踪、质量检查、贡献统计 |
| Resources | 1 | `knowledge://{repo}/{name}` — 项目知识自动枚举 |
| Prompts | 4 | daily-sync、start-task、pre-submit、weekly-review |

### 关键特性

- **多模式支持**: none / fork / upstream / fork+upstream，自动推断
- **统一追踪**: fork source 和外部 upstream 共用 upstream.yaml，无硬编码默认值
- **读写闭环**: issue/PR 创建、关闭、评论、review 回复
- **Todo 生命周期**: idea → backlog → active(自动建分支) → pr_submitted → done(自动归档)
- **上游追踪**: 版本同步对比 + 每日 commit 抓取 + 噪音过滤
- **类型安全**: `as const` 枚举 + `z.enum()` 运行时校验 + `noUncheckedIndexedAccess`
- **错误处理**: `wrapHandler` 统一 try/catch → `isError: true`

---

## Phase 2: Skills 🔲

工具往上抽象为可执行的工作流模板。Skills 是 Tools 和 Agent 之间的桥梁。

### 目标

- 把当前 4 个 Prompts 升级为可执行 workflow（带条件分支、循环、状态）
- Skills 可组合、可复用、可共享
- 用户可自定义 workflow（不止预设的 4 个）

### 前置条件

- Phase 1 完备 ✅
- Skill 执行引擎设计
- Workflow DSL 或等价方案

---

## Phase 3: Agents 🔲

独立运行的开源协作 Agent，内置 LLM 推理，自主调用 Skills 执行多步任务。

### 目标能力

- 自主执行: "检查某版本同步状态并为未同步的 feat 创建 tracking issues"
- 定时巡检: 每日自动拉取上游 commits，跳过噪音，对有价值的变更建 issue
- 智能分类: 自动评估 issue 难度、分配优先级
- PR 辅助: 根据 review comments 自动建议修改方案
- 项目接入: 新项目一键 onboard（自动检测 fork/upstream、初始化配置、引导锚点选择）
- Git 管理: cherry-pick、merge、branch 操作（Phase 1 不做的部分）

### 部署形态

- 独立部署运行（Docker）
- 聊天入口（飞书/Telegram/Discord）
- 定时巡检（cron）
- 记忆系统（跨 session 项目上下文）

### 前置条件

- Phase 2 Skills 完备
- Agent SDK 成熟度
- 安全边界设计（哪些操作需要人类确认）

---

## 演进原则

1. **Core 优先** — 新功能先写纯函数，再接入各接口层
2. **渐进增强** — 每个 Phase 独立可用，不依赖后续 Phase
3. **多项目验证** — 在多个项目上验证通用性
4. **最小权限** — 写操作（创建 issue/PR、关闭、评论）始终需要明确意图
