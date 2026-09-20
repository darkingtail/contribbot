# Todo 执行闭环：本地验收

日期：2026-09-17。
对应设计：[Todo 中间执行闭环](../plans/2026-09-17-phase3-task-execution-design.md)。
当前是开发中的单宿主纵向路径，不是整个 Phase 3 已完成。

## 一键隔离验收

在仓库根目录运行：

```sh
pnpm test:execution-smoke
```

前置：已安装项目依赖，Node、pnpm、Git 可用。命令先构建 MCP 包，
然后运行 `packages/mcp/scripts/execution-smoke.mjs`。

脚本新建临时 Git 仓库和独立数据目录，实际启动构建后的 MCP stdio 进程与
`contribbot-exec` CLI。每次 CLI 调用都是新进程，中途另起 MCP 进程验证恢复。
不联网、不依赖真实 GitHub 凭据、不修改个人 `~/.contribbot`、不安装运行时；
退出时清理自己创建的临时目录。Git 提交仅用于这个临时测试仓库的初始基线。

| 验收行为 | 实际检查 | 备注 |
| --- | --- | --- |
| 未确认方案不能开始 | 尝试绑定工作区，要求拒绝 | 不是仅检查文档出现“确认” |
| 错误代码不能交付 | 子进程执行错误的求和函数，断言失败；verified 收尾被拒绝 | 不是无关命令 exit 0 |
| 返工后重新检查 | 改真实源文件，重新 yield 和执行断言，候选摘要必须不同 | 不复用旧通过结果 |
| 换进程继续 | 重连 MCP 读取相同执行记录和检查历史 | 历史查询不声称已检查当前代码 |
| 查询原进程 | 新 CLI 进程读取原助手、独立执行进程和命令句柄，任务版本和运行次数不变 | 查询不自动释放占用 |
| 恢复不重复执行 | 恢复保存的回执，外部计数文件必须仍只有两次运行 | 检查不会偷偷重跑 |
| 环境观察可追溯 | 构建CLI回执中的声明清单摘要等于真实文件摘要；新进程恢复保留原观察且不重跑 | 不证明完整环境一致或可复现 |
| 文档恢复不重跑任务 | 手改展示后 context 不写，MCP resume 修复且保留手写后文；非UTF8原字节保持不变 | YAML版本和命令次数不增加，展示不当作通过依据 |
| 请求方崩溃 | 第三次检查中强制结束请求 CLI；原命令继续完成，新 CLI 恢复实际结果，计数保持三次 | 期间第二个 writer 被拒绝，不模拟崩溃状态 |
| 后续改动使验证失效 | 添加未跟踪文件后 inspect 必须不可交付 | 候选不只覆盖 HEAD |
| 公开收尾核验真实证据 | 删除检查回执后，构建后的 MCP todo_done 必须拒绝完成；恢复证据后才能完成 | 不只验证工具注册或成功文案 |
| 显式收尾与归档分开 | 重复公开 todo_done 和本地 close 共用结束结果；保留未归档，精确选择后才归档 | 不等于已发布 PR；不重跑执行 |
| 超时后显式恢复再检查 | 原计数不变、原 blocked 结果保留；重新 yield 和运行断言后才可完成 | 独立新 Todo，无后代的已知 fixture，不冒充任意进程树核对 |
| 远端关闭后继续本地工作 | 构建 CLI 读取模拟历史日志，跨进程重试保留新文件；旧检查不可交付，实际再跑断言后才完成 | 日志由 fixture 写入，未调用真实 GitHub |
| 跨数据根的工作区互斥 | 两个数据根不能同时获得同一目录 writer；原结果处置后第二个才可写 | 实际文件内容断言，不是只看占用标签 |
| 阶段通过不等于整项完成 | 求和阶段实际检查通过，CLI/MCP 都拒绝整体完成；保持 active 和剩余界面目标 | 明确停止仍走原安全门禁；阶段成功不记为取消 |

脚本输出逐项 PASS 和带限制说明的 JSON。任何断言失败会返回非零退出码。
这是使用真实进程和文件的自动集成验收，**宿主编辑和用户决定仍由测试脚本模拟**；
不冒充真人试用、真实 AI 委派或线上 GitHub 验证。

## 当前入口

开发态已用 `dev:setup` 接入时，从本地 todo Skill 的
`scripts/contribbot-exec.mjs` 调用源码执行助手；Skills 会按实际加载位置发现，
不要求 `contribbot-exec` 在 PATH。详见[开发态执行入口](local-dev-runtime.md#本地执行助手)。
`pnpm test:dev-exec-smoke` 通过隔离安装的 Skill 链接验证源码 CLI/MCP；
下方 dist 命令是显式构建入口，不是开发态自动回退。

- MCP `todo_context`、`todo_resume`、`todo_check`：结构化历史与恢复建议；
  `workspace_observation=not_observed` 表示没有观察工作区代码。
  `todo_resume` 还会从已存状态修复 Todo 文档展示，不重跑任务。
- MCP `todo_plan`：提出版本化方案、记录用户对精确摘要的确认。
  新计划带 `completion_scope: task | stage` 与 `remaining_scope`。
  `task` 的剩余数组必须为空，`stage` 列出未完成的目标；两者均参与摘要。
  阶段检查通过不关闭 Todo；整项新收尾要求已确认 task 覆盖，不能用 with_gaps 绕过。
  缺声明的旧计划不改摘要或历史，新的完成请求需要重新确认覆盖；
  已经持久化的历史收尾仍恢复原请求，不重复远端副作用。
- `completion_coverage` 展示声明范围、确认情况和剩余目标；它不代表检查结果或用户验收。
- MCP `todo_operation`：登记宿主操作、返回、采纳与失联。工具本身不创建 Agent。
- MCP `todo_done`、`issue_close`：通过可选 `completion` 接入同一收尾规则，
  显式 managed 调用返回结构化结论和失败恢复信息；省略该参数仍保留 legacy 行为。
- 本地 `contribbot-exec`：`bind`、`relocate`、`yield`、`inspect`、`check`、`observe`、`recover`、
  `reconcile`、`reconcile-close`、`report`、`close`；也有 `context`、`resume`、`apply`。

未安装本地可执行文件时，用构建入口：

```sh
node packages/mcp/dist/cli/execution.js --help
node packages/mcp/dist/cli/execution.js check --help
node packages/mcp/dist/cli/execution.js apply --schema
node packages/mcp/dist/cli/execution.js context --repo owner/repo --request request.json --data-root /absolute/isolated-data
```

每个动作的 `--help` 说明用途和输入，`--schema` 输出 `request.json` 的 JSON Schema。
二者无需 repo、已初始化任务或请求文件，从任意目录查询也不会创建任务数据，
即使附带损坏的 `--request` 文件也不会读取它。查询其他目录里的构建入口时使用其绝对路径。
字段来自实际运行时 Zod schema，顶层 repo、数据目录和 action 由 CLI 提供；
`apply` 只显示公开宿主动作，不展示内部检查完成、归档等状态转换。
schema 的 `x-contribbot.validation=structure-only` 明确表示**只描述输入结构**：
跨字段约束、当前流程状态、真实文件/证据及用户授权仍由运行时和宿主核对。
结构合法不等于请求一定可执行，更不等于任务已完成。

Windows 使用本机绝对路径。`data-root` 是包含 `owner/repo/` 的数据根，
不是项目数据目录本身；开发验证始终显式指定隔离目录。
请求文件为 JSON，传 `--request -` 可从 stdin 读取。请求与响应使用稳定
`todo_id`、`execution_id`；变更额外使用唯一请求 ID 和预期版本。
context/resume 的 `workflow_revision` 是下一次变更所用的版本；
已激活且尚无 workflow 时为 `0`，没有 execution 时为 `null`，查询不自动启用流程。

### Todo 文档同步

managed Todo 的 Markdown 包含 `contribbot:workflow:start/end` 受管理区域，
列出计划、确认、Next、检查来源与回执、候选和历史结论。区域外手写正文保留，
区域内不要手动记进度；YAML 是唯一状态依据，Markdown 不参与验收门禁。
无 ref 的 managed Todo 使用稳定 ID 对应的文档，同 ref 的不同任务代次仍隔离。

`document_projection.status=current` 只表示展示与已存状态一致，不表示任务已通过。
`outdated` 表示文件缺失或落后，`blocked` 表示归属、标记或文件读写有问题。
先修复阻塞原因，再调用 `todo_resume` 或本地 `resume`；它只重建展示，
不递增 workflow revision、不重跑命令，也支持已归档任务。
没有 managed workflow 的旧文档不会因此被迁移或改写。
状态持久化后展示写入失败，真实检查结果仍保留；不要因为文档没更新就再执行一次。

人工验收和独立审查用 `report` 导入时，必须附上实际被审阅的
`plan_id`、`attempt_id`、`epoch`、`candidate`（digest/root/git_dir/common_dir）。
`observed_at` 是来源实际观察的时间，不是为了导入而新填的时间。
应在发起验收时保留这些身份，不能在接收迟到意见时用最新候选替换。
工具先保存不可变原报告意图，再登记导入；中断后重试完全相同的请求只补原结果，
不重新发起人工或模型审查。期间文件漂移会记为 stale，原始失败不能重写为通过。
已有完整结果只恢复状态；原意图与结果都缺失的旧导入仍保守阻塞。
迟到的旧通过不能覆盖更新的失败，同一时间的通过也不能据此消除失败。
已完成报告丢失索引只恢复原始结果，不重新采样当前文件；原始内容丢失则保持缺口。
v2 结果核验其原意图，v1 历史结果保留原语义，不自动升级为新验收。
实际双进程测试覆盖同一报告在发布窗口重叠时只登记一次；
相同身份但内容冲突时只保留先登记的原意图，另一请求拒绝，不采用最后写入覆盖。

新流程已启用时，不能用旧 `todo_done`、改 status 或普通 archive 绕过收尾。
CLI `close` 与公开 MCP 的带 `completion` 收尾共用候选和证据核验。
公开 `todo_done` 已用真实 stdio 验证，`issue_close` 的 GitHub 行为使用 mock 验证；
没有对真实 GitHub 发起关闭。

### 检查环境与依赖输入

环境相关的命令验收在计划确认前声明 `command.dependency_inputs`，例如：

```json
{
  "executable": "C:/tools/node/node.exe",
  "argv": ["C:/tools/pnpm/bin/pnpm.cjs", "run", "test"],
  "timeout_ms": 60000,
  "max_output_bytes": 65536,
  "dependency_inputs": ["package.json", "pnpm-lock.yaml", "packages/app/package.json"]
}
```

这是命令字段示例，不是完整请求；解释器和包管理器路径应取自本机实际安装。
依赖输入是工作区相对的文件路径，不是 glob、目录或安装指令。选择本任务相关的
清单及锁文件；不自动添加、安装或推断全部依赖。首次预检发现声明文件缺失、
已删除、是目录或未被候选覆盖时，在登记检查前拒绝并指出路径，不执行命令。
生成这些文件可以是先前已批准的实现步骤；修改声明本身则需要新计划和确认。

新的命令回执 v2 保存 supervisor 平台、架构、系统版本、Node 版本与 Node 路径，
以及声明文件在检查前后候选中的摘要。回执不保存环境变量或依赖配置的原文。
检查中改变或删除文件不能通过；重试已有操作仍读取原回执，不重新采样依赖文件。
v1 历史回执可恢复，明确注明未记录依赖输入，不伪造 v2 数据，不因当前 Node/OS
升级而改写历史结论。`check`/`recover` 返回限制说明，`inspect` 在
`readiness.environment_limitations` 中附各项原回执的限制。

这些是输入来源记录，不是完整环境锁定。已安装依赖、包提升、全局模块、
环境变量、外部服务或任意子命令的版本不由这些字段保证，仍须对应行为检查。
Windows 的 `.cmd` 不能依靠隐式 shell 转换；使用实际 Node 与包管理器 JS 入口，
或在已确认命令中明确解释器及其参数。contribbot 不替调用方拼接 shell 命令；
包管理器执行脚本时可能自己使用 shell，不能据此宣称整个进程树不使用 shell。

## 公开收尾与迁移

`todo_done` 使用精确稳定 Todo ID 作为 `item`，例如：

```json
{
  "repo": "owner/repo",
  "item": "t-...",
  "completion": {
    "execution_id": "te-...",
    "closure_id": "finish-1",
    "expected_revision": 12,
    "mode": "verified",
    "acknowledged_gaps": [],
    "decision": "user-decision-locator",
    "note": "用户已要求完成"
  }
}
```

ID、版本和决定来源必须来自实际记录，示例不是执行授权。
`issue_close` 使用同一 completion，加 `todo_item`、`issue_number` 和可选 comment。
缺少精确 Todo 身份会在 GitHub 调用前拒绝；同一关闭 ID 改评论也会拒绝。
远端已成功、本地未收尾时，结构化 `recovery` 带原 closing 和远端回执引用。
保留原请求协调，不通过删除 completion、新建 ID 或只看成功措辞绕过失败。
prepared 重试重新核验；新 final outcome 落盘后保留终态，不自动归档。
本地 close 返回 `{ schema_version: 1, todo, archived: boolean }`。
仅历史旧请求的 pending archive 继续按原意图恢复，不能把新完成与归档重新绑定。

### 远端关闭后继续本地任务

如果公开关闭已经执行，但本地随后发生应保留的改动，旧候选不再适用。
此时不要删除改动或强行归档。核对原请求已经返回、所有相关写入者已查明，
由用户明确决定保留远端关闭并继续本地工作，再调用 `reconcile-close`。
请求包含 `todo_id`、`execution_id`、`closure_id`、`request_id`、`expected_revision`、
原负责人 `actor`、用户决定来源 `decision` 和 `report`。

`report` 包含实际来源 `source`（user/host_report）、`actor`、`locator`、`observed_at`、
原始核对内容 `raw`、原请求与写入者静止依据 `quiescence_basis`、
已审阅的当前候选摘要 `reviewed_candidate`、发生变化时的 `changes_review`、`unresolved`。
没有真实核对依据就不能提交；报告字段齐全不证明其内容属实，仍由合作宿主负责。
存在未解决事项、候选不符、过期版本或错误负责人时拒绝恢复。

| 观察到的事实 | 保存的记录 | 备注 |
| --- | --- | --- |
| 原关闭回执或已确认日志存在 | `recorded_closed` 历史副本 | 不重新查询或重复发布；不声明关闭操作者经过认证 |
| 只有 pending 日志或关闭回执缺失 | 互斥锁内查询 GitHub，CLOSED 保存为 `observed_closed` | 只证明观察时的远端状态，不证明由本工具关闭 |
| 原发布仍持有 Issue 锁或远端返回 OPEN | 等待原请求，或拒绝释放 | 不以“恢复”名义关闭、重开或评论 |

成功只解除当前收尾占用，保留同一 execution/attempt 的审计历史，推进检查轮次，
不修改源文件、不继承旧轮次通过结果、不归档。重新 yield 和实际检查后才能完成。
中断重试复用不可变恢复记录；保存状态之前不删日志，之后只清理精确的原日志。
后续关闭意图有独立 closure ID，重试旧恢复不能删除新日志。
`inspect` 和 verified 收尾也检查历史恢复记录、候选清单与远端证据是否仍可核验。

这些路径在隔离临时 Git 仓库中验证，GitHub 请求使用 mock，未操作真实 GitHub。
单独运行相关场景：

```sh
pnpm --filter contribbot-mcp exec vitest run src/core/tools/linkage/issue-close.test.ts --maxWorkers=1
```

### 工作区迁移

工作区记录实际 hostname/platform，防止另一台机器恰有同名目录时误验收。
这是协作式环境标识，不认证机器；主机名克隆等情况不在其保障内。
历史记录缺机器字段仍可读取，但不能据此验证本机文件。

用户确认迁移且旧操作全部已处置、没有 pending closure 时，使用 `relocate`：

```json
{
  "todo_id": "t-...",
  "execution_id": "te-...",
  "request_id": "relocate-1",
  "expected_revision": 12,
  "from_attempt": "old-attempt",
  "attempt_id": "new-attempt",
  "owner": "original-owner",
  "workspace": "/absolute/new/workspace",
  "plan_digest": "当前已确认方案的实际SHA-256",
  "decision": "user-relocation-decision-locator"
}
```

新旧仓库、原负责人和精确计划必须匹配。工具只记录新绑定，不复制代码；
新尝试必须重新 yield 和检查，不能继承旧检查通过。旧记录保留为历史证据，
迁移回执/清单缺失会形成显式缺口。普通 bind 不允许转移机器或工作区。
目标/验收受新环境影响时应重新确认方案；迁移不能替代 unknown 进程对账。

## 查询中断的检查

本地 `observe` 请求使用精确的 `todo_id`、`execution_id`、`operation_id`，
不需要变更请求 ID 或版本号。例如请求文件：

```json
{
  "todo_id": "t-...",
  "execution_id": "te-...",
  "operation_id": "check-..."
}
```

```sh
node packages/mcp/dist/cli/execution.js observe --repo owner/repo --request observe.json --data-root /absolute/isolated-data
```

结果分别报告原助手、独立执行进程（supervisor）和直属命令的 PID、机器、
可获取的启动时间及当前观察，
并附已保存结果回执的引用。不把 PID 复用、跨机器观察或元数据不可用当成原进程存活。
查询不终止进程、不重跑检查、不改任务状态，始终返回 `automatic_release=false`。
父进程消失不证明后代全部退出；没有完整回执时仍需核对原宿主任务和后代进程。

每次检查启动一个有界的独立执行进程，命令结束并保存结果后退出，不是后台常驻服务。
请求 CLI 退出但 supervisor 仍运行时，等待原检查并查询其回执；回执出现后用
`recover` 协调，不重复派工。一次性占用保存在 Todo 中，回执索引缺失也不能重启
同一操作。若 supervisor 本身也退出且没有结果，继续保守阻塞，不能靠 PID 消失
或手动改状态释放工作区。

若启动 supervisor 前失败，`observe` 可以返回 `initial_dispatch_retryable=true`。
这表示新协议的一次性领取尚未发生，可以使用**完全相同的原请求**调用 `check`
继续首次派发，不新建 operation ID。已经领取、状态未知或旧格式记录均不走此路径。

相关故障验证：

```sh
pnpm --filter contribbot-mcp exec vitest run src/core/execution/checks.test.ts src/core/execution/processes.test.ts src/core/execution/reconciliation.test.ts
```

测试实际启动并中断隔离进程，确认请求方退出后原检查仍能保存结果，且只运行一次；
也确认 supervisor 被终止而分离后代存活时，不会重复派工或启动第二个 writer，
并在测试后通知自有进程退出。另用受控的慢查询验证超时仍能阻止命令越时写文件。
这些结果不等于拥有完整进程树隔离或自动接管能力。

## 显式对账与继续

`reconcile` 用于超时或 supervisor 失联且无法正常恢复结果的原检查。
执行前必须实际核对原命令、全部后代及当前文件，取得用户恢复决定。
不能用“目录没变化”或“父 PID 不在了”代替这些检查。
普通完整结果应走 `recover`，此入口拒绝将其丢弃。

请求必须包含实际记录中的以下信息：

| 字段 | 含义 | 备注 |
| --- | --- | --- |
| todo_id / execution_id / operation_id | 原检查的精确稳定身份 | 不换 ID 来重复原检查 |
| request_id / expected_revision | 此次对账请求与最新版本 | 保存中断时先复用原请求 |
| actor / decision | 原负责人及用户决定来源 | 不是权限或身份认证 |
| report.source / actor / locator / observed_at | 用户或宿主核对报告的真实来源、观察者与时间 | source 为 user 或 host_report；时间须晚于中断 |
| report.operation_id / attempt_id / reviewed_candidate | 原操作、尝试及实际审阅的当前候选摘要 | inspect 可提供候选摘要，不自动解除占用 |
| report.raw / coverage_basis | 原始观察及如何查清原命令与后代的依据 | 非空文字不能证明内容真实 |
| report.descendants | 真实后代的 handle 与 locator | handle 使用 PID、机器、启动时间及观察时间；空数组不证明不存在后代 |
| report.accounted_missing / unresolved | 缺失 runner/supervisor/command 元数据的核对情况、剩余疑问 | 旧版无 supervisor 的实际执行者为 runner；未实际查清不能填空数组放行 |
| report.changes_review | 对检查以来文件变化的实际审阅 | 候选变化时必填；不表示变化已通过验收 |

工具重新观察记录的进程实例；运行中、跨机器或无法核实的实例都会拒绝。
旧版未使用 supervisor 的 runner 也必须停止；新版 runner 仅为请求方，不冒充执行者。
保存不可变报告和候选清单，发布后再次核对文件，再核对原版本和占用。
若期间变化，保留历史记录但不释放占用。

成功响应 `verification=not_verified`，状态 reconciled 只表示本次占用经显式
对账处置，不是命令成功或任务完成。旧命令不重跑、旧结果不改写，
之后需负责人重新 yield 并执行当前候选的检查。对账证据丢失时 verified 收尾拒绝。
保存中断的重试会重新观察进程和文件；已完成请求重试只返回原记录。

该能力仍依赖合作宿主对未列出的后代负责，不扫描/隔离完整进程树、不认证报告。
若无法实际查清后代，则保留受阻，而不是借 user 决定、关键词或状态标签放行。

## 验证原则

验收项描述用户可观察的结果，并匹配检查方式。单测通过、字段合法、
报告里写了 passed、文档包含特定词，都不能单独证明任务完成。
命令检查、审查报告、用户明确验收是不同来源，不相互冒充。

`inspect` 和最终收尾都会核对当前候选、必需验收及其保存的回执、候选清单。
证据丢失或损坏要明确显示缺口，不靠一次查看自动补成历史证据。
带缺口交付只能记录为 `with_gaps`，不能记录为 `verified`。

完成交互先执行已授权检查，再展示当前成果与需要判断的内容。待评价结果已存在、
其余收尾条件已满足，且用户对整个 Todo 明确验收并要求结束时，同一条真实反馈
可支持实际观察对象的人工报告与完成决定，核对全部门禁后完成，无需分别批准
report、inspect、done。不能代填未观察的人工项；没有人工项的方案不机械新增人工项；
当前 attempt 或评价对象尚不存在时不能补造反馈，失败或缺口不能自动豁免。
条件自动收尾尚未启用，具体流程见
[一次验收与完成](../../skills/todo/references/execution.md#一次验收与完成)。

## 跨项目工作区占用

不同项目记录、不同 `data_root` 也可能指向同一物理工作区。开始写入或检查时，
工具核对当前机器和实际 Git 身份，再检查其他已登记 Todo 的运行、未知、未接纳结果及收尾占用。
同一目录不能因换项目名或换数据目录获得第二个 writer；不同 linked worktree 可以分别工作。
委派同时保留主工作区与子 worktree，不能绕到子目录重新申请写入。

获取占用会写入两处内部元数据：

| 位置 | 作用 | 备注 |
| --- | --- | --- |
| 项目数据目录 `.execution-store.json` | 数据目录 UUID、已知注册表身份 | 不承载第二份操作状态 |
| Git 公共目录 `contribbot-workspaces/` | 参与项目引用和短事务锁 | 通常位于主仓库 `.git` 内，不纳入源码候选或 Git 提交 |
| Git 公共目录 `.contribbot-workspaces.json` | 初始化身份标记 | 新加入项目也能发现登记目录丢失或替换；不保存占用状态 |

`todos.yaml` 仍是操作状态的唯一来源。先登记再保存新操作，先保存释放结果再清理登记，
并在同一短事务内重读；进程在保存前后退出不会让已记录的 writer 消失。
重试已经处置的旧请求只返回当前事实，不重新获取历史占用。

记录缺失、损坏、身份被替换时，新占用申请保持受阻。应恢复原项目数据，再核对原任务、
执行者和产物；不要删注册表、手改 YAML 或用空目录冒充“已释放”。
首次初始化在标记写入和完整目录发布之间中断，也会保守拒绝而不是自动重建；
并发初始化期间的暂时拒绝可在原初始化完成后重试。没有自动强制清理或强制恢复入口。
`data:reset` 的删除范围没有扩大到 `.git`，重置前需先处置活动操作。
正常处置后，空参与者会被清理，不要求永久保留所有历史任务。

隔离场景入口：

```sh
pnpm --filter contribbot-mcp exec vitest run src/core/execution/workspace-occupancy.test.ts --maxWorkers=1
```

其中包含实际文件覆盖检查、两个同时竞争的 Node 进程，以及保存前后强制退出的恢复检查。
范围是当前协议下本机合作执行者与本地文件系统的进程崩溃，不是操作系统写权限隔离，
也不保证整机断电、网络文件系统或任意手工篡改后的恢复。首次切换到此协议前，
必须先处置旧执行者；无法自动发现从未登记的其他数据根，不与旧版本执行器混用。

## 本地委派交接

本地 CLI 的 `delegate-*` 命令记录和核对宿主委派，**不自行创建 Agent**。
所有变更请求仍包含稳定 Todo/execution/operation ID、request ID、expected revision 和负责人 actor。

| 命令 | 行为 | 备注 |
| --- | --- | --- |
| `delegate-prepare` | 保存原始派发 brief、token 和主/子工作区基线，保留占用 | 子工作区须为同源、非嵌套 linked worktree，并保留已有文件内容 |
| `delegate-attach` | 挂接真实宿主返回的 handle、原始结果与 locator | 缺少 handle 不表示未派发，不能自动重新派工 |
| `delegate-observe` | 保存原任务及其后代的实际观察依据 | source 为 host_report；终态声明不是代码验收 |
| `delegate-collect` | 捕获真实文件变化和越界路径 | 不编辑或整合代码；未知后代阻止收集 |
| `delegate-review` | 负责人审阅精确 result 摘要并检查目标基线 | 然后宿主才能在同一占用内整合该差异 |
| `delegate-finish` | 验证真实整合结果，记录 accepted/rejected | 不继承子任务检查；丢失证据会使 readiness 失效 |
| `delegate-inspect` | 读取原始意图、结果和限制 | 不查询 provider，不改变占用 |

`scope` 是相对工作区的字面路径，不是 glob。首版不支持委派提交或 Git 元数据整合；
隔离区中的 HEAD/index 变化将作为越界显示。重复请求必须复用原 request ID 和内容，
不能用新的 operation ID 绕开未知占用。

自动场景入口：

```sh
pnpm --filter contribbot-mcp exec vitest run src/core/execution/delegation.test.ts
```

这些测试使用真实文件和 Git worktree，但宿主观察由 fixture 提供。
真实宿主验证单独保存原始工具结果，不把自动测试里的 fixture task ID 当作真实 Agent。

## 验证范围与缺口

### 真实仓库试用入口

下一步用户试用选择一个范围明确的小修复，先约定可观察的输入/输出和保护文件。
没有 upstream、没有仓库知识库也应能完成；不必为已有项目重复 init 或清空数据。
正式切换运行时另行确认，先备份现有数据并处置旧连接/执行者，不能与旧版本混写。
本轮未执行该切换，也未在用户仓库发起修复或巡检。

试用时可给助手以下请求，替换具体修复内容：

> 用 contribbot 记录并推进这个小修复。先读取项目状态和现有改动，提出文件范围、
> 实现步骤和行为验收，等我确认精确方案后再改代码。保留原失败和返工记录，
> 中途让我换一个会话恢复同一任务。不提交、不推送、不操作真实 GitHub；
> 没有我的完成决定不要结束整个 Todo；归档也要另外由我决定。

用户应观察确认前文件是否不变、业务失败是否真实复现、修复是否满足原验收，
以及新会话能否读回同一任务且不重复执行。助手要用 `inspect` 核对当前文件，
不能只读到旧 passed 或 done 就声称有效。CLI 形状有疑问时先查动作级帮助。
上述是试验步骤，不是已经完成的用户验收；原生 Skills 自动发现也需在该宿主实测。

### 已验证边界

- 已用真实 Codex 子 Agent 在隔离临时仓库修复函数：挂接实际句柄、收集并审阅
  文件差异、整合后重新运行算术断言，保留用户已有修改，后续漂移使 readiness 失效。
  这是小范围宿主委派验证，不是用户真实仓库试用或完整 Agent Team 验收。
- 宿主报告可重新核对，但未知后代、缺失原始身份或无法核实的状态仍保守阻塞。
  本地失联/超时已有显式对账入口，尚不能代替真实进程树核对或真实跨平台验证。
- 旧数值索引调用者的全面审计；已修复 add/activate/claim 与 Issue/PR 关联的
  一批跨事务窗口，不能据此认定全部并发边界无缺口。
- 机器识别已加 hostname/platform 协作检查和显式迁移；不是机器认证。
  跨项目数据根已有共享物理工作区占用检查，真实跨机器环境尚未实测。
- 本次委派局部独立审查不等于全设计审计；真人仓库试用以及 Linux/macOS 实测仍缺。

此前 TypeScript 错误已修复，本机 `pnpm typecheck` 已通过；
类型检查、构建和行为验证仍是分别执行的检查，不能相互替代。
MCP 测试默认同时执行两个测试文件，避免真实 Git/进程 fixture 抢占资源；
各测试内部的多进程竞争仍执行，检查命令和断言的时限没有放宽。
整库回归与 smoke 建议顺序运行，资源竞争导致的超时仍视为失败而非自动忽略。
定位并行运行的失败时，可保留原断言及时限，单独运行：

```sh
pnpm --filter contribbot-mcp exec vitest run --maxWorkers=1
```

这只串行测试文件，不关闭各 fixture 内部的真实多进程竞争；重跑通过不能抹去
先前失败，也不能仅据此认定失败原因。
实际阶段性结果与 Next 记录在 `.catpaw/work/FR-003-phase-3.md`，
本说明不替代完整设计的交付审计。
