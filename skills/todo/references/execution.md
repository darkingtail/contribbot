# 版本化 Todo 执行

本流程使用已连接 MCP 的结构化工具与拥有工作区的本地 `contribbot-exec`。
无 upstream、无知识库也能执行。旧运行时混写不受支持；
安装、重启及数据迁移需要另行授权，不能靠一次构建宣称已激活。

## 执行入口发现

开发态先从**当前已加载的本地 todo Skill 目录**定位
`scripts/contribbot-exec.mjs`，用宿主可用的 Node 执行其绝对路径：

```sh
node "<本地 todo Skill 的绝对目录>/scripts/contribbot-exec.mjs" check --schema
```

这是路径占位说明，不要照抄。目录取自宿主已提供的 Skill 路径；不能把测试仓库
当前目录、远端 MCP 的路径或猜测的个人目录作为依据。Windows 路径带空格时保留引号。
入口解析自身真实路径，经现有 Skill 链接定位源码，在同一 Node 进程加载本地 tsx
和当前 `src/cli/execution.ts`；不需要 PATH 中有裸命令，不读取 dist，不自动安装。
后文 `contribbot-exec` 均代表这个已核对的命令前缀，后接动作及原始参数。

如果使用的是已发布安装而非源码开发，才检查宿主实际安装的 `contribbot-exec`，
并实际运行 `check --schema` 核对能力。开发入口报告缺源码或依赖时按错误修复，
不静默转到 PATH、旧 dist、npx 下载或 Python 工具。复制的 Skill 不等于本地源码安装。
schema 成功只证明命令可以启动和发现接口，不证明业务检查通过、MCP 已刷新或数据根一致。
CLI 与 MCP 仍须使用同一套任务数据；缺能力时停止并报告具体原因。

## 进入与确认

以下用于进入受管执行；仅取消未开工或非受管 Todo 时，直接按
[取消分流](#暂停取消与继续)读取生命周期版本，不为取消创建执行。

1. 用 `todo_activate` 取得稳定 Todo ID 与当前 execution ID；已有打开的执行则复用。
2. `todo_context(repo, todo_id, execution_id)` 返回结构化状态。它没有检查本地文件；
   `readiness=null` 不是通过也不是失败，不从 Markdown 解析机器身份。
   使用返回的 `workflow_revision` 作为下一次变更的 `expected_revision`：
   已激活但尚未启用版本化执行时为 `0`，已有 workflow 时为其当前版本；
   没有 execution 时为 `null`，应先激活，不能把查询当成自动启用。
3. 调查代码与用户改动，提出目标、非目标、文件范围、步骤与行为验收。
   小任务可以只有一个步骤。验收应能证明结果，不能只检测关键词或运行无关命令。
   同时展示 execution.goal（整个 Todo 的目标）与本次计划范围。
   新计划必须提供 `completion_scope` 和 `remaining_scope`：
   `task` 覆盖整个目标，剩余数组为空；`stage` 只覆盖一段，必须列出尚未完成的目标。
   声明参与计划摘要，不能靠标题、关键词或数组非空证明实际覆盖。
4. `todo_plan` 的 `command.action=propose_plan` 保存计划版本；用户确认精确版本后，
   用 `confirm_plan` 记录同一 `plan_id`、`digest` 和真实确认来源。
   确认后不修改原计划；范围或验收变化需新版本和再次确认。

验收种类按实际目标选择：机器可核查事实用 `command`，实际内容审阅用 `review`，
确实需要用户查看并判断的效果、内容或体验才用 `manual`。不要为普通任务
机械增加通用的 `a-user`；但用户解读测试报告可以是合理的人工目标，不一概删去。
高风险独立审阅、必需文件内容验收和用户已确认的必需项仍按原约定执行，
不能为了减少确认静默降级、删项或改动计划。

有明确交付要求时，在同一计划中声明 `deliverables` 并展示给用户确认：
每项包括 `id`、`description`、`required`、`acceptance_ids` 与 `target`。
当前支持 `workspace`（当前实际候选及关联检查）、
`file`（工作区内、计划范围内的精确相对路径），或
`commit`（显式 `scope` 中的文件和暂存区对应本次捕获的 HEAD）。
必需项至少关联一条必需验收；
必需文件还须关联内容审阅或人工验收。检查的 required/independent 语义不变，
可选引用不会变成必需；文件存在也不证明其内容被接受。
不要求本地交付一定有新增文件或代码差异，纯删除任务仍可使用 workspace。
被 Git 忽略且未跟踪的文件不在候选中；先核对真实路径，不自动取消忽略或提交文件。
本地 commit 声明示例为 `{"kind":"commit","scope":["src"]}`；范围必须在计划范围内，
且为字面路径，不猜未来 SHA，也不要求相对 baseline 必须新增一个 commit。
未跟踪、暂存或未暂存差异均需核对；范围外的未完成工作可保留，但验收仍绑定完整候选。
普通 Git 内置换行/编码转换使用隔离临时元数据核对，不执行仓库自定义过滤器。
无法核验时是 `not_observed`，不是缺失或通过；可以修复工具限制，或请用户重新确认
另一种交付与人工/审阅验收约定，不能静默降级。提交操作仍需原有 Git 授权。
源码开发版同时支持两个显式 GitHub 端点：

| 端点 | target 示例 | 备注 |
| --- | --- | --- |
| 远端分支内容 | `{"kind":"remote_ref","repo":"owner/repo","ref":"refs/heads/main","scope":["src"]}` | 核对当前远端分支，不执行 push；不是只查某提交曾经上传过 |
| PR 提交或合并 | `{"kind":"remote_pull","repo":"owner/repo","number":42,"base":"main","endpoint":"merged","allow_draft":false,"scope":["src"]}` | 必须指定 PR；`endpoint` 可为 `submitted` 或 `merged` |

`submitted` 要求 PR 开放且满足 `allow_draft`，或已经合并；关闭未合并不满足。
`merged` 要求查询确认合并，并读取合并结果对应的树；不要求本地 HEAD 等于
squash/rebase 后的合并 SHA。目录范围递归，文件集合、blob 和 Git mode 必须与
本次候选已经提交的范围相同；范围外其他内容不阻塞，未提交内容不能算远端交付。
提交态从 head 仓库读树，合并态从 base 仓库读树。

用户/Agent 只报告合并时，用普通进度证据或笔记保留来源与
“据报告已合并，待核实”，不能作为已核实交付写入。PR 详情缓存同样不算。
`inspect` 和各收尾验证步骤会实际只读查询；网络/权限不可用、结果不完整、截断、
不支持的 scoped Git 条目或查询期间身份变化都是 `not_observed`。
每次最多观察 20 个远端交付项、并发 4 个；超限项不查询，不推断通过。
它是有时间范围的观察，不承诺远端持续不变或多 API 之间的原子快照。
收尾重试必须保留完整意图；已完成记录的重放不查询新的远端状态。
查询期间计划、控制请求、执行或候选变化会拒绝本次结论；先重读上下文，
不要重跑 push/创建 PR 等外部操作。

`context/resume` 的 `delivery_requirements` 及任务文档仅展示声明，仍是未现场验证。
本地 `inspect` 在 `readiness.deliveries` 中分开展示交付端点与关联验收记录；
远端观察返回不可变查询记录的 `remote.receipt`，不是可以提交回工具的通过凭证。
必需端点缺失/未观察时，`verified` 和 `with_gaps` 都不能结束任务；
补齐产物或经用户确认新计划，不能把 `delivery:<id>` 当普通验证缺口豁免。
产物实际存在但验收有缺口时，仍按原 `with_gaps` 规则处理，不改记为通过。
安全停止不要求交付满足；旧计划无此字段时保留原摘要，不从 PR 关联补造要求。

阶段检查通过只表示本阶段已有对应证据，保留 Todo 与本轮执行，按用户授权决定后续。
不调用 `close/stopped` 来“完成阶段”，也不自动开始尚未授权的实现。
`completion_coverage.scope_allows_task_completion` 只表示已确认计划覆盖整体，
不等于当前检查通过、用户已验收或已授权外部交付。
旧计划缺声明时保留原摘要与历史；继续工作可用，开始新的整项完成前须确认新计划。
已有历史收尾请求继续按原请求恢复，不补造覆盖声明或重复远端操作。

变更请求使用 `todo_id`、`execution_id`、`request_id` 和 `expected_revision`。
版本取自最新 context/resume 的 `workflow_revision` 或变更结果的 `workflow.revision`，
不猜测。重试同一请求使用同一 ID 与相同内容；
ID 冲突时核对原请求，不通过随机更换 ID 重复副作用。

`document_projection` 是 Todo Markdown 与存储状态的同步情况，不是验收结论。
`outdated` / `blocked` 时先核对原因，再用 `todo_resume` 修复展示；不能重跑已完成工作。
该操作也适用于归档任务，不递增 workflow revision。只编辑受管理区域以外的正文；
里面的计划、检查、候选与结论由 YAML 单向生成，手写 passed 不会使任务通过。

## 本地实现与检查

命令格式：

```sh
contribbot-exec <action> --request request.json
contribbot-exec <action> --help
contribbot-exec <action> --schema
```

先查询动作的 `--help` / `--schema` 获取实际输入结构，无需初始化或提供仓库身份，
不会读取请求文件或创建任务。JSON Schema 仅描述结构，不能证明状态允许、事实真实、
用户已授权或任务已交付；`x-contribbot.validation` 标明此限制。
`apply --schema` 只包含公开宿主动作，不通过内部状态转换自行填写完成结果。

请求 JSON 顶层必填 `repo: { "platform": "...", "instance": "...", "path": "..." }`，
以及稳定 Todo/execution ID。`--request -` 支持 stdin；
`--data-root` 可显式指定隔离数据根。CLI 与 MCP 必须访问同一套任务数据，
本地操作必须在工作区所在机器执行，不把远端 MCP 路径当成本机工作区。

- `bind`：传绝对 `workspace`、新的 `attempt_id`、`owner` 和请求版本。
  工具核对 GitHub origin 与 canonical repo/已配置 fork，保留实际起始候选和机器信息。
  机器信息是 hostname/platform 的协作检查，不是身份认证。
- `todo_operation(begin_operation)`：记录 `write` 或 `read`、步骤、范围、执行者与目的。
  宿主使用自己的编辑/调查工具干活，MCP 只记录，不创建或执行 Agent。
- 操作实际停止并有结果后，`return_operation` 记录真实定位符与摘要，
  `adopt_operation` 由负责人明确接受/拒绝。返回不等于验收通过。
- 本地 `yield`：负责人核对全部操作已停止/已处置，提交 `observed_operations`
  和说明；工具捕获真实候选。缺少 yield 或存在 unknown 操作时不能开始检查。
- 本地 `check`：指定已确认方案中的 `acceptance_id` 和新的 `operation_id`，
  执行已确认的 executable/argv。不能在这里临时换命令或用空命令补绿。
  环境相关检查应在计划中列出 `command.dependency_inputs`：相关清单和锁文件的
  工作区相对字面路径，不是目录或 glob。先核对真实文件是否会被候选捕获，不替用户
  安装依赖、不加入凭据。预检缺失时先修正文件或重新确认计划，不靠删字段绕过。
  回执 v2 保存检查执行器信息和声明文件的前后摘要；它不保证已安装依赖、外部服务
  或环境变量相同。v1 限制明确保留，不升级旧证据或用当前环境重写历史。
  Windows 包管理器使用已确认的显式解释器/JS 入口，不假设工具自动给 `.cmd` 加 shell。
  包管理器自身仍可能运行 shell 脚本。
- 检查失败后，在原授权范围返工：登记新写入、返回并处置、重新 yield、
  新建检查操作。不要删旧失败记录；候选变了必须重新检查。
- `report` 只接人工/审查结果，提交 `source`、`actor`、`locator`、`summary`、
  `outcome` 与验收身份，以及**被审阅时**的 `plan_id`、`attempt_id`、`epoch` 和
  完整 `candidate`（digest/root/git_dir/common_dir）、实际观察时间 `observed_at`。
  应把这些身份放进实际审阅材料，
  不能在收到旧意见后套用最新 yield 的身份。人工项必须来自用户明确反馈，
  不能由助手代填 passed；审查结果必须实际存在。同一个助手换角色名不算独立审查。
  导入中断时用完全相同的原请求重试：工具复用原观察意图和已有结果，不重新发起审查；
  结果尚未落盘时仅重新捕获文件，漂移会使原结论 stale，不变成对新代码的通过。
  迟到的旧观察不能覆盖更新的结论；同一观察时间的通过也不能盖掉失败。
  不要把旧报告的时间改成现在以绕过拒绝，只有实际重新验收才形成新观察。
  已完成报告丢失索引时只恢复原摘要指向的结果，不对新文件重新生成另一份通过。
  丢失原意图和结果的历史导入仍需人工核对，不能临时填一份通过报告来解除占用。
- `inspect` 实际捕获当前代码并核验必需检查的回执/清单。只有当前证据适用才显示
  ready；丢失、损坏或过期的结果保留为缺口。

委派由宿主实际派工，本地使用 `delegate-*` 交接；不能用普通
`begin_operation(delegated=true)` 或自由文本 return/adopt 替代候选核对：

1. `delegate-prepare` 绑定隔离 linked worktree、范围、provider/tool、brief 和唯一 token；
   宿主使用返回的完整 brief 派发一次，再以 `delegate-attach` 保存实际句柄和原始结果。
   没有句柄属于未知，不能直接重派。
2. 查询原任务，用 `delegate-observe` 保存真实 raw、locator、观察时间与后代核对依据。
   `observed_at` 是本次宿主观察的时间，不用旧消息到达时间伪装新观察。
   数据来源始终是 host_report，不声明 provider 认证或 OS 强制静止。
3. 原任务及后代核对为终态后，用 `delegate-collect` 捕获实际差异。
   负责人阅读返回内容、越界项与用户原有改动；越界候选不可接纳。
4. `delegate-review` 绑定精确结果；在**同一委派占用内**整合被审阅的差异，
   再 `delegate-finish` 核对主工作区实际内容。不要先接纳来腾出新 writer。
5. 主工作区重新 `yield` 和 `check`，不继承子 Agent 自报通过。
   `delegate-inspect` 可找回原始材料，但不会自动查询 provider。

已保存候选的恢复会复用原回执，另行核对新观察和文件是否仍一致。
源文件在接纳时未变化不证明今后永久停止。不能把任何状态字段当作完整 Agent Team。
高风险任务缺独立检查时保留缺口，不因工具不支持就降低要求。

## 恢复与收尾

换会话先 `todo_resume` 读取计划、执行、操作和 Next，再用本地 `inspect` 核对当前候选。
有完整命令回执时使用本地 `recover`，它补登记既有结果，不重新执行命令。
本地检查可用 `observe`（Todo/execution/operation 精确 ID）查询原助手、
每次检查专用的独立执行进程（supervisor）和直属命令：
它只观察记录的进程身份与回执，不自动终止进程、修改任务状态或释放占用。
请求方退出但 supervisor 仍在运行时等待原检查，保存结果后再 `recover`；
不另开检查替代它。supervisor 随单次检查结束退出，不是常驻调度器。
仅当 `observe.initial_dispatch_retryable=true`，才可用完全相同的原请求调用
`check` 继续尚未开始的首次派发；这不适用于已领取、unknown 或旧格式操作。
PID 缺失或父进程退出不证明后代全部停止，跨机器/身份不明的结果保持 unknown。
只有 started、没有回执或进程状态不明时，继续检查原宿主任务/后代进程及产物，
不要直接重复派工、清空占用或改 YAML。已实际核对原命令及全部后代、且用户明确
决定恢复后，可用本地 `reconcile` 保存对账：

- 精确 Todo/execution/operation ID、原负责人 actor、请求 ID/版本及用户 decision 来源。
- `report` 来自实际 `user` 或 `host_report`：actor、locator、observed_at、raw、
  coverage_basis、原 operation/attempt、当前 reviewed_candidate 摘要、
  descendants 的真实句柄和来源、accounted_missing、unresolved。
- 存在未解决问题、已知进程仍运行或身份无法核实，会拒绝释放。缺句柄不能推断为
  未启动；字段非空、用户同意或文件未变均不能证明后代已停止。
  旧版未使用 supervisor 时原 runner 可能就是执行者，同样必须核对停止或明确核对缺失身份。
  若无法真实核对后代范围，继续报告受阻，不生成模板式“已核实”报告。
- 内容发生变化时先阅读实际差异，再填写 changes_review；工具核对实际当前候选。
  保存期间漂移也拒绝放行，需重新核对后再请求。
- 成功只解除该操作占用，保留“未验证”；原结果不变，不能再次运行或恢复旧操作。
  重新 yield 并实际运行新检查。已有完整终态结果应使用 recover，不走 reconcile。

保存记录后崩溃时重试原请求，会重新观察活性和文件，不自动重跑命令。
此路径不发现完整进程树，不认证报告真实性；无法核实的恢复仍按受阻报告。

工作区占用也覆盖其他项目和其他数据根：同一 Git root/git_dir 不得重复分配 writer，
委派还保留子 worktree。缺失或替换已登记的项目数据会使占用未知；不要用删除
`.contribbot`、清理 Git 公共目录下的 `contribbot-workspaces` 或手改 YAML 来解锁。
恢复原数据后核对实际任务。不同 linked worktree 可分别使用，历史已处置任务不永久占用。
这只是合作执行者之间的检查，不会阻止宿主绕过工具直接写文件。不要与旧版执行器混用。

### 一次验收与完成

先执行已确认方案中已经获准且可执行的检查和审阅，再用 `inspect` 核对实际
候选、必需验收与交付。汇总结果和真正需要用户判断的内容，避免在结果尚未
产生时先请求验收。没有人工项的方案不临时加一个通用人工项，但仍需完成决定。

待评价结果已存在、其余收尾条件已满足，且用户对整个 Todo 明确表达验收通过并
要求结束时，同一条真实消息可同时支持有依据的 `manual` 报告和完成决定。
逐项核对原验收对象与用户实际观察的内容，只为实际覆盖的项目记录 `report`；
未观察的其他人工项仍缺失，但一条消息确实覆盖多项时不用拆成多次确认。
从返回值获取新版本，再核对 `inspect` 的全部门禁并调用 `close` 或 `todo_done`。
记录最后一项真实人工反馈之前可以尚未 ready，不要求先通过人工门禁才能记录它。
这些是同一轮内部操作，不要求用户分别批准 report、inspect 和 done，
也不要求他复述 ID、摘要或固定话术。报告缺失时不能只传 completion 冒充已验收。

已有反馈是否有效取决于实际查看的对象及 plan/attempt/epoch/candidate 绑定，
不以“所有命令都必须先于人工反馈”作为通用规则。实际产物反馈早于一个独立
命令结果且绑定未变时，不仅因顺序不同就重验；如果人工项本来要求查看新测试
结果，则结果产生前的反馈不能满足该项。

用户提前表达完成时立即说明具体缺项，保留原话，不声称他从未要求结束。
当前 attempt 或评价对象尚不存在时不能事后补造验收；计划确认不是结果验收，
阶段或单项认可不是整项完成。后续真实结果需要用户判断时，只询问缺失的判断，
不让用户重做已有且仍有效的验收。这一批不启用“剩余条件满足即完成”的条件授权。

候选或计划变化、失败、缺失交付和未处置操作仍按既有门禁处理；不把结束意图
当成接受所有缺口，不降低独立审阅要求。完成不隐含归档、提交推送或关闭 Issue。

### 收尾请求

用户要求收尾后，本地 `close` 传：
`closure_id`、`expected_revision`、`mode`、`acknowledged_gaps`、
`decision`（真实用户决定来源）、`note`、`target: {"kind":"local"}`。

- `verified`：当前候选全部必需验收和证据核验通过。
- `with_gaps`：用户明确接受列出的缺口，保持未验证结论，不改写成通过。
- `stopped`：已有 `kind=cancel` 控制请求，安全处置后以匹配 decision 的本地收尾记为 `cancelled`，不冒充完成。

新 `verified/with_gaps` 收尾都要求当前已确认计划的 `completion_scope=task`。
阶段计划全部通过也不能完成整个 Todo，接受验证缺口不能代替扩大或更改目标的确认。
`stopped` 不要求整体覆盖或测试通过，但仍必须安全处置原操作。

三种模式都不能掩盖仍运行/失联的操作。收尾失败时读取原 closing 与回执恢复，
不要新建一次相同的远端操作。本地 close 不顺便授权 GitHub 关闭、PR 创建或 push。

公开 MCP `todo_done(repo, item, completion)` 也能收尾；`item` 必须是稳定 Todo ID。
`completion` 包含上述关闭字段和 `execution_id`，不包含 `target`。
`issue_close` 使用同一 `completion` 和精确 `todo_item`，目标由 repo/issue_number 推导；
它先预检，再执行已获授权的 GitHub 操作。带 completion 却缺少 Todo 身份会直接拒绝，
不会降级成只关闭远端。两个入口都返回结构化结论；错误里的 recovery 保留原关闭
意图、远端回执和待处理收尾。不要通过省略 completion 绕过失败。

MCP 必须运行在绑定工作区所在机器才能重新核验当前交付。
新 final outcome 持久化后保留终态未归档；原 close 返回 `todo` 与布尔 `archived`，
不再以归档对象代表完成。归档使用独立预览与精确选择。
当前显式归档中断时，通过 `todo_archive` 重试原 `selections` 并核对快照；
不再支持旧完成/归档合并请求的恢复。尚未得到 final outcome 的 prepared 请求
重试仍需核对机器、候选与证据。

远端已经关闭但本地出现需要保留的新改动时，不要删除这些改动来凑回旧候选。
先读实际差异、原始公开请求及其完成状态，向用户确认“保留远端关闭，在本地继续”。
使用本地 `reconcile-close`，传精确 Todo/execution/closure ID、原负责人 actor、
request ID/expected revision、真实 decision，以及实际 report：
source、actor、locator、observed_at、raw、quiescence_basis、reviewed_candidate、
changes_review 和 unresolved。不能从模板直接填出“已停止”；原请求或写入者仍未查清就保持受阻。

该操作与原 Issue 发布共用互斥锁，保留历史关闭回执或本次只读 CLOSED 观察，
不把评论标记或 CLOSED 状态解释成“由我关闭”，不发布评论、重开或再次关闭 Issue。
成功后同一执行进入新的检查轮次，旧检查仍保留但不能满足新一轮验收；
重新 yield、执行检查，再根据用户决定收尾。它本身不会完成或归档 Todo。
中断时重试相同请求；已保存恢复结果只协调原日志清理，不删除后续关闭请求的日志。
操作核实记录或候选清单丢失会阻止收尾，包括 stopped；不能把它当作普通验收缺口豁免。

## 暂停、取消与继续

未开工或非受管 Todo 用 `todo_cancel(repo, todo_id, expected_lifecycle_revision, decision)`。
精确稳定 ID 与版本取自 `todo_context(repo, todo_id)` 的 `todo.id` 和
`todo.lifecycle_revision`（缺省为 `0`），不是下述 workflow revision。
锁内核对后保存 `last_cancellation: {decision, at, lifecycle_revision}`，状态为 `cancelled`，
无执行则不创建；已有普通执行以 `abandoned` 结束。不归档、不改 GitHub。
当前受管执行不能用此入口绕过控制或安全收尾。

普通 `issue_close` 调用运行期间收到停止请求，同样要等待原调用处置。
保留的 Issue 日志阻止安顿、继续、本地收尾和迁移。原调用返回后会记录
已经实际返回的写入结果；失败 GET 只记录读取失败，不表示 Issue 已关闭。
若原调用已退出但明确零次写入派发，可用完全相同的 `issue_close` 请求核对
和清理日志，不会重新请求 GitHub。保存核对记录后清理中断也按原请求重试。
非零派发缺原结果、日志变化或身份不匹配时保持受阻，不删日志或猜测结果。
收到“原操作已处置”只表示可以继续安全处理用户的停止决定，不代表已暂停、
取消、完成或归档；继续后旧关闭请求不会自动重发。

受管执行的 `todo_control` 只接受明确用户决定的 `request_control`，参数包括
`control_id`、`kind: pause | cancel`、`decision`、`note`，使用原 Todo/execution
与 request_id/expected_revision。不因为等待 CI、预算耗尽、Issue 关闭就自动取消。
请求成功只表示新派工被禁止；running/unknown/returned 和 pending closing 继续占用。
失联时仍先观察原执行者和后代、恢复回执或按上述流程对账，不重新启动。

安顿后通过本地 `settle-pause` 传 control_id、actor 及原身份/请求版本。
有工作区时必须由原负责人先 yield，工具再捕获实际候选；纯设计无 attempt 时
不伪造工作区。明确继续或撤回停止用本地 `continue`，另带真实 `decision`；
它保留同一个执行/attempt、增加 epoch、清空 yield，旧检查不能充当新检查。
`resume` 和 MCP `todo_resume` 不执行此动作，它们仍只恢复上下文与文档。

本地 closing 已准备但尚未完成时，用 `cancel-close` 传精确的当前 control_id、
closure_id、原 actor 和请求版本，撤回可逆的收尾预留后再安顿。它不取消 Todo，
不回滚文件，也不能撤回 prepared Issue 或有远端回执的操作。

若用户在已授权的 Issue/Todo 联合关闭期间明确暂停或取消，先用 `context` 查看
`issue_close_accounting`，核实原调用、已发出的请求和写入者都已结束。
本地 `reconcile-close` 另传精确 `control_id`，`decision` 必须与该暂停/取消请求一致；
其余原身份、负责人、请求版本、当前候选与真实 report 同上。这里只能使用有完整
派发记录的已知结果；旧日志、缺失记录或未返回请求继续待处理，远端 CLOSED、
未找到评论、超时、进程退出或一段“已经停止”的文字都不能替代核实。

该路径保留历史关闭回执与本次 Issue/评论观察，Issue 当前为 open 或 closed 都
不会触发新的公开操作。成功只撤回原完成意图，保留暂停/取消请求，清空 yield 并更新检查轮次。
取消时重新 yield，再以同一取消决定、本地 target 和新的 closure_id 执行 stopped 收尾，
Todo 才成为 cancelled 未归档。暂停时重新 yield，再执行 `settle-pause`，Todo 才成为 paused。
之后明确 `continue` 只恢复工作，不自动重发原 Issue 关闭；再次关闭需新的明确决定与 closure_id，
并满足新一轮检查要求。历史检查仍保留，不能当成恢复后的当前验收。
不得将“核实操作已结束”解释为“功能验收通过”。不能用省略 control_id 的旧“继续开发”
路径覆盖当前暂停或取消；已成功对账的历史精确重试仍只读回原结果。
不自动重开 Issue、回滚文件或归档。暂停对账使用独立 v3 记录，v1 继续和 v2 取消记录不改写。

新式 Issue 收尾的日志或 dispatch 记录丢失时，不重试公开动作来补造空日志。
准备完成但首次日志写入前中断，也保留待处理，不能仅凭“当时可能没发出”释放。
已有评论成功响应可复用，即使评论标记后来不可见也不再发送；
只有标记、没有原请求结果时仍待核实。未绑定工作区的任务同样需要完整的暂停/恢复记录，
不能用本地取消绕过缺失的控制回执。
中断重试使用原请求；恢复证据损坏时停止，不伪造成功或删除记录放行。

取消请求经安顿后用本地 `close(mode=stopped,target.kind=local)`，decision 必须匹配
原取消请求；结果保留 cancelled 未归档，不冒充目标完成。控制期间旧成功收尾不能
覆盖较新的停止意图。pending Issue 操作先保留远端事实、原回执并说明阻塞，
不得自动重开 Issue、推断本地 done/cancelled 或删日志绕过。

PR/claim 的原请求仍在途、或回执已保存但本地关联未完成时，也不能安全暂停、
继续或结束。`context` 会列出原请求；用原 `pr_create` / `todo_claim` 参数恢复
已保存的结果或正向查到的原标记，不擅自再次发布。找不到结果不等于没有效果，
`todo_update(pr=...)` 也不能替代原请求对账。已完成关联的请求重放不再改写关联。

这些动作的 schema 用本地 `--help` / `--schema` 查询，不拼造字段。
源码开发测试使用隔离数据根；没有验证并获得部署许可前，不与旧 MCP/CLI
写入器共享实际 `.contribbot`。

## 显式迁移工作区

普通 bind 不允许更换机器或工作区；旧记录缺机器信息时可以读历史，但不能冒充
本机已验证。确需迁移时，先确认所有原操作已处置且没有 pending closure，再由用户
确认迁移决定。用本地 `relocate` 传稳定身份、请求 ID/版本、新 `attempt_id`、
`from_attempt`、原 `owner`、新绝对 `workspace`、当前精确 `plan_digest` 和 `decision`。

新工作区必须仍属于同一 canonical repo/已记录 fork。工具不搬运代码、不改旧证据，
而是保存新基线和迁移回执、开启新尝试、清空 yield；原尝试的通过不适用于新尝试。
环境变化导致目标或验收变化时，重新提出并确认方案，不能借迁移跳过计划确认。
缺失迁移回执/清单会阻止 verified 收尾。相同请求重试保留原基线，不重新捕获覆盖。
迁移不能释放 unknown 占用，也不能替代 supervisor 失联的安全对账。
