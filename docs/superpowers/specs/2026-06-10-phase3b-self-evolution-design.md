# Phase 3B: Self-Evolution — contribbot Tracks Hermes

## Summary

contribbot 用自己的 upstream 追踪系统跟踪 Hermes Agent 的新能力,选择性吸收有价值的设计和模式来改进自己。这不是依赖——是**用自己进化自己**。

contribbot 已有完整的 upstream_daily / upstream_daily_act / upstream_daily_skip_noise 工具链。把 Hermes 设为 contribbot 自身的 upstream,就能:

1. 每日拉取 Hermes 新 commits,自动噪音过滤
2. 对有价值变更建 tracking issue / todo
3. 按需实现,用 `knowledge_propose_update` 沉淀学到的设计模式
4. contribbot-agent 的架构从 Hermes 的实践中汲取,但代码自建

## Motivation

contribbot Phase 3 要建自主 Agent 运行时。Hermes 是目前最成熟的开源自主 Agent,迭代极快(2026.3~6,17 个 release),在 agent 循环、记忆、调度、部署上都有实战验证。

但 contribbot 是独立产品,不能依赖 Hermes。**用 upstream 追踪来选择性学习**,既保持独立性,又不闭门造车。

## Hermes 能力地图(contribbot 视角)

### 高优先级 — 直接服务 self-evolution

| Hermes 能力 | 版本 | 对 contribbot 的价值 |
|------------|------|---------------------|
| **SQLite FTS5 跨 session 搜索** | v0.3+ | contribbot 无跨 session 搜索。加 FTS5 让 agent 回忆历史 triage 决策和同步模式,零 LLM 成本 |
| **`no_agent` cron + `wakeAgent` gate** | v0.13 | 每日巡检:脚本检查新 commits(免费),有变更才调 LLM triage。省 token |
| **Autonomous Curator** | v0.12 | 后台定期评审/裁剪知识库。contribbot 可用于 knowledge proposal 的自动归档和合并 |
| **Self-improvement loop** | v0.12 | 每轮后 rubric-based review fork 决定存什么记忆/skill。contribbot-agent 可借鉴此模式 |
| **`/goal` Ralph loop** | v0.13 | 锁定目标跨 turn 执行。contribbot 的"检查同步状态并建 tracking issues"正需要 |

### 中优先级 — 有用但不紧急

| Hermes 能力 | 对 contribbot 的价值 |
|------------|---------------------|
| **Skill bundles** | 把 daily-sync + fork-triage 打包。contribbot 的 SKILL.md 已兼容 agentskills.io |
| **Frozen snapshot pattern** | knowledge 资源注入 system prompt 后 session 内不变,保 prefix cache |
| **Progressive disclosure** | SKILL.md 三级加载(discovery→activation→execution),contribbot 已隐式遵循 |
| **MCP catalog 兼容** | contribbot-mcp 可提交到 Hermes MCP catalog,让 Hermes 用户零配置接入 |

### 低优先级 — 不核心

| Hermes 能力 | 原因 |
|------------|------|
| Honcho 用户建模 | contribbot 面向 repo,不面向用户 |
| Serverless (Modal/Daytona) | GitHub Actions cron 更适合 contribbot 场景 |
| Desktop app / Web dashboard | contribbot CLI-first,远期再考虑 |
| 23+ 聊天适配器 | 先做 Docker + 1~2 个聊天入口 |

## Architecture

### 整体架构

```
┌──────────────────────────────────────────────────────┐
│  contribbot-agent (Python, 自建)                      │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Agent Loop  │  │ MCP Client   │  │ Scheduler   │ │
│  │ (自建)      │  │ (标准 SDK)   │  │ (cron/Acts) │ │
│  └──────┬──────┘  └──────┬───────┘  └──────┬──────┘ │
│         │                │                  │        │
│         └────────────────┼──────────────────┘        │
│                          │ MCP (stdio)               │
│                          ▼                           │
│  ┌──────────────────────────────────────────────────┐│
│  │  contribbot-mcp (TypeScript, 已有)               ││
│  │  todo_* / upstream_* / knowledge_* / issue_* …  ││
│  └──────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
         │
         │  upstream_daily (Hermes as upstream)
         ▼
┌──────────────────────────────────────────────────────┐
│  NousResearch/hermes-agent (GitHub, 只读追踪)        │
│  新 commits → 噪音过滤 → 有价值变更 → tracking issue │
└──────────────────────────────────────────────────────┘
```

### contribbot-agent 内部结构

```
packages/agent/                    # Python 包
├── src/
│   ├── __init__.py
│   ├── loop.py                    # Agent 循环 (核心)
│   │   - prompt → LLM → tool_call → dispatch → loop
│   │   - 参考 Hermes AIAgent 模式,自建
│   │   - 支持多 provider (OpenAI/Anthropic/OpenRouter)
│   ├── mcp_client.py              # MCP client (连 contribbot-mcp)
│   │   - 标准 MCP SDK (Python)
│   │   - 启动 contribbot-mcp 子进程 (stdio)
│   │   - 发现 + 注册工具
│   ├── scheduler.py               # 调度
│   │   - cron 表达式触发
│   │   - no_agent 模式 (脚本先跑,有变更才唤醒 LLM)
│   │   - wakeAgent gate
│   ├── memory.py                  # 记忆
│   │   - 会话历史 (JSONL)
│   │   - 复用 knowledge proposal (项目知识)
│   │   - FTS5 跨 session 搜索 (借鉴 Hermes, 后续)
│   ├── config.py                  # 配置
│   │   - ~/.contribbot/agent.yaml
│   │   - LLM provider + model
│   │   - MCP server 列表
│   │   - 安全边界 (哪些操作需确认)
│   └── safety.py                  # 安全边界
│       - 自动执行: 拉取 commits, 噪音过滤, 信息收集
│       - 可配置自主: 建 issue, 标 todo, git 操作
│       - 始终需确认: 关 issue, 合 PR, force push
├── pyproject.toml
└── README.md
```

### Self-Evolution 工作流

```
每日触发 (cron / GitHub Actions)
  │
  ▼
upstream_daily (repo=darkingtail/contribbot, upstream=NousResearch/hermes-agent)
  │
  ├─ 拉取 Hermes 新 commits
  ├─ 版本锚定去重
  └─ 自动检测已有 issue/PR
  │
  ▼
噪音过滤 (upstream_daily_skip_noise)
  - ci/build/style/docs/test-only commits → skip
  │
  ▼
逐条评估 (upstream_daily_act)
  │
  ├─ 与 contribbot 相关?
  │   ├─ 是 → action: todo (建 tracking todo)
  │   └─ 否 → action: skip
  │
  ▼
实现阶段
  │
  ├─ todo_activate → 拉上下文, 评估难度
  ├─ 实现 (contribbot-agent 自主 or 人工)
  ├─ knowledge_propose_update → 沉淀学到的模式
  ├─ knowledge_apply_update → 维护者确认后写入
  └─ todo_done → 标记完成
```

### 安全边界(复用 design.md 已有设计)

| 等级 | 操作 | contribbot-agent 行为 |
|------|------|----------------------|
| **自动执行** | 拉取上游 commits、噪音过滤、信息收集 | 无需确认 |
| **可配置自主** | 建 tracking issue、标 todo、cherry-pick、branch | 默认自主,可配置为需确认 |
| **始终需确认** | 关 issue、合 PR、force push、reject knowledge proposal | 必须人类确认 |

## Hermes → contribbot 吸收记录

### 已吸收

| Hermes 模式 | contribbot 实现 | 状态 |
|------------|----------------|------|
| MCP client 连外部 server | contribbot-mcp 是标准 MCP server,任何 host 可连 | ✅ 已有 |
| SKILL.md + frontmatter | 10 个 Skills 已用此格式 | ✅ 已有 |
| `skill_manage` (程序性记忆) | `knowledge_propose_update` / `knowledge_apply_update` | ✅ Phase 3A |
| memory write approval gate | propose → review → apply 显式提案流(比 Hermes 更严格) | ✅ Phase 3A |
| provenance / audit trail | `<!-- contribbot:provenance -->` 脚注 | ✅ Phase 3A |

### 待吸收(按优先级)

| 优先级 | Hermes 模式 | contribbot 计划 | 阶段 |
|--------|------------|----------------|------|
| P0 | Agent 循环 (AIAgent) | contribbot-agent `loop.py` | Phase 3B |
| P0 | MCP client | contribbot-agent `mcp_client.py` | Phase 3B |
| P0 | `no_agent` cron + wakeAgent | contribbot-agent `scheduler.py` | Phase 3B |
| P1 | SQLite FTS5 跨 session 搜索 | `~/.contribbot/state.db` + FTS5 | Phase 3C |
| P1 | Autonomous Curator | knowledge 自动归档/合并 | Phase 3C |
| P1 | `/goal` Ralph loop | contribbot-agent 目标锁定模式 | Phase 3C |
| P2 | Skill bundles | daily-sync + fork-triage 打包 | Phase 3D |
| P2 | Frozen snapshot | knowledge 注入后 session 内冻结 | Phase 3D |
| P2 | MCP catalog 兼容 | 提交到 Hermes catalog | Phase 3D |

### 明确不吸收

| Hermes 模式 | 原因 |
|------------|------|
| Honcho 用户建模 | contribbot 面向 repo,不面向用户 |
| Serverless (Modal/Daytona) | GitHub Actions 更适合 |
| Desktop app | CLI-first,远期 |
| 23+ 聊天适配器全做 | 先做 1~2 个 |

## Implementation Order

### Phase 3B — contribbot-agent MVP

1. **`packages/agent/` 骨架** — pyproject.toml, 目录结构, config schema
2. **`mcp_client.py`** — 用 Python MCP SDK 连 contribbot-mcp (stdio), 发现工具
3. **`loop.py`** — agent 循环: prompt → LLM → tool_call → dispatch → loop
4. **`scheduler.py`** — cron 触发 + no_agent 模式 (脚本先跑,有变更才唤醒)
5. **`safety.py`** — 安全边界: 按操作等级决定自主/需确认
6. **CLI 入口** — `contribbot-agent patrol <repo>` / `contribbot-agent triage <repo>`
7. **配置** — `~/.contribbot/agent.yaml`: provider, model, mcp_servers, safety
8. **Docker** — Dockerfile, contribbot-mcp + contribbot-agent 一键起

### Phase 3B.1 — Self-Evolution 接入

9. **contribbot 自身 config.yaml** — 设 upstream = `NousResearch/hermes-agent`
10. **首次 upstream_daily** — 拉取 Hermes 最近 commits,噪音过滤
11. **建 tracking todos** — 对有价值变更建 todo,标注来源 `hermes-agent`
12. **knowledge 沉淀** — 实现后用 `knowledge_propose_update` 记录学到的模式

### Phase 3C — 记忆增强

13. **SQLite FTS5** — 跨 session 搜索历史 triage/sync 决策
14. **Curator** — 后台定期评审 knowledge, 归档/合并
15. **Ralph loop** — 目标锁定跨 turn 执行

## Config Schema

```yaml
# ~/.contribbot/agent.yaml
provider:
  name: openai          # openai | anthropic | openrouter | custom
  model: gpt-4o         # 或 claude-sonnet-4-6 等
  api_key: ${OPENAI_API_KEY}  # 环境变量引用

mcp_servers:
  contribbot:
    command: npx
    args: ["-y", "contribbot-mcp@latest"]

safety:
  auto: [upstream_daily, upstream_daily_skip_noise, issue_list, pr_list]
  configurable: [issue_create, todo_add, todo_activate, upstream_daily_act]
  require_confirm: [issue_close, pr_update, knowledge_reject_update]

scheduler:
  patrol:
    repo: darkingtail/contribbot
    schedule: "0 9 * * *"     # 每天 9:00
    no_agent: true            # 脚本先跑
    wake_on: new_commits      # 有新 commits 才唤醒 LLM
```

## 与 Phase 3A 的关系

Phase 3A 建了**可审计的知识底座**。Phase 3B 在此之上建**自主运行时**:

```
Phase 3A (已完成):
  knowledge_propose_update → knowledge_proposals → knowledge_apply_update / reject
  → 给 agent 一个安全的记忆写入通道

Phase 3B (本设计):
  contribbot-agent (loop + mcp_client + scheduler + safety)
  → agent 用 Phase 3A 的通道写记忆,而不是静默覆盖

Phase 3B.1 (self-evolution):
  upstream_daily(Hermes) → triage → tracking todo → implement → knowledge propose
  → 用 contribbot 自己的工具追踪上游,选择性进化
```

## Open Questions

- **Python MCP SDK 选择**: 官方 `mcp` Python 包 vs 自己写 stdio client? 官方包更稳但多一个依赖。
- **LLM provider 抽象**: 直接用 `openai` SDK(兼容 OpenRouter)还是抽象一层? 先用 `openai` SDK,后按需扩展。
- **会话持久化格式**: JSONL(简单,可读) vs SQLite(可搜索,但 Phase 3C 才加 FTS5)? 先 JSONL。
- **contribbot-agent 是否入 monorepo**: `packages/agent/` (Python) 和 `packages/mcp/` (TypeScript) 共存,用 pnpm + uv? 还是独立仓库? 倾向 monorepo(一个 repo 管全部)。
- **Hermes 追踪粒度**: 追踪 release 级(粗)还是 commit 级(细)? 倾向 commit 级(upstream_daily 已支持),噪音过滤会处理掉不相关的。
