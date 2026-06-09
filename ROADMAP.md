# Roadmap

contribbot — 开源协作助手。三层演进：Tools → Skills → Agents。

```
Phase 1: Tools（原子操作）        ✅ 已完成
Phase 2: Skills（工具编排层）     ✅ 已完成
Phase 3: Agents（自主决策）        🔲
```

---

## Phase 1: Tools ✅

MCP Server，寄宿于 Claude Code / Gemini CLI / Codex CLI / Cursor 等宿主。

| 能力 | 说明 |
|------|------|
| Tools | 三层分类（core / linkage / compat），详见 [docs/tools.md](docs/tools.md) |
| Resources | `knowledge://{repo}/{name}` — 项目知识 |
| Prompts | daily-sync、start-task、pre-submit、weekly-review |

### 关键特性

- **多模式支持**: none / fork / upstream / fork+upstream，自动推断
- **统一追踪**: fork source 和外部 upstream 共用 upstream.yaml
- **Todo 生命周期**: idea → backlog → active → pr_submitted → done | not_planned → archive → compact
- **上游追踪**: 版本同步对比 + 每日 commit 抓取 + 噪音过滤 + compact
- **工作项领取**: todo_claim 评论到 GitHub，多人协调
- **模板系统**: todo_record.md / todo_claim.md，首次使用自动生成
- **知识沉淀**: knowledge_write + knowledge:// resource

---

## Phase 2: Skills ✅

10 个 Skills 作为 MCP 工具编排层，通过 Claude Code Plugin 分发。

| Skill | 说明 |
|-------|------|
| project-onboard | 新项目接入 |
| daily-sync | 每日上游同步 |
| start-task | 开始任务（LLM 生成方案，用户确认后写入）|
| todo | 任务全生命周期 |
| issue | Issue 管理 |
| pr | PR 管理 |
| pre-submit | 合并前检查 |
| weekly-review | 周回顾 |
| fork-triage | 二开 cherry-pick 决策 |
| dashboard | 项目概况 |

### 设计原则

- **工具不做定性** — 子任务识别、分支命名、噪音过滤的项目级判断交给 LLM
- **模板文件化** — templates/ 目录，首次使用自动生成带注释的默认模板
- **todo 即有文档** — todo_add 时立即创建实现文档
- **用户确认优先** — activate 时 LLM 先出方案大纲，用户确认后再写入

---

## Phase 3: Agents 🚧

独立运行的开源协作 Agent，内置 LLM 推理，自主调用 Skills 执行多步任务。

### Phase 3A: 自演进仓库知识 🚧（进行中）

迈向自主 Agent 的奠基切片——先给未来的 Agent 一个**可靠、可审计的记忆底座**，而非先上自主执行。
在现有 MCP server 上新增 **propose → review → apply → audit** 的知识演进流
（`knowledge_propose_update` / `knowledge_proposals` / `knowledge_apply_update` / `knowledge_reject_update`），
canonical 知识写入带 provenance 脚注。详见
[docs/superpowers/specs/2026-06-02-phase3-evolving-knowledge-design.md](docs/superpowers/specs/2026-06-02-phase3-evolving-knowledge-design.md)。

### 自主 Agent 层方向

contribbot 保持「**MCP server + agentskills.io skills**」定位（TypeScript），
自主运行时复用 [Hermes Agent](https://github.com/NousResearch/hermes-agent)（Python，MCP 驱动）等成熟 host，
不在 monorepo 自建 agent 运行时——MCP 协议边界让两侧语言无需统一。

### 目标能力

### 目标能力

- 自主执行: "检查某版本同步状态并为未同步的 feat 创建 tracking issues"
- 定时巡检: 每日自动拉取上游 commits，跳过噪音，对有价值的变更建 issue
- 智能分类: 自动评估 issue 难度、分配优先级
- PR 辅助: 根据 review comments 自动建议修改方案
- Git 管理: cherry-pick、merge、branch 操作

### 部署形态

- 独立部署运行（Docker）
- 聊天入口（飞书/Telegram/Discord）
- 定时巡检（cron / GitHub Actions）
- 记忆系统（跨 session 项目上下文）

### 前置条件

- Phase 2 Skills 完备 ✅
- Agent SDK 成熟度
- 安全边界设计（哪些操作需要人类确认）

---

## 演进原则

1. **Core 优先** — 新功能先写纯函数，再接入各接口层
2. **渐进增强** — 每个 Phase 独立可用，不依赖后续 Phase
3. **多项目验证** — 在多个项目上验证通用性
4. **最小权限** — 写操作始终需要明确意图
5. **不过度设计** — 先解决当前问题，未来的问题未来解决
