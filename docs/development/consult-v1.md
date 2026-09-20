# Consult V1：只读顾问

Consult 是当前主助手向另一位 Agent 获取建议的能力，不是 Agent Team。
讨论独立保存，可选关联 Todo；没有 Todo 也能先讨论。建议、主助手综合、用户决定分开，
不把顾问的回答当作检查通过、Evidence、权限或 Todo 完成决定。

## 使用流程

向安装了当前源码 MCP 和 Skills 的助手说“请 Claude 评审这个方案”。
助手准备必要上下文，先展示顾问、材料和边界，再按单次请求或已有有限额度调用。
本版需要原生 CLI 的绝对路径；不执行 `.cmd`、`.bat`、`.ps1` 或仓库同名程序。

| 步骤 | 入口 | 备注 |
| --- | --- | --- |
| 预览 | `consult_start`，不传 `confirmed_preview` | 不写咨询记录，不调用模型；读取材料与 CLI help/version |
| 派发 | 原输入加 preview digest 和真实授权 | 异步返回 discussion/turn ID；每轮只启动一次 |
| 观察 | `consult_status` | 恢复已发布结果、观察原进程，不重发 |
| 读建议 | `consult_read` | 默认不返回 packet 和原始协议日志 |
| 综合 | `consult_decide` 的 synthesize | 绑定当前 revision、来源 turn 和 output digest |
| 人工决定 | `consult_decide` 的 decision | 只追加决定；改计划或实施仍走原工作流 |
| 管理额度 | `consult_control` 的 grant/revoke | 先预览精确 digest，再根据用户决定授予或撤销 |
| 解除异常占用 | `consult_control` 的 reconcile | 本机观察、来源报告、精确版本和用户授权；仅解除本地占用 |
| 清理原文 | `consult_purge_raw` | 精确确认后删除本地原文，不自动清理 |

每次显式传 `repo=owner/repo`。MCP 在其所在机器执行，`workspace` 必须是该机器上的目录，
不能把远程 MCP 路径当作本机路径。`todo_context` / `todo_detail` 只读显示关联咨询摘要；
咨询数据损坏不应阻塞 Todo 本身。

## 授权与数据

授权来自本次用户明确请求、可撤销的 Todo 有限额度，或用户认可精确 digest 的仓库规则。
规则文件本身不是授权。额度绑定用途、顾问 disclosure、材料类别、路径、最大轮数。
派发前即占用次数；没有得到结果不自动退款或重发。准备结束、实际启动前再次在锁内核对。

默认一位顾问一轮；“讨论到有结论”先建议三轮并征得确认，第二位顾问要明确加入。
Todo 暂停冻结新调用，结束、重开换代、规则变更或撤销使旧额度不可继续使用。
用户决定记录与授权记录不能由顾问回复伪造。

默认发送 HEAD 中明确选定的已跟踪文本。工作区 diff、未跟踪和 ignored 文件要显式选择
及授权。Packet 记录路径、类别、来源与 digest；拒绝 `.git`、常见凭据路径、链接越界、
二进制和可识别的凭据内容。启发式筛查不是完整的防泄密系统。

`rehydrate` 在新进程中带入已记录决定和同一顾问近期有效回复；`fresh` 不带历史。
用户决定优先于普通历史，必需上下文超过 128 KiB 时明确拒绝，普通历史省略可见。
它不承诺恢复运行时未记录的隐含上下文，也不自动压缩或接受模型生成的记忆。

## 只读边界

| 运行时 | 模型写入约束 | 读取及验证限制 |
| --- | --- | --- |
| Claude | 无模型工具、严格空 MCP、禁用权限提示和 slash commands | 不是 CLI 的 OS 隔离；验证初始化事件的空工具集 |
| Codex | read-only sandbox、never approval、忽略用户配置与规则 | 读取不局限 Packet；离线写入探针失败则不调用模型 |

两者在临时 cwd 以显式 argv、最小环境运行。CLI 仍可能读取 OS 账号可读的其他文件、
把内容发送到远程服务，以及写自己的日志/认证元数据；调用前说明这些限制。
不承诺“只看得见 Packet”。Codex 探针只证明当前二进制、机器、配置下的几次负向写入，
不是跨平台安全认证，也不等同于真实模型鉴权或调用成功。

## 停止与恢复

没有模型执行硬截止时间。`stop_wait` 只停止等待；`terminate_advisor` 请求原 supervisor
终止父进程；`abandon` 表示不再采纳该轮。三者不能互相代替。父进程退出不证明后代
或远程请求已结束，不确定事实以 `reconciling/unresolved` 保留。

相同 request ID 和相同已确认输入返回原记录，不再次消耗调用。输入变化须使用新 request ID，
不允许绕过仍在运行或未核实的占用。已落盘而索引未更新的结果可通过 status 恢复。
暂停、上下文变化、撤销或放弃后的迟到结果保留历史，不自动加入综合。
咨询失败不冻结 Todo 的其他实现工作。

用户已确认 Claude round 166 讨论的异常恢复规则。`consult_control` 的 `reconcile`
解除的是**本地占用**，不承诺远端请求已终止，也不承诺服务端绝对不会并发。
助手先实际查清本地相关进程，再展示范围和远端不确定性，由用户明确授权。

为避免后代报告先于父进程停止，恢复分两次调用同一 action：
先只传 `id/discussion_id/turn_id/expected_revision`，工具在锁内观察并追加
`release_observation`，返回它的 id/revision，仍保留占用。
随后实际检查后代，最后提交该 `observation_id/revision`、晚于该观察的报告和用户决定。
工具再次观察原句柄；中间的 attach/dispatch/control/result 会改变 revision，使旧观察失效。
准备步骤精确重试返回原观察，不重复追加。它不调用模型，也不是对整棵进程树的验收。

| 核对项 | 输入或记录 | 备注 |
| --- | --- | --- |
| 精确对象 | discussion/turn、reconciliation id、`observation_id/expected_revision` | 版本变化拒绝；同一请求幂等，改变报告、版本或决定不能复用旧 ID |
| 用户决定 | `decision`、`accept_remote_uncertainty=true` | 记录真实授权，不把诊断或字段非空当作用户同意 |
| 操作者报告 | `report.source/actor/locator/machine/observed_at/method/scope` | 有来源的陈述，不冒充工具已验证整个进程树 |
| 后代覆盖 | `handles_covered`、`all_descendants_stopped=true`、空 `unresolved` | 必须覆盖精确原句柄集合；报告应包含可能未登记的后代，不能推断无句柄即未启动 |
| 本地 OS 观察 | 工具锁内重查 supervisor/advisor | 运行中、未知、异机拒绝；PID 被替换须有原启动时间，不向 PID 发信号 |
| 原始事实 | 原结果、outcome、digest、unresolved、额度 | 不覆盖失败或消耗，不退款；远端生成及计费保持 unknown |

报告时间须严格晚于持久化的父进程停止观察、不早于该轮最近活动，不能是未来时间。
缺少原 supervisor 身份时无法建立停止观察，当前保留占用，不提供重新绑定句柄的捷径。
确定的启动前失败仍按原流程结束；丢失身份不等同于确定未启动。
解除后在独立的
`reconciliations` 中追加记录，标记 `reconciled_by_attestation`，不是咨询成功或任务验收。
后续咨询是新的 request，仍需通过预览和授权检查，可用仍有效的剩余额度。
迟到结果可以恢复为历史，但不重新占用位置、不进入综合。关闭讨论、关联 Todo、
清理原文分别仍需原有的明确决定；解除本身不会执行这些动作。
原文清理保留 reconciliation 审计元数据，不自动清理 scratch 或服务商记录。

## 开发验证

```bash
pnpm --filter contribbot-mcp exec vitest run src/core/consult src/core/tools/core/consult.test.ts src/mcp/consult.test.ts
pnpm --filter contribbot-mcp typecheck
pnpm --filter contribbot-mcp build
```

真实 smoke 明确会调用一次模型，可能产生额度消耗。使用纯合成问题和临时 contribbot 数据，
保留调用记录供检查，不读取真实仓库文件，不改真实 Todo，不安装运行时或修改用户配置：

```bash
node packages/mcp/scripts/consult-smoke.mjs claude /absolute/path/to/claude
```

Windows 传相应 `.exe` 绝对路径。用 `codex` 参数测试另一 binding；不因失败自动切换。
构建不等于当前宿主已重连，测试也不代表用户已经验收。

2026-09-20 异常恢复初版验证了 43 项 Consult 定向用例；
独立审查之后增加并复现报告时序竞态，修复后扩大定向回归 84 项通过，其中 Consult 为 47 项。
最终类型检查和构建通过，跨午夜取得的独立复核没有发现新增可行动问题，11 个文件指纹已核对。
同日较早候选另有 36 项开发工具回归通过；
先前同日的构建候选完成一次真实 Claude 合成问题闭环，未自动重发。
Codex 目前只有离线写保护探针和协议测试通过，真实模型鉴权成功尚未验证。
此前被中断的全量 MCP 回归不计为通过。后一次取得完整回执：952 通过、1 跳过，
唯一失败是新增报告时序用例；它在修复后的定向组已通过。未把这一整轮报告改写为全绿。
当前结果仍不是 V1 整体验收，最新证据见 [进度入口](../progress/README.md)。

## 代码与扩展

`core/consult` 独立负责记录、Packet、binding、transport 和 supervisor；
MCP 只做入口编排，记录位于 `~/.contribbot/{owner}/{repo}/consult/`，不占用执行证据目录。
读写用 Node API，跨进程锁沿用 Todo 锁，避免咨询派发与 Todo 暂停互相错过。

runtime binding 和 transport 分离。后续 ACP、Pi RPC、PTY 需自己的协议、权限和取消验证，
不能把添加一个名字当作已经适配。目前只有 Claude/Codex native-one-shot 实现；
PTY、多 Agent 调度、远程执行、自动重试、自动 TTL 和自动知识沉淀不在 V1。
