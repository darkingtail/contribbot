# Runtime 拆分执行前审查

日期：2026-09-22，Asia/Shanghai。
状态：执行前审查、批次 0b、空包接线验证和共享 Core 抽取前设计审查均已完成；等待边界决定。
Claude round-171 因 HTTP 524 失败；round-172 成功给出有条件 GO，round-173
指出候选问题，round-174 复核修正后明确“未发现本批必须修复的问题”；round-175
完成只读设计审查并已记录综合。
本文件记录预检及首批执行结果，不是整体拆分完成或用户验收记录。

## 授权与范围

用户明确：“我同意，可以执行。执行前做最后审查现状，实施难度，评估风险。”
据此，已有 [分层拆分方案](../plans/2026-09-21-agent-runtime-separation.md)
进入实施准备，不再要求用户重复批准同一方向。
本轮先完成所要求的执行前审查；不把整体授权解释为可同时改写所有领域或运行时。

目标是保留 Todo/Consult 的领域规则，将 MCP、共享 Core、Runner 与
Agent Runtime 的职责拆清，按既有方案分批验证。
不追加自主 Agent Team、常驻服务、可写模型工作者、新 Provider、主动任务接入
或跨 Todo Milestone。CatPaw 仅作参考，不构成必须复刻的功能清单。

源码与隔离数据上的验证已在本次工作范围内；
真实数据格式迁移、安装激活、宿主配置切换、公开 GitHub 写入、
commit/push、完成与归档仍不是本轮默认动作。

已在 contribbot 登记并激活 `runtime-layer-separation`：
Todo ID 为 `t-d83b4c4c-7b73-4fc8-ac5c-5b050febd824`，
执行为 `te-e6697703-ce70-46f5-9d70-89098d6abe4a`。
当前批次已进入 Check：空包接线及根验证已有记录，但没有伪造业务检查回执、用户验收或完成结论。
OBS-003 保持原任务、原修复候选与待验收状态。

## 当前候选

| 项目 | 本轮核实 | 备注 |
| --- | --- | --- |
| Git | main，HEAD `c5a6448ca97953eb1dfbba751555cf3b00b0356c` | 相对本地 origin/main 领先 6 个提交；未 fetch/push |
| 工作区 | 7 个已跟踪文件修改、4 个既有未跟踪文档 | 其中 3 个源码/测试文件属于 OBS-003；不是本轮新写 |
| 候选指纹 | 237 个已跟踪 packages/scripts/skills 及根配置文件，包含未提交内容 | 摘要 `d045b7a13ac2b0807058e6263f7b2328ceb9f22a6d0fba8f84fe490ca1a6ca92`；不以 HEAD 替代工作区候选 |
| 新包 | `packages/core`、`packages/runner`、`packages/agent-runtime` 已创建为空边界包 | 只含边界标记与 smoke；尚未搬迁业务实现 |
| Consult 状态 | 默认个人数据根下，只读发现 1 个 Discussion、1 个 settled Turn | 不读取原始问题/回复/凭据；数据库终态不是完整进程树停止证明 |
| 项目配置 | upstream 仍是 pending | 已询问，未擅自把 CatPaw 设成追踪源；不阻塞独立重构 |

机器生成的文件指纹位于本地忽略目录
`.catpaw/discussions/phase3-claude/runtime-split-preflight-candidate-2026-09-22T01-42-54-478Z.json`。
本轮测试期间没有修改业务源码。测试结束后于北京时间 09:58 重新核对：
HEAD 未变，237 个文件无新增、缺失或内容变化，摘要仍为
`d045b7a13ac2b0807058e6263f7b2328ceb9f22a6d0fba8f84fe490ca1a6ca92`。

## 实施难度

总体判断：中高难度，按高回归风险变更处理。关键不在目录移动，而在执行与持久化
边界变化。没有证据支持“一次搬完即可”或精确到小时的工期承诺。

对 Consult 的 store、packet、contracts、projection 四个入口使用
TypeScript AST 追踪相对静态 import/export 及字面量动态 import：
得到 21 个本地文件、约 5,270 行，包括 TodoStore、workflow、workspace-occupancy、
共享锁、候选捕获、进程观察与远端写入日志。
此数量包含类型依赖，只用于解释影响面，不等于需要重写 5,270 行，
也不覆盖所有反向消费者和动态路径。

| 工作 | 难度 | 原因 | 备注 |
| --- | --- | --- | --- |
| 建包、导出、类型与构建接线 | 中 | 当前 root typecheck 只检查 MCP，src rootDir 限制跨包直接 import | 新包须真实纳入检查，不能只让旧测试保持绿 |
| 共享 Core 抽取 | 中高 | Consult 直接依赖 TodoStore、workflow、锁和占用管理 | 单一实现，不拷贝第二份 Store 或锁 |
| Runtime 与 Runner 分开 | 高 | binding 同时含发现、参数、协议和披露；runner 有 Codex 专用探针 | 不是把现有文件改一个目录名 |
| MCP 接口与恢复切换 | 高 | start 当前启动模型，status 当前做读修复与 OS 观察 | 新行为必须与恢复入口、Skill 同批交付 |
| 源码、打包与宿主接入 | 中高 | supervisor 用 import.meta.url 推断入口，setup 与 Skill 固定当前路径 | 需要实际构建产物启动和跨 cwd 验证 |
| 新 Provider、PTY、自治团队 | 不计入本轮 | 尚不是本轮交付范围 | 预留边界不等于提前实现全部能力 |

## 风险与控制

| 风险 | 实际依据与影响 | 实施控制和验证 | 备注 |
| --- | --- | --- | --- |
| 高：撤销与启动竞态 | `ConsultStore.dispatch` 在共享锁内核权、写 intent、同步调用启动函数；挪成两个远程步骤会形成撤销后仍启动窗口 | 保留同一事务边界；撤销先赢零启动，派发先赢保留在途；跨进程竞争及 async/thenable 拒绝测试 | 不声称文件写入与 OS spawn 为可回滚事务 |
| 高：复制锁导致分裂 | `todo-lock.ts` 有模块内重入表和磁盘票据；重复打包、源码/构建混用可能产生不同模块实例 | Core 只保留一份实现；验证包级 import 图、打包后模块解析、同进程重入与跨进程互斥 | 不仅检查文件名是否相同 |
| 高：恢复入口丢失 | `consultStatus` 当前会 settle 原结果；store 恢复直接调用 `observeProcess` | 查询严格只读与显式 recover 成对交付；回执落盘但索引未写、观察过期、迟到结果分别验证 | 不移除恢复，不把 MCP 的布尔报告当 OS 观察 |
| 高：共享进程代码误归层 | `processes.ts` 同时提供机器身份、工作区检查和实际 OS 查询，Todo 占用管理也使用它 | 按函数职责拆，不让 Core 反向依赖 Runtime；恢复门禁的同步观察由执行侧注入 | Core 允许领域 Git/文件操作，不能简单禁止所有 child_process |
| 高：strict 存储契约变化 | version 1 schema 固定 Provider 枚举、sandbox_probe 和两套 ProcessHandle | 先做不改数据形状的抽取；契约变化使用隔离 fixture 验证，真实迁移单独预览与确认 | 用户不要求老版本兼容，不等于可以破坏已有记录 |
| 高：后台 worker 路径失效 | runner 当前分别拼源码与 dist 的相对路径，MCP 构建入口包含 supervisor | 源码运行与打包安装布局分别启动真实测试子进程；只运行测试组合的假 Provider | 不把 import 成功或 help 成功等同于执行闭环 |
| 中：旧新入口并行 | 旧 consult_start、统一新 CLI 及旧会话可能同时存在 | 产品可执行路径只启用一条；旧名明确 unsupported，不偷偷改为另一种启动语义 | 切换前重新盘点在途，不能依赖本次快照 |
| 中：扩展性停留在接口 | Runtime 当前类型与 Consult、Claude/Codex 和 pipe 耦合 | 用测试组合中的假结构化消息/terminal 驱动验证不依赖 pipe EOF；不开放任意 adapter 路径 | 夹具通过不代表 Pi/OpenCode/PTY 已支持 |
| 中：测试范围漏接新包 | root typecheck 固定 MCP，Vitest 只收 MCP src；smoke 依赖旧 dist index | 新包进入根 typecheck/test/build；移动测试同步更新导入、mock 与打包 smoke | 不降低断言、删回归或放宽权限来换绿灯 |
| 中：未提交成果混入搬迁 | OBS-003 的 3 个文件仍有修改 | 固定当前源码指纹；分批迁移引用，不恢复旧 HEAD 覆盖成果 | 不要求先提交、不自动完成旧 Todo |
| 中：跨平台差异 | 实际 OS 进程观察有 Windows/Unix 分支 | Windows 先实测；Linux/macOS 未运行就明确保留缺口 | 一次本机通过不能宣称三平台完成 |

## 基线与待补验证

| 检查 | 本轮状态 | 备注 |
| --- | --- | --- |
| `pnpm typecheck` | 通过，exit 0 | 根命令已覆盖 MCP、core、runner、agent-runtime |
| `pnpm dev:check` | 通过，exit 0 | 用户/项目 MCP 配置与 12 个 Skill 指向源码，执行助手启动/schema 检查通过；未执行 setup，不证明当前宿主进程已加载全部最新模块 |
| `pnpm test` | 通过，exit 0 | 批次 0b 当前候选：开发工具 36、数据清理 12、Web 2、MCP 967 通过；MCP 另有 1 项 Windows 平台跳过 |
| 同步派发回归 | 通过 | native async 回调在进入锁前拒绝，回调体不执行、intent/revision 不变；隐藏 Promise 形状明确保留为可信 adapter 边界 |
| 当前 Consult 用例 | 31 项目标测试及 44 项较宽 Consult 回归通过 | 新增真实双进程重叠测试，证明同一精确 Turn 只有一个派发副作用 |
| Python Agent 测试 | 54 项通过 | 使用 `pnpm agent:test` 单独运行；根 `pnpm test` 仍不包含 Python |
| `pnpm build` | 通过，exit 0 | 根 workspace 构建覆盖现有 MCP 与三个新包 |
| 三个新包 smoke | 通过，各 1 项 | 只证明包存在、脚本和源入口接线，不证明业务迁移 |
| 真实模型产品 smoke | 本轮未运行 | 设计咨询与产品 smoke 不是一回事 |
| 实际宿主切换、Linux/macOS | 未运行 | 不自动安装或重启用户环境 |

最低进入条件：当前源码测试基线已知、OBS-003 候选不被覆盖、同步门禁与
单一 Store/锁原则不变、迁移期间旧数据不被隐式改写。
第一执行批次先锁定这些行为和依赖，再抽取 Core 的必要依赖；
新旧工具语义在新的完整执行链可用后一起切换。

## 审查结论

结论为：批次 0b 和空包接线证明已通过，可以进入共享 Core 的机械抽取前审查；
仍不能直接进行大范围目录搬迁。当前结果证明边界和根构建覆盖存在，
不证明新分层业务实现已经正确。

| 决定 | 条件 | 备注 |
| --- | --- | --- |
| 已完成 | 同步派发回归、Fake Runtime 接缝、真实双进程互斥，以及三个空 workspace 包接线 | 复用现有 Store 与锁，没有创建第二份领域状态 |
| 暂不开始 | 整体搬迁 TodoStore/workflow/锁、切换公开 Consult 工具、修改真实存储 schema | 这些动作需要先有新链路及恢复行为的可执行证明 |
| 下一步门禁 | 先确认包拓扑、Todo↔Consult 授权引用方向和 MCP/Runner 进程边界，再补齐依赖闭包与迁移顺序；抽取后重新通过根 typecheck/test/build | 旧新领取路径仍不能同时启用 |
| 单独验证 | Linux/macOS、真实 Claude/Codex smoke、Python 消费者、真实数据迁移 | 本轮没有覆盖，不能顺带宣称支持 |

第一实施单元和空包接线均已完成。下一单元才开始共享 Core 的机械抽取；
必须保持单一 Store/锁实现，并在每个可验证迁移点扩大根回归。
若为此必须改变授权、恢复因果关系、真实数据格式或 Provider 写权限，则停止并请用户决定。

## 已复现的契约缺口

`packages/mcp/src/core/consult/store.ts:284` 的 `dispatch` 接受 `start: () => T`，
再把调用包装进同步闭包传给 `withTodoLock`。
`packages/mcp/src/core/storage/todo-lock.ts:63` 能提前拒绝直接传入的 async 函数，
但无法在调用这个同步包装前识别内部的异步 `start`。
因此内部回调先开始执行，返回 Promise 后外层才拒绝；该拒绝不会撤销已排队的异步续体。

09:49 的隔离探针实际观察到：

```text
entered-callback
caller-received-rejection
continued-after-lock-rejection
```

错误为 `Todo transactions must not return a Promise or thenable.`，
同时派发意图已经保存。探针没有运行实际进程或调用模型，也没有修改真实 Consult 记录。
脚本与结果保留在本机忽略目录的 `runtime-split-dispatch-preflight.*`，
属于审查复现，不是已加入产品回归的修复证明。

当前生产 transport 传的是同步启动回调，尚未证明有实际越权启动。
但拆出可扩展执行接口前，需要把这个反例纳入同步启动契约验证。
提前拒绝 async 函数只能覆盖其中一种情况；不能声称它能防住任意同步函数自行
安排异步动作。最低限度的回归契约可以先锁定；具体修复及可信适配器边界
仍需在新的 Claude 复核中说明和取舍，不把 round-171 的失败写成同意。

## 批次 0b 实施结果

批次 0b 保持在现有 MCP 包内，没有开始目录搬迁或公开工具切换。当前候选完成：

- `ConsultStore.dispatch` 在进入 Todo 锁前拒绝原生 async 启动回调；类型签名排除
  `PromiseLike` 返回值，并用回归测试证明拒绝时回调体、派发意图和 revision 均不变化。
- 同步函数隐藏返回 Promise 的残余行为被明确记录：intent 已落盘且续体仍可运行；
  这是可信 adapter 约束，不被表述为运行时已经阻止。
- `runConsultTurn` 支持注入 Runtime/Transport 依赖用于测试；Runtime 只接收冻结的
  Binding，Runner 继续统一校验可执行文件 SHA-256。
- 所有 Runtime 返回的 scratch 路径先登记再发布 preparation；竞态失败且 Turn 已
  settled 时清理全部已登记目录。
- 新增真实两个 Node 进程的 ready/start/finish 会合测试，重叠争用同一派发锁时
  恰好只有一个副作用发生。

本批没有修改存储 schema、Provider 枚举、公开 MCP 工具、权限、PTY、daemon、
自动团队或真实用户数据。完整当前候选验证为：`pnpm typecheck`、`pnpm build`、
`pnpm agent:test` 和根 `pnpm test` 通过；MCP 为 967 passed / 1 skipped。

## Claude 复核状态

沿用既有长期会话发起 round-171，北京时间 09:46:34 开始、09:51:22 结束。
本地命令 exit 1，返回上游 HTTP 524，没有获得顾问审查意见。
原始输入、五份材料快照及失败元数据保留在
`.catpaw/discussions/phase3-claude/round-171.*`。
没有设置模型硬截止时间，没有自动重发、切换模型或创建替代会话。

这次失败没有被写成“Claude 同意”，也没有用旧轮次代替。随后沿同一长期会话完成：

- round-172：携带探针事实成功返回，支持有条件进入批次 0b，并要求真实双进程测试
  及空包接线证明后再抽共享 Core。
- round-173：对首版候选提出临时目录登记、Binding 输入、摘要校验位置、并发测试
  强度和隐藏 Promise 表述等问题；候选据此修正。
- round-174：只读复核修正候选，明确“未发现本批必须修复的问题”，仅保留低风险
  注意项。综合记录见 `.catpaw/discussions/phase3-claude/round-174.coordinator.md`。

## 回退与停点

开发阶段使用隔离数据；每批应可构建、可验证，只撤回本批自身改动，
不使用 reset/clean 覆盖既有成果。
代码回退不等于数据回退，不能用旧备份覆盖新产生的结果。

发现需要改变授权、恢复因果链、真实数据格式或 Provider 写权限时，
先讲清场景和影响，再请用户决定。只有内部文件命名、导出路径或测试组织变化，
在已批准范围内处理，不重复索要产品确认。

当前基线、批次 0b、空包接线证明和 round-175 设计审查均已结束并通过各自范围的检查。
随后已完成第一阶段 Port + Adapter 接线：Core 提供纯 Todo/Consult 契约，MCP 组合层
提供现有 TodoStore/锁适配，ConsultStore 不再直接依赖 TodoStore、workflow 或锁；
新增 Port 负向和依赖倒退测试，根 typecheck、build、test 均通过（MCP 973 passed /
1 skipped）。这仍不是整体业务源码迁移，也不改变公开工具或真实数据。

用户已确认包拓扑、Todo↔Consult 单向引用和 MCP/Runner 分进程边界，并已写入 Consult
决策记录。当前候选还缺一次独立只读代码审查：本日 Claude 审查调用长时间无返回后已停止，
不能把它计为通过。下一步先补独立审查，再依据结果决定是否进入文件迁移；不在本批做数据
迁移、setup、commit 或 push。

## 后续实际文件迁移切片附录

以上“尚未迁移”和“等待审查”是本文件前一阶段的停点，不代表本日后续状态。
在用户确认继续实施后，已完成第一个真实文件迁移切片：仅将 Consult 的纯领域
`contracts.ts`、`files.ts`、`packet.ts` 放入 `packages/core`，MCP 原路径改为兼容
重导出；Provider、进程、Turn、Discussion、Database、Store 和 Runner 仍留在 MCP。
`packages/runner` 与 `packages/agent-runtime` 仍是 wiring-only 空边界包。

本切片新增了旧 Packet 固定字节/摘要夹具、Core 文件记录安全测试、Core 反向依赖保护、
以及 MCP shim 与 Core 导出引用一致性测试。切片目标测试、`pnpm typecheck`、`pnpm build`
均通过。并行 MCP 全量为 969 passed / 1 skipped / 4 failed；单 worker 为
966 passed / 1 skipped / 8 failed，失败集合随调度方式变化，包含 Windows 长时进程、
worker/夹具清理和级联超时。并行失败的四个精确场景隔离重跑均通过，因此当前只记录为
独立的全量测试稳定性阻塞，不能记为全量绿色或已证明与迁移无关。

长期 Claude 会话本次复核结果保存在
`.catpaw/discussions/phase3-claude/round-175.stdout.json`，结论为 `accept with limits`。
由于本次没有源码工具访问，该结论是条件性只读意见，不是用户验收、Proof 或 Git 授权。
当前不迁移 Store/Runner/Projection/Composition，不改真实数据、不切换公开 MCP 入口，
先排查全量测试稳定性。
