# Todo 与 CatPaw 任务推进能力对照

日期：2026-09-22，Asia/Shanghai。范围：源码、规则与历史证据调查。
不是本日业务测试、用户验收或实施批准。已完成 Claude round-170 咨询；
下文区分核实事实、顾问建议、主助手异议与待用户确认的路线。

## 目标与边界

用户已确认：Todo 是 contribbot 推进工作的主线，围绕一件事组织方案、
执行、协作、检查、恢复和交付；其任务推进体系要承接并超越 CatPaw 的相关能力。
Consult 等能力保留独立使用边界，不强制绑定 Todo。

“超越”不能用工具数量或目录数量证明。必须落到用户能完成的任务、
无需重复说明的上下文、可靠的执行结果与清楚的交付状态。
MCP 保持领域工具、由 contribbot 按需运行顾问，是已有方向；
完整包边界与新工具接口尚未获实施确认。

## 参考而非复刻

用户在本轮对照后明确：CatPaw 的机制只能参考借鉴，不能照抄，
contribbot 需要有自己的思考。因此上文“承接并超越”不意味着复制
CatPaw 的概念、流程、目录或功能清单；本矩阵是调查材料，不是待实现清单。
CatPaw 未提供某项能力，也不构成 contribbot 不应提供它的理由。

主助手的补充判断：独立思考不是刻意做得不同，也不排斥适用的成熟机制。
应从 contribbot 用户的具体问题出发，说明参考机制解决什么问题、
它的前提是否适用、现有实现已覆盖多少，以及收益能否通过真实任务验证。
不能仅凭“CatPaw 有”就新增功能，也不能仅凭“需要原创”就重写已有可靠能力。

这次只记录用户原则与主助手解释，不改变既有方案或批准实施。
后续具体取舍继续先与 Claude 讨论，再区分顾问意见、主助手判断和用户决定。

## 先核对 CatPaw 版本

| 对象 | 本日只读结果 | 备注 |
| --- | --- | --- |
| 已安装 runtime | `C:/Users/WANGX/.catpaw`，VERSION 为 `4.0.1` | 不能称为远端最新源码 |
| 本地源码 | `D:/dev/catpaw`，main HEAD 为 `6bd43adab4857d80df10472d3c2e770b39e51a0e` | 提交时间为 2026-09-08；5 个文件有未提交修改 |
| 源码、dist、安装一致性 | 三处 runtime 各 65 个文件，按相对路径与 SHA-256 比较均一致 | 排除独立本地 `state/`；一致性不等于无本地补丁或功能验证 |
| 远端 main | `471412b584a1b1637b58fa000c3bcbe5431b1795`，VERSION 为 `4.0.2` | 实时 `git ls-remote` 和 GitHub API 交叉核对；领先本地 HEAD 一个提交 |
| 最新提交时间 | 2026-09-19 01:09:47 +08:00 | API 原始时间为 2026-09-18T17:09:47Z |
| 发布状态 | GitHub releases 返回空列表；4.0.2 Changelog 标为 `Unreleased` | 最新源码版本，不是已发布 Release；tag 也不能替代 main 查询 |

远端地址由本地 `git remote -v` 查得：`shiqkuangsan/catpaw`。
远端唯一新增提交修复嵌套 Git 仓库 scope 的 candidate 文件清单：
当父仓库忽略子仓库，但 Work 明确指定子仓库内部路径时，使用子仓库的
Git 清单与忽略规则；仍保留项目相对路径、删除检测与路径边界。
读取了该提交的 `candidate.mjs`、`evidence.md` 和新增测试 diff，
没有执行远端代码或测试。该提交没有改变 Work 生命周期、Agent 委派或 transport。

因此本轮能力对照采用“本机 4.0.1 实现 + 远端 4.0.2 精确差异”，
不能声称已安装或测试 4.0.2。
本地源码的 5 个未提交文件原样保留，其中两个 runtime 文件已存在于安装产物；
不把此安装称为纯净上游 4.0.1。未 fetch、pull、构建、激活或迁移。

核实命令为 `git ls-remote --symref origin HEAD refs/heads/main refs/tags/*`、
`gh api repos/shiqkuangsan/catpaw/commits/main`、
`gh api repos/shiqkuangsan/catpaw/releases` 以及固定 SHA 的 contents/compare 请求。

## 能力矩阵

“已有”指找到代码，不自动表示用户真实试用已通过；CatPaw 的协作规则
也不自动等于 CLI 已能替主助手自主派工。

| 能力 | CatPaw 实际范围 | contribbot 已有实现 | 差异、缺口或验证限制 | 备注 |
| --- | --- | --- | --- | --- |
| 承接用户目标 | Work 保存目标、验收、Next；小型工作可留在对话 | Todo、稳定 ID、执行记录、Skill 路由 | 主动记录设计已有；请求级幂等与撤销协议尚未在 `todoAdd` 找到 | `todoAdd` 仅显式 ref 查重；无 ref 重复调用可生成后缀，不等于同一请求重试安全 |
| 方案与授权 | Understand 明确目标、边界、验收；Plan 按需 | 版本化计划、digest 确认、步骤依赖、范围、风险、验收与交付声明 | start-task 仍暴露 legacy 与 managed 两条路径，选择规则和用户负担需收敛 | 不新增另一套 Work 任务主体 |
| 单任务执行 | 主助手执行，CLI 保存确定性记录 | `contribbot-exec` 绑定工作区、登记操作、yield、执行实际命令 | 已有执行器，不是只有 MCP 待办清单 | 检查执行器不等于通用模型工作者调度器 |
| 多 Agent 协作 | explore/build/check 委派契约；主助手决定人员、顺序、并行与采纳 | 隔离 worktree、委派 token、真实宿主 handle、返回候选、独立采纳与整合核对 | 实际 spawn/观察仍由宿主提供；统一启动可写模型工作者是待讨论扩展，不是当前委派故障 | 不能把“记录委派”描述为“已自动派 Agent 干活” |
| 外部模型咨询 | cc/cx 只读第二意见；observable transport 使用 tmux | Consult 授权、packet、持久讨论、Claude/Codex、后台 supervisor、结果与决定 | 仍从 MCP `consultStart` 进入运行时探测和启动，分层方案未实施 | 只读顾问不是可写开发者，也不是独立验收 |
| 暂停、取消、恢复 | Work 持久化、候选与证据恢复、协作停止规则 | stop 请求、安全安顿、原进程与回执恢复、unknown 保留、显式继续 | 真实宿主/跨平台覆盖仍有限；当前上下文摘要需更清楚 | 不重做已实现的控制状态机 |
| 检查与返工 | contract 4 Evidence 绑定候选、cycle、claim；后续失败覆盖旧通过 | 命令/审阅/人工验收分开，候选绑定、漂移失效、高风险独立审阅 | 历史回归不等于当前候选通过；真实日常使用待验收 | 工具输出不是授权，顾问建议不是检查证据 |
| 阶段与整体验收 | 可选 Milestone 聚合多个 Work | 计划区分 stage/task、remaining_scope；阶段不结束整个 Todo | 未找到同等的跨 Todo Milestone 聚合；现有 depends_on 是计划内步骤 | 不因 CatPaw 有就立即加入新实体 |
| 交付与生命周期 | Work 完成与 Evidence 检查；源/安装/激活分开 | 六态、完成不归档、取消保留历史；workspace/file/commit/remote_ref/remote_pull 核验 | 并非只在 PR 合并时才能完成；公开端点实际试用仍需按范围验证 | PR 关联/缓存不替代交付查询；只看旧文档会误判缺失 |
| 下一步与跨会话理解 | Work Next + status/show；仍依赖主助手维护叙述 | `todo_context` recovery、coverage、delivery、control、projection；状态转换会重写部分 Next | Next 多数按 phase 提供通用提示，不是逐项验收后的下一步对账 | 不能说没有恢复能力，也不能说所有 Next 都可靠新鲜 |
| 知识与维护外围 | 项目记忆、Evidence、反思、runtime/adapter 维护 | Knowledge 提案、审阅及应用；Issue/PR、上游、项目管理独立存在 | 不在当前 Todo 能力收敛轮扩展自动巡检、知识初始化或自治团队 | 没有 Knowledge 也应能完成任务 |

## 已有实现的核对入口

| 路径 | 核实内容 | 备注 |
| --- | --- | --- |
| `packages/mcp/src/core/execution/contracts.ts` | 计划、检查、交付、过程句柄、委派等结构 | 计划步骤依赖不是跨 Todo 调度 |
| `packages/mcp/src/core/execution/workflow.ts` | 版本化状态转换、ready 门禁 | 本轮读取与定位，不代替测试 |
| `packages/mcp/src/core/execution/local.ts` | 本地执行、context/recovery、工作区观察边界 | context 明示 `workspace_observation: not_observed`、`readiness: null` |
| `packages/mcp/src/core/execution/delegation.ts` | prepare/attach/observe/collect/review/integrate | prepare 返回由宿主实际派发一次；主助手需实际核对 |
| `packages/mcp/src/core/storage/todo-store.ts` | 生命周期、执行投影、Next、控制状态 | Next 已有计算，但仍有通用阶段提示 |
| `packages/mcp/src/core/tools/core/todos.ts` | `todoAdd` 显式 ref 查重与自动后缀 | 没有 request_id 入口，不把已有锁误称为请求幂等 |
| `packages/mcp/src/core/tools/core/consult.ts` | MCP 启动 supervisor、状态读取的恢复副作用 | 对应此前拆分方案，不是新发现一整套缺失模块 |
| `skills/start-task/SKILL.md`、`skills/todo/references/execution.md` | 实际宿主路由与执行说明 | 文案、工具与机制三层要分别检查 |
| `C:/Users/WANGX/.catpaw/lib/commands/work.mjs`、`completion-evidence.mjs` | Work 与候选证据约束 | 已安装版本，非远端源码运行 |
| `C:/Users/WANGX/.catpaw/catalog/intents.json`、`guidance/agent-dispatch.md` | explore/build/check 协作契约 | 规则要求不是调度器实现 |
| `C:/Users/WANGX/.catpaw/lib/commands/agent.mjs`、`provider-profiles.mjs` | tmux 会话与只读 cc/cx | 不能据此宣称任意 Agent 自动开发 |

## 验证证据不能混写

本轮读回 2026-09-17 的真实宿主委派记录及 attach/observe JSON：
有原 Codex 子 Agent handle，实验只修改临时子 worktree 的 `sum.cjs`，
主助手收集、审阅、整合并重查。这是受限真实委派的历史记录，
不证明今日候选、所有宿主或所有平台通过，也不把子 Agent 自报当独立验收。

2026-09-18 的 Skills 宿主记录注明：显式 Skill/MCP 桥接、模拟用户、
旧构建候选，并非原生插件发现或真人验收。记录中的“完成后归档”
属于当时实现，不能覆盖后来完成与归档分离的代码。
证据入口为 `.catpaw/evidence/FR-003/`；本轮仅读回部分原始材料，未重跑。

2026-09-21 日报记录了当日全量测试及 OBS-003 定向变更后的结果；
2026-09-22 尚未运行业务测试。旧 `todo-dogfooding-issues.md`
仍写 OBS-003 未修复，与新源码和 9 月 21 日记录不符。
应表述为“已有修复候选及历史回归，待用户验收”，不重新开发一次。

本轮 `catpaw status` 返回 6 个 active Work 与 5 个 board errors，
部分 Next 仍停在旧实施阶段。没有修复或迁移看板，未进一步诊断 5 个错误原因；
不把它们当作当前业务源码失败，也不以旧 Next 推翻新的可核实证据。

## 本轮咨询问题

在上述事实下，请 Claude 讨论：怎样把已有能力接成用户容易使用的任务流程，
哪些是确实缺少的机制，哪些只是接线、说明或验证不足？
尤其需要区分“Todo 体系支撑协作”与“必须马上增加自治调度器”，
以及“拆出顾问运行时”与“已经承接 CatPaw 全部任务推进能力”。

本轮不默认加入常驻服务、所有 Provider 的可写执行、多层任务树或自动收尾。

## Claude round-170 与主助手判断

沿用 session `0e4058f9-0d2b-423c-838b-eaa1bc6e13b2`，
北京时间 2026-09-22 00:40:29 至 00:44:15，进程 exit 0，
实际返回 session ID 一致。只发送本对照的咨询前快照、start-task Skill
和既有 Runtime 拆分草案，共 3 个文件及问题说明。
模型工具禁用、无模型硬截止、未重复请求。
原始输入、冻结快照、回复与来源摘要保存在
`.catpaw/discussions/phase3-claude/round-170.*`，不默认公开提交这些原件。

| 议题 | Claude 意见 | 主助手采纳或异议 | 备注 |
| --- | --- | --- | --- |
| 避免重做 | 委派、恢复、候选、验收均已有基础，应接好流程 | 采纳；将统一可写工作者标为范围扩展，不把已有宿主委派当故障 | “超越”仍需真实结果，不作能力数量竞赛 |
| 任务接入与 Next | 请求幂等、下一步派生、隐藏双流程选择优先 | 采纳方向；工具只提供事实和确定性分流，任务意图与风险判断仍归主助手 | 不把“选择收进工具”扩大成工具替 LLM 作定性 |
| 实施顺序 | 先改善接入和 Next，再拆运行时 | 不完全采纳；用户已明确要求拆分，不能以“用户几乎看不见”为由无限后置 | 主助手建议顺序见下一节，未当作用户决定 |
| 可写 Agent | 称 contribbot 启动可写工作者与 MCP 纯工具直接冲突 | 不采纳这一理由：独立执行器可以在授权下启动，MCP 仍保持工具边界 | 现在不做的理由应是范围和写入执行契约未确认，不是架构上禁止 |
| 重复自然语言 | 同一句话说三次只能有一个 Todo | 不采纳为机械规则；同一请求需幂等，是否同一目标须结合上下文 | 同名任务可能合法；不能仅靠文本摘要吞掉新意图 |
| 暂停后复用检查 | 暂停再继续时旧检查不得复用、计数必须增加 | 不采纳；恢复先核对，仍绑定同一候选、计划及有效输入的结果可复用 | 候选/计划/依赖变化才按失效范围补检，不能故意制造重复验收 |
| 用户决定 | 建议现在再问跨 Todo 聚合是否需要 | 暂不采纳；当前任务没有要求该实体，无须用远期选择阻塞眼前路线 | 不永久否定将来多任务聚合 |
| 严格只读查询 | 状态查询不再顺带恢复回执，恢复显式执行 | 采纳为待确认方案；需同批改工具语义、Skill 与异常恢复说明 | “纯 MCP”本身不等于全部工具只读，不能偷换概念 |

Claude 提到 CatPaw 4.0.2 的嵌套仓库修复值得核对。
本轮继续只读检查 contribbot `candidate.ts` 与 `candidate.test.ts`：
当前绑定要求 Git 仓库根，以该根的清单生成候选，明确拒绝 index gitlink/submodule；
这不是 CatPaw 从父项目 scope 跟进子仓库的同一契约。
本轮没有复现那个嵌套场景，不能直接登记为已确认缺陷或声称已经支持。
若后续需要父工作空间跨子仓库范围，应另行明确交付范围与回归用例，
不把 CatPaw 的修复直接复制进来。

## 建议推进路线

这是咨询后的主助手建议，不是新增实施授权。

| 批次 | 用户能得到什么 | 实施与验收边界 | 备注 |
| --- | --- | --- | --- |
| 1：拆清顾问执行边界 | 仍在原主助手说“请顾问讨论”，由 contribbot 统一启动，不让宿主分别拼各家命令 | 按既有拆分草案先固定行为、验证精确请求启动，再抽依赖；必须保留授权撤销竞态、恢复与同一份任务规则 | 不把搬文件当作 Todo 整体目标完成；OBS-003 已有候选先保留和核对，不重复开发 |
| 2：接好 Todo 日常推进 | 说清任务后能续接正确记录；询问进度时知道具体剩余工作 | 确认自然接入技术方案、请求幂等、Next 派生与宿主路由；继续复用现有执行/验收状态机 | 本地未观察时明确提示需要 inspect，不能只凭数据库宣布已满足交付 |
| 3：真实仓库与第二入口验证 | 换会话仍接得上同一项工作，顾问与验收边界清楚 | 单个真实 Todo 走计划、实现、检查、暂停恢复、顾问、交付、完成不归档；补第二宿主实际接入 | 用户不手写 ID/YAML；模型实验、模拟用户和真人验收分别报告 |

后续真实场景的关键观察：相同请求重试不重复建任务，不同合法意图不被错误合并；
恢复不重新派发未知操作，不无故重跑仍有效的检查；
用户已观察且未变化的验收对象不重复索要确认；
新候选与新权限边界不能沿用过期结论；用户完成决定与实际检查条件同时满足后，
完成但不自动归档。

下一次需要用户确认的是上述实施范围及顺序，以及拆分方案中查询改为
严格只读、恢复动作显式化等实际行为变化。包数量、类名不逐项要求用户选择。
通用可写 Agent 执行与自治团队不随本轮建议自动获准，也不被永久排除。
在用户确认前继续停在设计，不改业务代码。
