# contribbot Phase 3：仓库自治巡检与知识进化设计

> 日期：2026-09-06
> 状态：M0–M5 已实现并验证；M6 延后
> 决策：先做一个可审计的仓库级 Agent，不先做 Agent Team。RepoSync Hub 只作为控制循环参考，不作为运行时依赖。

## 1. Phase 3 到底是什么

Phase 3 不是再加一批 MCP 工具，也不是放几个 YAML 就叫 Agent。它要让 contribbot 从被动工具箱变成一个能持续推进仓库维护工作的控制器：

```text
从任意目录启动
→ 找到 contribbot 已维护的仓库
→ 主动观察仓库状态
→ 对异常继续调查
→ 给出有证据的动作建议
→ 在权限边界内执行或请求确认
→ 验证结果并留下审计记录
→ 把稳定经验沉淀为仓库知识
→ 下一次巡检利用这些知识做得更好
```

最小产品定义：

> **一个以仓库为长期工作对象、以 MCP 为手脚、以可审计状态机为骨架、会从维护过程积累知识的巡检 Agent。**

## 2. 产品原则

1. **仓库优先**：记忆、任务、上游状态和审计记录归属于仓库，不归属于某次聊天。
2. **证据优先**：每个发现必须能回指 MCP 输出、GitHub 对象或本地记录。
3. **先调查再建议**：固定采集只发现信号，Agent 可以继续读取 PR、Issue、CI 和 diff 验证判断。
4. **确认边界清晰**：读取和本地审计可自动；GitHub 公共写入必须确认；破坏性动作仅人工。
5. **单 Agent 先闭环**：先证明 Observe → Decide → Act → Verify → Learn，再拆 Agent Team。
6. **不推倒 Phase 1/2**：TypeScript MCP 和 Skills 继续使用，Phase 3 只增加编排、状态和主动运行。

## 3. 现状与缺口

### 已具备

- Phase 1：MCP 原子能力，覆盖 GitHub、Todo、Upstream、Knowledge、统计和配置。
- Phase 2：10 个 Skills，把原子工具编排成维护工作流。
- Phase 3 原型：Python Patrol Runtime 已跑通单仓库闭环。
- Run / Action 状态、调查循环、`patrol-all`、本地 scheduler 已有实现草稿。
- Patrol 可保存 snapshot、analysis、trace、report、run 和 actions。
- `antdv-next/antdv-next` 已真实验证“分析 → 确认 → 创建本地 Todo”。

### 仍需收口

- 多仓库巡检和 scheduler 需要 CLI 冒烟、失败恢复和文档验证。
- 调查循环目前从文本识别 PR/Issue 编号，后续应升级为结构化 tool request。
- Worktree Remediation 尚未接入正式 Patrol 动作流。
- Knowledge 还缺“候选 → 审核 → 应用 → 效果反馈”的完整闭环。
- 长期运行所需的恢复、预算、去重和静默通知策略尚未完成。

## 4. 总体架构

语言和职责继续保持：

```text
TypeScript MCP = 手脚与事实层
Python Agent   = 大脑与控制层
Skills         = 人主动发起的标准工作流
```

Phase 3 新增的是 Control Plane：

| 层 | 组件 | 职责 |
| --- | --- | --- |
| 入口 | CLI / TUI / Scheduler | 手动、交互式或定时触发 |
| 编排 | Patrol Orchestrator | 为一个或多个仓库创建和推进 Run |
| 感知 | Observer | 通过 MCP 收集任务、上游、CI、安全和知识状态 |
| 决策 | Analyzer + Investigator | 发现问题、补证据、形成动作候选 |
| 权限 | Policy + Approval Gate | 决定自动、确认或人工 |
| 执行 | Action Executor | 调用 Todo/Knowledge/GitHub MCP；后续调用 worktree |
| 验证 | Verifier | 读取目标状态，确认动作真的生效 |
| 记忆 | Knowledge Evolver | 从重复事实中提出可审核知识 |
| 审计 | Audit Recorder | 保存每次 Run 的输入、判断、动作和结果 |

设计图：[phase3-control-plane.svg](../../diagrams/phase3-control-plane.svg)

## 5. 核心模型

### Patrol Run

```text
queued → observing → analyzing ↔ investigating
       → awaiting_confirmation → executing → verifying
       → succeeded | partial | failed | cancelled
```

Run 需要：稳定 ID、仓库、状态、coverage、调查轮数、起止时间、错误、恢复位置。

### Patrol Action

```text
proposed → approved → executing → completed
                  ↘ failed | rejected | skipped
```

Action 需要稳定 ID，保证重试不重复创建 Todo。动作按风险递进开放：

| 阶段 | 动作 | 权限 |
| --- | --- | --- |
| A | 保存报告、`create_todo` | 报告自动；Todo 确认 |
| B | `knowledge_proposal` | 确认后只建候选 |
| C | `create_issue`、`comment` | 每次公共写入确认 |
| D | worktree 修改、测试、patch | 确认后隔离执行，不发布 |
| E | push、创建 PR | 独立二次确认 |
| 禁止自动 | merge、关闭 Issue、强推、删除分支 | 仅人工 |

### Evidence

后续应把自然语言证据升级为统一引用：

```text
EvidenceRef {
  source: mcp_tool | github | local_file | validation
  locator: tool-call-id | issue# | pr# | path
  observed_at: timestamp
  digest: hash
  summary: string
}
```

## 6. 一次巡检的时序

时序图：[phase3-patrol-sequence.svg](../../diagrams/phase3-patrol-sequence.svg)

1. Scheduler/CLI 创建 Run。
2. Observer 调用 MCP 获取固定观察集并保存 snapshot。
3. Analyzer 产生 findings、调查请求和初步 actions。
4. Investigator 从白名单选择工具补证据。
5. Policy 规范化安全等级，Approval Gate 展示证据、影响和动作。
6. 用户批准后 Executor 执行；无人值守模式跳过需要确认的动作。
7. Verifier 读取目标状态，不以“工具返回成功”代替“目标已达到”。
8. Audit 保存完整 Run；Knowledge Evolver 只产生可审核候选。

调查停止条件：证据足够、连续两轮无新证据、达到默认 3 轮、需要业务上下文，或继续调查成本过高。

## 7. 仓库知识的自我进化

Hermes 的自我进化思想在 contribbot 中应是可审核的仓库知识演化，而不是模型偷偷改提示词：

```text
运行事实 → 候选经验 → 去重和置信度累计 → 知识提案
→ 维护者审核 → canonical knowledge → 后续 Patrol 验证效果
→ 保留 / 修订 / 回滚
```

知识分为：

| 类型 | 示例 | 策略 |
| --- | --- | --- |
| Fact | 发布使用 changeset | 来源变化时修订 |
| Convention | 分支使用 `feat/` | 多次观察后提出 |
| Procedure | PR 前运行 build + test | 验证成功后固化 |
| Decision | 不同步某类上游 commit | 保存背景、日期和依据 |

第一版不需要向量数据库。Markdown + frontmatter + 索引足够验证价值。

## 8. RepoSync Hub 的启发

最值得借鉴的是：**把自动化建模为可追踪 Run，把建议建模为 Candidate/Action，把执行和验证分开。**

| RepoSync Hub | contribbot |
| --- | --- |
| Project | `project_list` 中的已跟踪仓库 |
| Monitor Run | Patrol Run |
| Candidate | Patrol Action |
| Analyzer | Codex / Rules Analyzer |
| Remediator | Action / Worktree Executor |
| Scheduler | Patrol Scheduler |
| Audit DB | MVP 继续 JSON/Markdown，必要时再迁移 SQLite |

不复制 Go 实现、部署方式和数据库选型。RepoSync Hub 偏上游同步控制，contribbot 面向完整开源维护过程。

## 9. 实施路线

截至 2026-09-06 的实现状态：

| 里程碑 | 状态 | 证据 |
| --- | --- | --- |
| M0 | ✅ | Python/MCP 测试、构建、CLI 冒烟通过 |
| M1 | ✅ | Run/Action 状态、结构化调查、稳定 ID、Todo read-back、`--resume` |
| M2 | ✅ | `patrol-all`、`project_list`、单项目失败隔离 |
| M3 | ✅ | JSON 配置、`patrol-schedule --once`、无变化零输出 |
| M4 | ✅ | 知识候选证据累计、使用记录、apply/reject/rollback |
| M5 | ✅ | 隔离 worktree、禁止路径、validation、patch、验证审计 |
| M6 | 延后 | 只有真实指标证明需要时才拆 Agent Team |

### M0：基线冻结（1 天）

补齐测试、固定冒烟命令、更新文档。
**完成标准**：新环境按文档跑通 `patrol --backend rules`。

### M1：可恢复单仓库 Agent（2–3 天）

收口状态机、稳定 Action ID、幂等、失败恢复、结构化调查请求。
**完成标准**：中断重跑不重复创建 Todo，且每个动作可解释。

### M2：全局巡检（1–2 天）

完成 `patrol-all`、从任意目录发现项目、项目失败隔离、变化摘要。
**完成标准**：一次命令巡检所有项目，一个失败不阻塞其他项目。

### M3：自动巡检与静默通知（2 天）

收口 `agent.json`、`patrol-schedule --once`、Windows Task Scheduler 文档、去重。
**完成标准**：每天自动运行；无变化不通知，只有风险、失败、待确认才打扰。

### M4：知识进化闭环（3–4 天）

候选模型、证据累计、approve/reject/apply/rollback、效果反馈。
**完成标准**：重复经验能变成可追溯知识并影响后续判断。

### M5：隔离修复（3–5 天）

测试 worktree executor、禁止路径、validation、patch 和审计；发布仍需确认。
**完成标准**：Agent 能隔离修改并验证，但不会自行发布。

### M6：Agent Team（验证需求后）

只有上下文过长、需要并发、权限必须隔离，或指标证明拆分有价值时，才拆 Patrol、Investigation、Remediation、Knowledge Agent；Orchestrator 保持唯一状态和权限控制者。

## 10. MVP 验收场景

以 `antdv-next/antdv-next` 验收：

1. 从 contribbot 仓库外执行 `contribbot patrol-all`；
2. 自动发现已跟踪仓库；
3. 对异常 PR 拉取摘要和 CI；
4. 报告显示证据、影响、建议和安全等级；
5. 用户确认后创建本地 Todo；
6. 重跑不会重复创建；
7. Run 目录可以还原输入、判断、确认、执行和结果；
8. 无变化时不重复通知；
9. 稳定规则可形成知识提案，但不会静默覆盖正式知识。

## 11. 后续优先级

```text
真实使用 Patrol
→ 记录建议接受率和误报
→ 改进 Analyzer / Investigator 质量
→ 增加可选通知入口
→ 再评估公共写入与 Agent Team
```

先不要做 UI，也不要扩展 Agent Team。最重要的指标不是 Agent 数量，而是发现了多少真实问题、建议接受率、节省了多少重新阅读上下文的时间，以及知识是否让后续巡检更准确。
