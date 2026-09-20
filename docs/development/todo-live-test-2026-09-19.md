# Todo 实际试用复测

日期：2026-09-19。状态：原函数 8 项测试、源码流程 28 个场景通过；发现一项初始化问题。
本记录不代表用户已验收，不完成或归档任何真实 Todo。

## 会话与范围

用户指定的测试任务为“验证 contribbot 新版 Todo 执行流程”，ID：
`01a0b25e-3fb5-7302-923c-bbca909f651e`。
工作区：`D:/dev/darkingtail/contribbot-test`。

主会话两次向该任务派发测试，工具都返回已完成、idle，但没有可读的助手
输出或工具执行记录。未查明原因，不能把派发成功记成测试通过，也不能
将其归因于 contribbot。以下实际命令和 MCP 调用由主会话执行，
不是目标任务独立完成的原生宿主验收。

未实施此前未确认的前后端工程。保留原函数文件、个人数据、真实任务和
历史人工验收；没有 setup、全局数据清理、提交推送或 GitHub 写入。

## 原任务复测

| 检查 | 观察 | 备注 |
| --- | --- | --- |
| 测试仓库有效 MCP 配置 | Node + 仓库 tsx + `packages/mcp/src/mcp/index.ts` | 实际 `codex mcp get contribbot --json`；只显示脱敏启动字段 |
| `node --test summarizeTodos.test.mjs` | 8 通过、0 失败，exit 0 | 直接命令，不伪装成新的 managed 检查回执 |
| 原 Todo 的 MCP context | active，phase=check，workflow revision=15 | 未改变状态、原计划或历史验收 |
| 源码 Skill CLI `inspect` | readiness=true，missing/gaps/errors 均为空 | 原候选与历史回执仍匹配，不是今天的 contribbot 产品验收 |
| 整体覆盖声明 | legacy，scope_allows_task_completion=false | 原计划缺新版覆盖字段；未补造确认，不尝试关闭 |
| 文档投影 | outdated | 未自动修复或改写原文档 |
| 仓库状态 | main，仍只有原两份未跟踪函数/测试文件 | 没有修改业务文件或开始新工程 |

原 Todo：`t-bd976114-922d-43e9-802b-196650e8337c`。
Execution：`te-ab943dff-c8f8-410b-9715-5b1b98bbc73f`。
当前候选摘要仍为：
`72e9304d17911f1a3e812e6492c6a5b21924c3f3742af595f1b11bb4b481e0c4`。

## 初始化失败

真实 MCP 调用 `project_init(repo="darkingtail/contribbot-test")` 返回：

```text
Unsupported Todo status: "pr_submitted".
Expected one of: idea, backlog, active, paused, cancelled, done.
No data was converted.
```

只读检查定位到另一个项目 `antdv-next/antdv-style` 的 `todos.yaml`，
其中 ref=`ant-design-antd` 的记录仍为 `pr_submitted`。当前测试项目配置为
`upstream: null`、`upstream_confirmed: true`，不需要重新询问 upstream。

源码调用链：
[project-init.ts](../../packages/mcp/src/core/tools/core/project-init.ts) 的
`projectInit` 在返回当前项目上下文前调用全局 `projectList()`；
[project-list.ts](../../packages/mcp/src/core/tools/core/project-list.ts) 逐项目
执行 `todoStore.list()`，没有将单个项目读取错误与其他项目隔离。
因此无关项目的旧状态令当前正常项目的初始化整体失败；
原任务的直接 `todo_context` 和本地 `inspect` 均可工作。

拒绝旧 Todo 状态本身符合用户“不用兼容，不用管老的”的决定。
本次问题是跨项目失败影响范围与诊断，不是要求恢复旧状态支持。
当前只记录事实，未选择新设计、修改产品源码或迁移旧数据。

## 隔离验证

从测试仓库运行当前源码及 Skill 公共入口：

```text
node D:/dev/darkingtail/contribbot/packages/mcp/scripts/execution-smoke.mjs --source-skill
```

测试使用临时 HOME、数据根、Git 夹具和 MCP/CLI 子进程。终态、归档、
暂停与取消决定均为脚本夹具，不是个人真实任务的用户决定。
使用模拟 GitHub，不进行真实远端写入。
进程已结束，exit 0；最终 JSON 为 `outcome=passed`、
`runtime=source-skill`、`platform=win32`，28 个场景全部通过。

| 覆盖范围 | 结果 | 备注 |
| --- | --- | --- |
| 未确认计划、检查失败后修复、候选变化和缺失证据 | 通过 | 检查由实际子进程执行；不把失败或过期证据记为通过 |
| CLI/MCP 跨进程恢复、回执恢复与文档投影修复 | 通过 | 恢复既有结果而非重复执行；部分恢复日志由夹具预置 |
| 完成不归档、显式归档预览与选择 | 通过 | 完成与归档决定来自脚本，不作用于真实 Todo |
| 暂停、继续、中断检查和工作区占用 | 通过 | 继续后需新证据；未覆盖任意进程树或委派 Agent 的停止 |
| 阶段验收与整体验收 | 通过 | 阶段成功不能结束整项 Todo |
| 多 PR 关联、文件与本地提交交付、远端端点核验 | 通过 | PR 关联不改变主状态；据报告合并或内容不符不能满足交付 |
| Issue 为 open/closed 时的暂停与取消 | 通过 | 使用模拟 GitHub，不代表真实远端写入验证 |
| 未开工取消、重开后的过期取消、已移除状态 | 通过 | 过期请求及旧状态在写入前被拒绝 |

本轮验证使用的 167 文件候选仍与
`.catpaw/discussions/phase3-claude/round-142.final-candidate.json` 一致，
摘要为 `1d3c706de41f250a3bd7fd541e66f05de626710d21ffd248a6947f72f3c71dbd`。
它是内容快照摘要，不是 Git commit，也不是用户验收。

以上是 Windows 上的隔离源码入口验证，不代表 macOS/Linux、真实 GitHub
写入、目标任务原生长对话或人工验收已通过。脚本夹具中的进程已知没有后代，
不能据此声明任意进程树或失联 Agent 都可安全停止。未重跑此前完整回归。

## 后续

初始化的跨项目失败已记录为
[OBS-003](todo-dogfooding-issues.md)，尚未修复。
目标任务空结果派发的原因仍未查明，不能算作原生任务试用通过。
主仓库跟踪 Todo 保留 active/check，原测试 Todo 的状态、计划和验收记录不变；
未自动完成、取消或归档，也未提交或推送。

## 备份后复测

2026-09-19 用户要求备份当前 `.contribbot` 后，重新测试指定任务和
`antdv-style`。本轮未获得清空或转换数据授权，保留原目录。

备份目录：
`C:/Users/WANGX/.contribbot-backups/2026-09-19T12-04-58-485Z-1498ee91/`。
`data/` 是完整副本，`manifest.json` 保存逐文件 SHA-256、大小和目录条目。
共 42 文件、97,969 字节、19 个子目录，无符号链接或特殊文件。
复制前、复制后原目录和备份内容一致；复测后的再次校验也一致。
清单 SHA-256：
`5c12d5b398caeb58a63cf1c03feeea0db83913497b706c0f688937f3962328b1`。

分别向原任务发送一轮有限复测请求，不授权业务开发、数据转换或远端写入：

| 任务 | 本轮 turn | 观察 | 备注 |
| --- | --- | --- | --- |
| 验证 contribbot 新版 Todo 执行流程 | `01a0b98f-1c59-7d33-8e11-653d2c1417b9` | completed、idle，读取接口未提供助手消息或工具回执 | 任务 ID 为 `01a0b25e-3fb5-7302-923c-bbca909f651e`；不能证明实际测试通过，也不能仅据此断言没有执行 |
| 检查主分支最新状态 | `01a0b98f-2111-7c13-811f-1cefb9d8afd4` | completed、idle，读取接口未提供助手消息或工具回执 | 任务 ID 为 `01a0a9df-cc43-7412-9eb8-f99108c2e11a`；工作区为 `D:/dev/antdv-next/antdv-style` |

主任务随后实际执行，结果如下：

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| `project_init`，`darkingtail/contribbot-test` | 失败：旧 `pr_submitted` 状态 | 全局项目读取传播 OBS-003，未转换数据 |
| `project_init`，`antdv-next/antdv-style` | 失败：旧 `pr_submitted` 状态 | 本项目仍有旧数据，备份不改变运行时读取的数据 |
| `todo_list`，`antdv-next/antdv-style` | 失败：旧 `pr_submitted` 状态 | 拒绝读取旧 Todo 状态，不是远端 PR 错误 |
| `todo_list`，`darkingtail/contribbot-test` | 成功：1 active，phase=check | 原 Todo 未完成、未归档 |
| `node --test summarizeTodos.test.mjs` | 8 通过、0 失败，exit 0 | 在测试仓库重新运行，直接命令而非 managed 检查回执 |
| 备份与原数据复核 | 42 文件和全部目录条目一致 | 实际 MCP 复测后核对；未清空、迁移或改变个人数据 |

本轮没有重跑 28 场景或完整套件，未修改产品源码、运行 setup、提交推送，
也未把脚本测试当作用户验收。干净数据目录上的从零试用尚未执行。

## 清空后从零初始化

随后用户澄清“备份 `.contribbot` 然后重新开始”，授权重置整个本地数据目录。
2026-09-19T12:14:23.095Z 已完成，不再要求用户重复确认。

执行前再次核对既有备份与原目录 42 文件的 SHA-256 和全部目录条目一致。
首次尝试将原目录移入备份目录的 `original/` 时，Windows 返回 `EPERM`，
未移动任何文件。之后调用现有 Node `scripts/data-reset.mjs` 的
`planReset/applyReset`，校验绝对目标为 `C:/Users/WANGX/.contribbot`，
按清单清除原文件与空目录，重新建立空目录；没有调用递归 shell 删除。
备份目录不受影响，仍逐项校验一致。重置回执保存在同一备份目录的
`reset.json`，确认 `new_root_empty=true`、`backup_verified=true`。

两个原任务各收到从零初始化请求；本轮 turn 分别为
`01a0b997-7973-7342-8f08-14b494a8d9c6` 和
`01a0b997-7b38-79a2-949b-9011f3b2636f`。读取接口仍仅返回 completed/idle，
未提供助手消息和工具回执。主任务复核前已观察到 `antdv-style` 新配置，
但不凭此推断其完整交互流程已通过。

主任务随后实际调用并确认：

| 项目 | 初始化 | Todo 列表 | 备注 |
| --- | --- | --- | --- |
| `darkingtail/contribbot-test` | 成功，upstream=pending | 空列表 | 新配置；未恢复原 Todo、执行或历史人工验收 |
| `antdv-next/antdv-style` | 成功，upstream=pending | 空列表 | 未静默写入原 upstream，也没有恢复旧 `pr_submitted` 数据 |

最终活跃数据根只有这两个项目的 `config.yaml`，没有其他文件；完整旧数据仍
保留在备份 `data/` 中。待用户确认新的 upstream 选择后再推进后续试用，
不能把 pending 当作明确不追踪。未新建任务、完成或归档任务，也未运行 setup、
修改产品源码或仓库业务文件、提交推送或写 GitHub。

本次通过的是干净数据的初始化与空列表；OBS-003 的跨项目错误传播未改代码，
不能宣称缺陷已修复。此前 8 项函数测试与 28 场景保留为历史证据，未重复执行。

## 指定任务内的后续复测

2026-09-19 用户要求继续到原任务测试真实闭环。本轮没有替用户确认新计划、
选择 upstream、模拟人工验收或完成 Todo。

向原任务派发后，读取接口仍显示空 items。主任务进一步只读核对该任务的本地
rollout 日志，发现此前“没有可读回执”不等于目标任务没有回复：
`01a0b9bf-12bc-7e40-8190-703b2b3db036` 和随后缩小请求的
`01a0b9c0-f7cd-7d01-8d87-8927c5c27209` 都有助手正文，但没有实际工具调用，
仍重复清空前的 `pr_submitted` 阻塞判断。这些正文不是新的错误复现。
核对时测试项目仍只有新 `config.yaml`，没有 `todos.yaml`，额外报告文件也未创建。

随后在测试工作区用本机 `codex exec resume` 续接同一任务 ID，只要求实际
`project_init` 和 `todo_list`，不新建任务、不修改全局配置、不绕过权限。
CLI 返回的 `thread_id` 与用户指定任务一致，实际观察到以下新调用：

| 调用 | 本轮结果 | 备注 |
| --- | --- | --- |
| `project_init(repo="darkingtail/contribbot-test")` | `user cancelled MCP tool call` | 未取得项目上下文，不是旧数据错误 |
| `todo_list(repo="darkingtail/contribbot-test")` | `user cancelled MCP tool call` | 未取得列表，不将此前主任务结果冒充本次成功 |

CLI 进程最终 exit 0，但两项工具均失败，不能作为测试通过。
末条回复保存在
`C:/Users/WANGX/AppData/Local/Temp/contribbot-native-retest-20260919-01a0b25e-cli.txt`。
取消原因未查明，不能归因于用户手动操作，也不能直接归因于 contribbot。
未绕过取消继续重试。本轮未创建新的 Todo/计划或运行函数测试，真实闭环仍未完成；
需先让原任务取得实际工具结果，再继续计划确认和执行。

## 新任务启动失败排查

用户随后要求在测试目录新建任务，已创建“从零实测 contribbot Todo 闭环”：
`01a0b9d3-fb11-7e82-a287-22924b90b96d`，工作区仍为
`D:/dev/darkingtail/contribbot-test`。2026-09-19 21:21（Asia/Shanghai）
首轮启动失败；本节只记录诊断，不代表原生 Todo 闭环已开始或通过。

任务返回的错误为：

```text
status_code=400, kind=invalid_request
function_call_output requires call_id on HTTP requests;
continuation via previous_response_id is only supported on Responses WebSocket v2
request id: 202609191321180567406138268d9d6MRaSEvBA
```

上面是当前服务返回的原文，不能将其关于 WebSocket 的措辞推广为所有
Responses API 的限制，也不能据此断言改用 WebSocket 即可解决。

| 检查 | 证据 | 备注 |
| --- | --- | --- |
| 任务已创建 | 桌面日志记录 `thread/start` 成功，工作区与目标一致 | 不是创建目录失败 |
| contribbot MCP 启动 | 桌面日志在 `13:21:15.374Z` 记录 `server=contribbot status=ready` | 启动成功不等于工具业务调用已成功 |
| 启动消息 | rollout 第 7 行为 `function_call_output`，`name=create_thread`，内容是测试委派提示；缺少 `call_id` | 此任务中没有在它之前发起的模型工具调用 |
| 模型请求 | 当前 provider 使用远端 `responses` 路由，任务收到上述 HTTP 400 | 没有取得原始 HTTP 请求体或服务端 trace |
| 实际测试 | 此轮没有 contribbot 工具调用，最终回复为空 | 错误发生在测试业务执行之前，不是旧 `pr_submitted` 的新复现 |
| 自动任务描述 | `13:21:36.053Z` 的桌面日志记录 `gpt-5.6-luna is disabled by global configuration`，HTTP 404 | 独立的辅助模型错误，不能当作前述 400 的原因 |

证据文件：

- `C:/Users/WANGX/.codex/sessions/2026/09/19/rollout-2026-09-19T21-21-12-01a0b9d3-fb11-7e82-a287-22924b90b96d.jsonl`。
- `C:/Users/WANGX/AppData/Local/Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Local/Codex/Logs/2026/09/19/codex-desktop-e81fe335-aaf5-4863-b6f6-fa9b44db2d25-86868-t0-i1-104832-0.log`。

当前结论：新任务的委派启动内容被记录为缺少调用关联 ID 的工具输出，
而当前 HTTP 服务明确拒绝这种输入。问题范围已缩小到 Codex 跨任务消息
组装与模型中转兼容链路；尚不能仅凭本地 rollout 判断具体哪个组件应修复。
配置中的 provider 名称也不能证明本机同名代理实际参与了请求转发。

后续可用普通用户消息启动测试作对照，避免自动委派入口；该路径尚未验证，
不能称为已修复，也不保证向已有失败任务追加消息会绕过历史中的异常条目。
本次未重试被取消的 MCP 操作，未修改 Codex 配置、鉴权、会话历史或产品源码，
未再次清空数据，未提交或推送。先前原任务的读取接口空结果和 CLI 工具取消
仍分别保留为待查现象，不将它们未经验证地归为同一原因。

## 同一任务手动消息后的实际进展

随后用户在“从零实测 contribbot Todo 闭环”任务
`01a0b9d3-fb11-7e82-a287-22924b90b96d` 中手动输入，原生工具调用已成功。
本节更新前述“尚未验证”的结论：同一失败任务可以经本次普通用户消息继续，
不必为本次试验再建一个任务；不表示自动派发或任意历史格式问题已修复。

目标任务实际完成初始化、查重、新建 Todo、激活和方案准备；用户在看到
`local-loop-v1` 方案后回复“开始”。最新 turn
`01a0b9fc-fc53-71a1-8d0e-8c0473b1bc1d` 因此实际执行方案确认、绑定、
yield 和本地 managed check。本轮检查不是主任务代跑，没有导入旧通过。

| 项目 | 实际结果 | 备注 |
| --- | --- | --- |
| Todo | `t-4799cdef-396b-4ab6-b449-dfe92b9d034f`，ref=`local-todo-loop-20260919` | 新记录，没有恢复备份中的旧 ID |
| 执行 | `te-c69cb161-558f-4427-80cb-bfb13a10a878` | 同一执行内继续验证 |
| 已确认方案 | `local-loop-v1`，整项范围仅为现有函数与流程 | 不包含前后端工程或新增代码；暂停、继续、验收和完成决定仍分开 |
| 首次检查 | 8 通过、0 失败，exit 0，process_stopped=true | 原始 TAP、CLI 回执与本地 YAML 检查记录一致 |
| 检查时间 | 2026-09-19T14:07:47.447Z 结束 | 即北京时间 22:07:47 |
| 检查前后候选 | `72e9304d17911f1a3e812e6492c6a5b21924c3f3742af595f1b11bb4b481e0c4` | 内容未变，不为测试故意破坏代码 |
| 当前状态 | active/check，workflow revision=7、epoch=2 | 未 paused、done 或 archived；没有人工验收记录 |

操作 ID：`check-local-loop-initial`，验收项为 `a-tests`，
回执摘要：
`93ef7d79393bdcdfc37ff1ea1ff33fc5b65560068c7bfae1d7878333a742b71d`。

仍存在已登记的 OBS-002：助手用 `todo_progress` 同时传入 `phase="check"`、
Next、blocked_on 和 evidence，工具拒绝：

```text
Managed execution phase is derived from its workflow, not manually assigned.
```

本次拒绝是正确保护，不应放开手动改阶段来修复。此前由本地检查助手保存的
检查记录不受影响；被拒绝请求中的 Next/阻塞说明没有落盘。
主任务只读核对当前 Next 仍是通用待检查说明，`blocked_on=null`，
所以“等待用户决定是否暂停”目前是目标任务对话中的下一步，
不是已持久化的阻塞状态。这一使用体验需要后续处理。

目标任务已向用户询问是否暂停。主任务本轮只查看对话、核对原始输出和
持久化状态、更新文档，没有派发消息或代替用户作暂停、继续、验收、
完成决定，没有重新运行测试、修改产品代码、提交推送或清空数据。

## 暂停、取消与重开后的进展

目标任务随后有真实用户输入和对应工具操作，主任务读取最新七轮中的相关
记录，并只读核对本地 Todo 数据。所有时间均为 2026-09-19、Asia/Shanghai。

| 行为 | 实际观察 | 备注 |
| --- | --- | --- |
| 用户要求暂停 | 22:17:54 settle-pause 成功，状态 paused，revision=10，禁止新派工 | 原检查已结束；不是运行中强制终止测试 |
| 用户要求继续 | 22:19:21 恢复原 execution/attempt，epoch=3；重新 yield/check，8 项通过 | 不是只调用 resume 就自动开工，保留旧回执 |
| 用户要求取消 | 22:30:36 stopped 收尾成功，cancelled、archived=false | 原 execution 为 abandoned，保留文件、证据和人工验收缺口 |
| 用户要求恢复 Todo | 同一稳定 ID 重开为 backlog，生命周期版本为 1 | 当时不创建执行，不自动恢复运行 |
| 用户要求继续执行 | 创建新 execution，准备并展示新的接续计划 | 不将旧检查复制为本轮通过，不重新要求重演已完成的暂停过程 |
| 用户回复“确认验收完成” | 助手记录接续方案确认与完成意图，随后运行本轮检查 | 当时新检查结果尚未产生，未记录为新的人工验收通过 |
| 新执行检查与审阅 | 22:35:44 检查 8 项通过，22:36:31 新的非独立流程审阅通过 | 文件候选未变；检查与审阅是不同来源 |
| 最新 inspect | ready=false，missing=a-user，三个交付端点均 present | 等当前结果的人工验收，不是测试失败或产物缺失 |

新 execution：`te-dbb55eaa-d0ac-4bc5-bcff-0614add3abb9`，
计划 `local-loop-reopened-v1`，attempt `attempt-local-loop-reopened-1`。
本地复核时 Todo 为 active，phase=check，workflow revision=9、epoch=2。
原 execution 保留 revision=22、phase=finish、outcome=abandoned。

新的检查回执：
`61221bd2503dd2b3e5954e6bf986e266e09ec4a5133d33b0e8a18748f9121984`；
非独立审阅回执：
`023c2ba15b9f78254d6824e6b342fd9fbf4989231aded590e85581883d0f42bb`。
检查候选仍为
`72e9304d17911f1a3e812e6492c6a5b21924c3f3742af595f1b11bb4b481e0c4`。

这次扩大了真实路径的验证范围，但完成未归档的最终一步仍未发生。
用户已表达完成意图后再次被请求人工确认，是值得保留的交互体验观察；
是否需要调整确认语义尚未讨论，不能借记录直接放宽验收规则。
主任务没有向目标任务发消息、补写用户验收、改变 Todo 或重跑命令检查。

用户反馈当前需要再次确认“有点麻烦”。这不是用户表达不清，而是本轮先收到
完成意图、后产生新检查结果时，已确认人工项仍要求查看本轮结果，且当时新
attempt 尚不存在，造成了额外交互。并非所有任务都要求人工查看测试结果，
不能把本次方案推广为“一切人工验收必须晚于所有命令检查”的通用规则。

### 完成确认体验的设计咨询

随后用户要求先与 Claude 讨论再改代码。沿用长期会话完成 round-143/144：
首轮“保存意图、结果出来再短问一句”被主助手追问，因为它没有减少确认次数；
第二轮支持先改善方案编写与一次表达完成，条件完成授权单独后续设计。
主助手不采纳“人工查看机器报告一定是错误”的绝对判断，保留真正需要人的验收。

本次问题登记为 OBS-004，推荐方案、源码依据、不同意见及待验证场景见
[Todo 完成确认体验](../plans/2026-09-19-todo-completion-confirmation.md)。
该咨询轮仍是设计建议；没有静默删除本次已确认的 `a-user`，没有补造观察时间，
没有向测试任务发消息或修改 Todo 状态。本节也不代表再次核查了测试任务的最新状态。

随后用户在主任务中确认先实施默认完成引导，条件自动收尾暂缓。
MCP 的无条件再次询问规则已修正，并同步 Skill、Schema 帮助及执行参考。
隔离环境的 75 项定向回归、类型检查和构建通过；同一用户消息定位符支持
人工报告与完成决定、缺人工记录仍拒绝、命令后到不自动结束均有行为验证。
Claude round-145 复查后澄清人工项实际覆盖、当前结果前提及归档提示，
补上多个人工项和周回顾回归；23:30 启动的最终定向回归为 5 文件、78 项通过，
类型检查、MCP 构建和构建 CLI Schema 解析再次通过。
这里的用户消息由测试夹具提供，不是本节真实任务的用户验收或修复后宿主实测。
未向原测试任务发指令，未修改其方案、状态或数据；仍需后续真实对话验证。
