# contribbot 概念与关系梳理

日期：2026-09-18。状态：设计梳理，不是已完成的架构改造。
本轮核对源码、继续 Claude 长会话并整理文档，没有修改业务代码或运行测试。

## 讨论约定

用户明确要求：每次新设计、设计调整和设计取舍，都先与 Claude 讨论，
延续项目既有长期会话，再说明 Claude 的意见、主助手的判断及待用户确认的决定。
咨询失败时如实说明并保留草案，不以此前讨论代替本轮咨询，不自行定案。
双方观点都可以被合理质疑，Claude 的意见不等于用户批准。
本规则已同步到本机项目 `AGENTS.md`；会话入口为
`.catpaw/discussions/phase3-claude/session.json`。

## 核心区别

Todo 是要推进的任务；Issue 是可以关联的社区议题；PR 是可以关联的改动与评审对象。
三者不是强制的 Issue -> Todo -> PR 链条。

分别回答三个问题：

- 来源：为什么产生这项任务？
- 生命周期：这项任务是否要做、是否正在推进、是否已经结束？
- 交付：这项任务需要交出什么，通过什么方式交付？

来源可以是用户委托、想法、Issue、上游变更或巡检发现。
Issue 不一定先于 Todo 创建，PR 评审也可以带来新的任务；
“来源”不等于“所有关联”，不要把关系强行设计成单向树。
多对象关联的具体存储与兼容能力仍需设计，不能据此宣称现有模型已支持任意多对多。

## 现有对象清单

下表概括源码中已有的数据对象与职责，不表示它们已自动形成完整闭环。

| 对象 | 管什么 | 备注 |
| --- | --- | --- |
| 项目 / 仓库配置 | 仓库身份、权限、fork/upstream、项目是否归档 | 提供任务上下文，权限不等于用户操作授权 |
| Todo | 目标任务、任务状态、执行历史及关联信息 | 不要求来自 Issue |
| Issue | 社区问题、需求和讨论 | 外部协作对象，不是 Todo 的远端镜像 |
| PR | 提交的改动及评审进展 | 可以没有关联 Issue，不是所有任务的必需交付物 |
| 执行记录 Execution | 本轮目标、阶段、Next、阻塞、计划、操作、检查与证据 | 归属于 Todo；不是另一套独立待办 |
| 上游变更 Upstream | release / commit 追踪及处理决定 | 被追踪的变更不等于已决定实施的 Todo |
| 巡检记录 Patrol Run | 某次观察、分析、发现、报告与动作结果 | 巡检本身与根据发现建立的任务不是同一个对象 |
| 知识与知识提案 | 仓库规范、经验及待处理的知识更新 | 为任务提供上下文，不用知识提案状态代替任务状态 |
| 悬赏 Bounty | 领取人、奖励、关联交付及结算记录 | 可选扩展；记录存在不证明外部付款已发生 |

计划、验收条件、检查和证据是执行中的内容。
分支与 worktree 是代码工作位置，Agent 是执行者，
Skills / MCP 是工作流与工具入口，都不应再被视为一种 Todo 主状态。

## 六类对象详解

以下字段与状态来自本轮源码核对，不是新批准的数据结构。
“代码已有”表示存在相应模型或入口，不代表本轮进行了功能验收。

这六类并不平级：项目提供上下文，执行归属于任务，上游记录把外部变更与本地
处理决定放在一起，巡检记录一次观察和处理过程，知识是可复用内容，悬赏是可选
奖励记录。必须分别解释状态含义，不能仅凭名称相同互相同步。

### 1. 项目与仓库上下文

**回答的问题：我们正在维护哪个项目，以什么身份维护，需要关注哪些仓库？**

项目以规范化后的 `owner/repo` 为数据范围。工作目录或 worktree 是执行位置，
不是另外一个项目身份。同一项目下保存各自的 Todo、上游追踪、知识、巡检和悬赏。

| 信息 | 当前内容 | 备注 |
| --- | --- | --- |
| 权限记录 | `role`：admin / maintain / write / triage / read | 不是对具体操作的用户授权 |
| 仓库关系 | `org`、`fork`、`upstream` | fork 关系与外部 upstream 不混同 |
| 项目模式 | none / fork / upstream / fork+upstream | 从配置推断，与权限等级无关 |
| 上游确认 | pending / configured / none | 没回答不等于明确不追踪 |
| 项目维护状态 | active / archived，附 archived_at | 是项目层状态，不是所有 Todo 的共同状态 |

与 Todo 的关系：Todo 归属于这个项目，使用其仓库上下文；但 Todo 的来源和验收目标
不是由项目模式决定的。none 模式照样可以管理任务。

当前项目归档修改配置，保留任务、知识、上游和巡检历史；默认项目列表不再展示，
新的巡检/巡检恢复受限。它不会关闭 GitHub 仓库、完成所有 Todo，或取消已运行巡检。
恢复项目也不等于立即开始执行任务。

数据位置：项目目录下 `config.yaml`。
源码：`core/storage/repo-config.ts`、`core/tools/core/project-lifecycle.ts`、
`core/tools/core/project-init.ts`，均位于 `packages/mcp/src/`。

### 2. Todo 的一轮执行

**回答的问题：这件事本轮怎么做、做到哪里、依据什么认定结果？**

Todo 是长期任务身份；Execution 是其中一轮推进记录。当前 `executions` 数组可以
保留多轮历史，但同一 Todo 最多允许一个未关闭执行。执行记录是任务的一部分，
不要求用户再创建一套 Work 或另一种待办。

普通执行记录已有：`id`、`goal`、`phase`、`next`、`blocked_on`、`evidence`、
开始/结束时间、`outcome`、`outcome_note`。受管执行另有可选的 `workflow`：

| 内容 | 具体记录 | 备注 |
| --- | --- | --- |
| 计划 Plan | 目标、不做什么、文件范围、步骤、步骤依赖、验收条件、确认引用 | 计划存在不等于计划已确认，更不等于任意操作已授权 |
| 执行尝试 Attempt | 当前计划、执行者、工作区、基线、开始时间 | 说明在哪一份代码上执行，不是重新创建 Todo |
| 操作 Operation | 读/写/检查、范围、执行者、是否委派、运行状态、结果 | 一轮执行可以有多项操作 |
| 候选结果 Candidate | 工作区定位与内容摘要 | 标识这次实际待检查的结果，不是只凭口头描述 |
| 检查 Check | 对应验收项、对应候选、执行来源、结果、说明 | passed / failed / blocked / stale 属于检查结果 |
| 证据与回执 | 来源、定位、观察时间、摘要，以及结果/进程/对账回执 | 支撑具体判断，不因有一条证据就证明全部通过 |
| 收尾 Closure | 完成或停止意图、缺口、局部或 Issue 联动目标、结果回执 | 负责受管执行收尾，不是归档的同义词 |

需要分开的状态：

- 执行阶段：`understand / execute / check / finish`。
- 本轮结果：当前是 `done / abandoned`，未结束时为空。
- 某次检查的结果与某个操作的运行状态，不直接成为 Todo 终态。
- `cancel_closure` 取消的是一次收尾预约，不等于用户取消整个 Todo。

例如：某次单测失败，Todo 可以继续推进修复，不能直接记成“任务已取消”。
进入 `finish` 也不单凭阶段字段证明进程已停止或所有验收都通过。

边界：激活会创建执行记录，因此“有 Execution”不等于已经做了实质实现。
`cancelled` 与完成/归档分离仍待实现；不能从已有执行模型推断这些设计已落地。

数据位置：`todos.yaml` 的 `executions`；归档任务包含在 `todos.archive.yaml`；
实现文档在 `todos/`；受管执行的结果与回执在 `executions/{executionId}/`。
源码：`core/storage/todo-store.ts`、`core/execution/contracts.ts`、
`core/execution/artifacts.ts`，均位于 `packages/mcp/src/`。

### 3. 上游变更追踪

**回答的问题：上游有哪些变化，我们决定怎样处理，哪些确实已对齐？**

当前不是只有一个“上游任务”，而是两套相关记录：

| 记录 | 包含什么 | 备注 |
| --- | --- | --- |
| Release / 版本 | 版本号、版本同步状态、一组版本工作项 | 版本状态 active / done |
| 版本工作项 | 标题、类型、难度、本地处理状态、关联 PR | 状态 active / pr_submitted / done，不是 TodoStatus 本身 |
| Daily commit | SHA、消息、类型、日期、处理动作、关联 ref | commit 是外部事实；action/ref 是本地处理记录 |

Daily 的 `action`：

- 空：尚未记录处理决定。
- `skip`：记录跳过。
- `todo`：记录交给本地任务推进。
- `issue`：记录关联 Issue。
- `pr`：记录关联 PR。
- `synced`：记录已同步。

这些不是六种“完成程度”。尤其 `todo/issue/pr` 表示处理去向，不证明工作完成。
`upstream_daily_act` 设置 action/ref 时只修改追踪记录，不会仅凭该调用自动
创建并验收 Todo。`processed` 统计 action 非空，含跳过、建任务等情况，
不能解释成“已实现的上游变更数”。`synced` 标签也不能代替实际对齐证据。

与 Todo 的关系：上游变化可以成为任务来源；不相关的变更可以跳过，
已经包含的变更可以记录对齐，不必每条都建立 Todo 或 Issue。
当前 `ref` 是较简单的关联字符串，不是完整的类型化、多对象关联模型。

例子：发现一条上游修复，决定移植并建了 Todo，只能说明已安排处理；
本地实现、测试、交付及同步记录仍是不同事实。

数据位置：`upstream.yaml`，按上游仓库保存版本与 daily；
已整理的 daily 保存在 `upstream.archive.yaml`。
源码：`core/storage/upstream-store.ts`、`core/tools/core/upstream-daily.ts`、
`core/enums.ts`，均位于 `packages/mcp/src/`。

### 4. 巡检运行与发现

**回答的问题：这次检查了什么、看到了什么、建议做什么、实际执行了哪些动作？**

一轮 Patrol Run 不是一个 Todo，它可能发现零个、一个或多个值得处理的事情。

| 组成 | 当前内容 | 备注 |
| --- | --- | --- |
| Run | ID、项目、状态、时间、覆盖标记、调查轮数、错误 | 描述本次巡检运行 |
| Snapshot | 工具观察结果、读取错误、知识内容 | 是当时的信息快照，不是当前永久事实 |
| Finding | 严重程度、标题、证据描述、影响 | 发现不自动等于已接受的任务 |
| Analysis | 概况、发现、补充调查请求、建议动作、知识候选 | 包含模型判断，需要与原始观察区分 |
| Action Execution | 动作类型、审批/执行状态、结果或错误 | 描述某个建议动作是否真的执行 |
| Report / Trace | 报告、过程事件、读写结果 | 支持回顾这次为什么得出结论 |

Run 与 Action 有不同的状态。Run 包含 observing、analyzing、
awaiting_confirmation、executing、verifying、succeeded、partial 等；
Action 则有 proposed、approved、completed、failed、rejected、skipped 等。
状态枚举中存在一个名字，不表示所有对应自动化路径均已实现。

当前实际链路中，`create_todo` 要经过确认回调，再调用 `todo_add` 并读回详情。
知识候选另经选择后写成待处理提案，不是直接应用到知识文件。
其他建议动作即使有 kind 枚举，也不能据此宣称已接通自动执行。

与 Todo 的关系：用户接受某个发现后可以建立或关联任务；巡检记录负责解释
“为什么提出这项任务”，Todo 负责后续如何解决。巡检 succeeded 仍可能留下
未采纳建议、未解决发现或刚创建的待办，绝不等于“仓库问题全已修好”。

数据位置：`patrol/runs/{runId}/` 的 report、snapshot、analysis、trace、run、
actions 文件，另有 latest 索引。
源码：`packages/agent/src/contribbot_agent/models.py`、`patrol.py`；
`packages/mcp/src/core/storage/patrol-store.ts`。

### 5. 已存知识与更新提案

**回答的问题：哪些经验供以后复用，哪些新判断还只是待处理建议？**

| 对象 | 当前内容 | 备注 |
| --- | --- | --- |
| 已存知识 | 名称、说明与 Markdown 正文 | 被保存不代表永远正确，也不代表必经人工审核 |
| 更新提案 | ID、目标、create/append/revise、来源、理由、拟写内容 | 提案不等于已存知识 |
| 提案处理记录 | pending / applied / rejected / rolled_back，以及时间和理由 | 描述更新动作的生命周期 |
| 来源与快照 | 来源引用、观察次数、应用前内容 | 用于追踪与回退，不替代内容验证 |

与 Todo 的关系是双向的：任务开始时可读取相关规范或经验；做完后发现有复用价值的
结论，可以提出知识更新。任务不必产出知识，知识也不必来自某个 Todo。

提案被应用后写入知识文件；回滚入口使用此前保存的内容快照。
同时存在直接 `knowledge_write`，因此不能说所有知识都经过提案、审核或同一流程。
回退入口存在也不等于已经证明任意并发修改下都安全。

例子：“这个模块需要使用某个测试入口”可以是候选经验；
先核实适用范围和依据，再决定是否保存。重复观察次数不是正确性评分。
已有读写、提案、应用、拒绝和回滚入口，不足以宣称完整的自主进化、
过期识别或矛盾消解已经验证。

数据位置：`knowledge/{name}/README.md` 与 `knowledge.proposals.yaml`。
源码：`core/tools/core/knowledge.ts`、`core/tools/core/knowledge-evolution.ts`、
`core/storage/knowledge-proposal-store.ts`，均位于 `packages/mcp/src/`。

### 6. 悬赏与奖励记录

**回答的问题：某项贡献关联什么奖励、由谁领取、交付与结算记录是什么？**

| 内容 | 当前字段或状态 | 备注 |
| --- | --- | --- |
| 奖励描述 | ID、可选 ref、标题、amount、currency、rail、creator | 当前模型主要面向金额与支付渠道 |
| 领取 | claimant、claimant_wallet、claim_note | 本地悬赏领取，不等于 Issue 公开认领 |
| 交付引用 | 单个 pr | 目前没有独立的稳定 todo_id 关联字段 |
| 结算记录 | rail、tx、note、settled 时间 | 是登记内容，不是自动到账证明 |
| 悬赏状态 | open / claimed / ready / settled / cancelled | 与 Todo 的状态独立；枚举存在不证明每条流程已完整实现 |

与 Todo 的关系：可以围绕同一项贡献记录奖励，但不是每个任务都有悬赏。
任务完成、贡献验收、奖励是否履约需要各自的事实；奖励还没处理不应被描述成
代码仍没做完。具体的联动与关联模型仍需设计。

当前 rail 有 `arc-usdc / github-sponsors / manual`。源码中的 settle 路径更新本地
结算记录并输出外部付款指引，本轮没有发现该路径实际发送款项的实现，
不能把 settled 直接宣传成自动支付成功。
此前讨论的订阅、Token 等非现金奖励不等于已有通用奖励发放与核销能力。

数据位置：`bounties.yaml`。
源码：`core/storage/bounty-store.ts`、`core/tools/core/bounties.ts`，
均位于 `packages/mcp/src/`。

## 把它们放进同一个例子

以下是假设场景，用来解释概念，不是本轮执行或验证结果。
假设一项任务约定的交付条件包括测试通过与关联 PR 合并：

1. 项目配置确定正在维护哪个仓库、追踪哪个外部 upstream。
2. 上游追踪收录一条修复 commit，这只是发现变化，尚未承诺移植。
3. 巡检读取相关信息，提出“值得移植”的建议；报告完成时，修复仍可能没开始。
4. 用户决定推进，建立 Todo，并在上游记录其处理去向；有必要时才关联 Issue，
   需要公开协调时才发布 claim。
5. Todo 的执行记录保存方案、验收条件、工作区、实现、检查与实际证据。
6. PR 被提交时只记录交付进展；按本例约定，还要满足测试和合并条件才完成 Todo。
   Issue 是否关闭仍依照其自身范围和明确授权，不从单个 PR 自动推定。
7. 确有对齐依据后再更新上游同步记录。可复用经验另建知识提案，是否应用单独处理。
8. 若有悬赏，单独核对奖励履约。它的结算记录不替代任务验收，任务完成也不证明奖励已付。

如果是允许直接提交的个人任务，步骤 6 可以按约定改成提交与交付验证，
不必为了兼容状态模型而制造一个 PR。

同一时间可以同时存在：巡检已成功、上游已安排处理、Todo 进行中、PR 等评审、
知识提案待处理、悬赏已领取。这些没有矛盾，因为它们回答的是不同问题。

## 现状限制与待设计关系

当前 Todo 主要有 `ref`、单个 `pr`、`branch`、`claimed_items` 以及执行证据。
它没有独立的通用 `sources[] / deliveries[]` 模型；
在笔记中能描述多种关系，不等于工具能结构化查询和一致更新这些关系。
上述数组名称仅用于说明缺少的概念，不是本轮批准的新字段。

当前与状态讨论直接相关的三点：

- `pr_submitted` 同时出现在 TodoStatus 和上游版本工作项状态中，
  不能只看名称就认定属于 Issue，也不能只改一处就宣称建模问题解决。
- 来源、关联和交付信息尚未完全分开；要表达“一项任务参考多个对象、
  交付多个结果”时，应先讨论具体场景与关系，再决定数据模型。
- 完成与归档仍有耦合，Todo 的 cancelled 仍是已确认未实现项。
  文档阐明边界，不等于这些历史实现已经修复。

当前只确认对象需要各自的职责与状态边界。
是否引入新的类型化关系、是否替换 pr_submitted，以及等待/暂停怎样建模仍待讨论，
不因本篇详细梳理而自动获得实施授权。

## 几条独立路径

1. 自己提出需求：建立 Todo，实施与验证；若约定要求提交，按仓库规则和用户授权
   直接提交/推送；满足约定的验收与交付条件后完成。可以没有 Issue 和 PR。
2. 参与社区 Issue：选择工作项，按需公开认领，关联 Todo，实施与验证；
   需要 PR 时提交 PR。是否要等合并才完成，取决于本任务约定，而非只看 PR 存在。
3. 自己提出需求但采用 PR 流程：Todo、实现、验证、PR 与评审；
   不必为此补建 Issue。
4. 调研或文档分析任务：报告可以就是交付物；是否提交到仓库按约定，
   不强制存在 Issue、PR 或 push。

Issue 的关闭、PR 的提交/合并、Todo 的完成与归档分别判断。
允许显式授权的联合操作，但外部事件不能替代任务自己的完成条件。
有 write 权限或拥有仓库，不自动确定贡献流程，也不自动授予发布操作权限。

## Claim 不是 Issue 专属概念

源码里至少有两类领取操作：

- `todoClaim`：要求 Issue 引用，在 GitHub Issue 评论中公开声明领取工作项，
  然后更新本地关联记录。
- `bountyClaim`：更新悬赏的本地领取记录，不等于发布 Issue 评论。

因此，“当前 todo_claim 面向 Issue 公开认领”是准确描述；
“所有 claim 都只能属于 Issue”不是项目事实。
未来本地执行者分配也应与公开认领、悬赏领取区分，不强制每个 Todo 先领取。

## pr_submitted 暂不定枚举去留

- 现有实现仍将其放在 TodoStatus，创建关联 PR 时会设置它。
- 它记录特定交付进展，不是 Issue 状态，也不证明实现、检查或验收已经完成。
- 草稿 PR 或部分改动也可能已经提交；不能直接解释为“我的部分已做完，只等别人”。
- 用户关心“哪些任务在等 PR 评审”是合理需求。无论最终采用什么模型，
  该信息都应可见、可筛选，评审要求修改时也要能准确展示返工。
- 不是所有任务都会经过该节点，本身不构成删除状态的充分理由。
  是否保留枚举或改为通用生命周期加交付信息，仍待用户决定。

当前先明确对象职责与任务完成条件，再设计主状态及转换。
本轮没有批准新的通用等待状态，也没有修改现有枚举。

## 来源与讨论

源码依据：

- `packages/mcp/src/core/storage/repo-config.ts`
- `packages/mcp/src/core/tools/core/project-init.ts`
- `packages/mcp/src/core/tools/core/project-lifecycle.ts`
- `packages/mcp/src/core/storage/todo-store.ts`
- `packages/mcp/src/core/execution/contracts.ts`
- `packages/mcp/src/core/execution/artifacts.ts`
- `packages/mcp/src/core/storage/upstream-store.ts`
- `packages/mcp/src/core/tools/core/upstream-daily.ts`
- `packages/mcp/src/core/storage/patrol-store.ts`
- `packages/agent/src/contribbot_agent/models.py`
- `packages/agent/src/contribbot_agent/patrol.py`
- `packages/mcp/src/core/storage/knowledge-proposal-store.ts`
- `packages/mcp/src/core/tools/core/knowledge.ts`
- `packages/mcp/src/core/tools/core/knowledge-evolution.ts`
- `packages/mcp/src/core/storage/bounty-store.ts`
- `packages/mcp/src/core/tools/core/todo-claim.ts`
- `packages/mcp/src/core/tools/core/bounties.ts`
- `packages/mcp/src/core/tools/linkage/pr-create.ts`

Claude 长会话 round-78 支持来源、任务与交付路径分离。
主助手不采纳其“PR 提交进度离不开 Issue”的矛盾表述，
也不采纳将提交 PR 等同于“本人工作已经完成”的推断。
咨询是设计意见，不是源码独立审查、验收证据或实施授权。

原文：`.catpaw/discussions/phase3-claude/round-78.response.md`。

round-79 对本次细化提出三个采纳点：标明状态归属、区分“已分流/已运行”与
“任务已完成”、将单一 ref/pr 的实现限制与未来关系设计分开说明。
主助手不采纳将全部知识称为“人写的内容”，因为存在 AI 提案与直接写入；
也不把每条本地悬赏记录都当成已经对外发布的承诺。
上游与巡检也不只是远程副本，它们还包含本地处理决定与执行记录。
工具枚举、持久化模型或咨询成功，均不能替代真实验收。
原文：`.catpaw/discussions/phase3-claude/round-79.response.md`。

状态与取消设计的讨论记录见
[Todo 主动记录与生命周期设计](2026-09-18-todo-intake-design.md)。

聚焦 Todo 的后续方案见
[Todo 生命周期、执行验收与交付关系](2026-09-18-todo-lifecycle-delivery-design.md)。
其中主状态、暂停、验收视图与交付终点仍是待用户确认的草案，不改变本文所述实现现状。
