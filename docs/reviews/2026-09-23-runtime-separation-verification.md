# Runtime 拆分验证

日期：2026-09-23，Asia/Shanghai。

状态：本批拆分、固定候选全量回归、稳定性复测和 Claude 静态代码审查已完成。
本文不表示用户验收通过，不完成或归档 Todo。
批准范围见 [拆分方案](../plans/2026-09-21-agent-runtime-separation.md)。

## 实际结果

```text
主助手 + Skills
  +-- MCP 工具 -----> Core（Todo / Consult 分目录）
  +-- Runner ------> Core（同一记录、规则和锁）
        +----------> Agent Runtime（Provider / 协议 / pipe）

Platform：共享本机进程能力；Core 只引用其结构类型。
```

| 范围 | 已实现内容 | 备注 |
| --- | --- | --- |
| Core | Consult Store、授权、Packet、回执、恢复规则；Todo normalizer、workflow、只读投影、共享锁 | 原路径只重导出，不复制维护第二套规则 |
| MCP | prepare/request/status/read/control/decide；旧 start 明确返回替代流程 | 不启动、探测顾问，不因查询执行 OS 观察或恢复 |
| Runner | 精确 Turn 的领取、锁内派发、结果回写；inspect/start/recover/observe/reconcile CLI | 不扫描队列，不新增顾问，不自动重试 |
| Runtime | Claude/Codex 绑定、能力探针、参数、环境、临时目录、pipe、输出限额与脱敏 | 不依赖 Todo、Consult 或 Core |
| Platform | 共享进程身份与观察实现 | MCP 的既有 Todo 本地执行能力不需要反向引用 Agent Runtime |
| 开发入口 | MCP 同进程源码 bootstrap、Todo/Consult Skill launcher、源码 worker 解析 | 不回退旧 dist；setup/check/remove 在隔离 HOME 测试 |

“纯 MCP”不等于禁止既有 GitHub 或 Git 工具。这里只保证 MCP 不承担 Agent 执行和
编排。Todo 写入 Store、Issue/PR、上游追踪、既有执行 CLI 的剩余迁移，以及 Python
Analyzer 接入统一 Runtime，仍是后续批次；不能把本轮宣称为整个仓库完全薄化。

## 行为保持

| 关键约束 | 覆盖方式 | 备注 |
| --- | --- | --- |
| Todo 六态与原校验 | 原 normalizer/workflow 迁移、旧投影对照、固定计划摘要向量和领域回归 | 简化 reader 曾出现10项对照失败，已修正，不隐藏历史 |
| 共享锁和新鲜授权 | 真实双进程派发竞争、MCP/Runner 持锁竞争与取消后拒绝领取 | 不用内存 mock 代替跨包竞争 |
| 不重复调用 | 原 request/turn 重放、结果不可变、迟到与占用检查 | 不把缺少结果解释为从未启动 |
| 原回执与恢复 | blocked/cancelled/truncated/unresolved 内容及摘要；显式 recover | status/read 不隐式写修复 |
| 停止与恢复 | 真实进程观察、两阶段报告时序、过期版本与覆盖拒绝 | 不保证后代树或远端活动停止 |
| 只读边界 | 缺能力拒绝、工具参数、环境过滤、输出截断与脱敏 | 不是账号级读取隔离，不保证发现所有秘密 |
| 源码和构建入口 | 外部目录、损坏 tsconfig、原 PID/stdin/argv、Skill worker 和 stdio | 未修改用户真实 MCP 配置 |

## 固定候选

源码、测试、Skill与构建配置共310个文件，包含新增及删除标记：

```text
ca3648cdf8b9bf6c51631cf0b797dd08b71a1c597306579f12cb99d1b2990965
```

工作区在 `main`，基于 HEAD `c5a6448ca97953eb1dfbba751555cf3b00b0356c`，包含未提交
修改；上面的源码指纹才是实际验证对象，不是仅验证该 HEAD。
本机原始结果在 `.catpaw/discussions/phase3-claude/split-final-1.json`，每项保存命令、
时间、PID、退出码和日志摘要，每项前后核对候选指纹。文档和忽略的本地日志不包含在
该源码指纹中。此前被中断的 `split-full-test-1.log` 没有成功终态，不算全量通过。
最终回执摘要为
`2d4da03b30d08699a576b4da936269bd157c8a2f21118007612072feb7fc65d3`。

| 验证入口 | 当前结果 | 备注 |
| --- | --- | --- |
| `pnpm typecheck` | 通过 | 当前固定候选 |
| `pnpm build` | 通过 | 所有 workspace 构建 |
| 第1轮 `pnpm test` | 1095 passed / 1 skipped | 18:44至19:02；MCP 981通过，其余包及根开发工具114通过 |
| `pnpm agent:test` | 54 passed | 当前候选于19:02重新执行 |
| `pnpm test:dev-exec-smoke` | 28场景通过 | 隔离 HOME、源码 Skill 与真实 stdio；无真实用户验收或 GitHub 写入 |
| `pnpm test:execution-smoke` | 28场景通过 | 构建后执行 CLI 与真实 stdio，与源码场景一致 |
| 第2轮 `pnpm test` | 1095 passed / 1 skipped | 19:12至19:30；与第1轮候选和结果一致 |
| 最终证据核对 | 通过 | 7项命令均exit 0，日志摘要、候选及审查文件均无漂移；`git diff --check`通过 |

每轮根测试明细：边界9、开发工具44、数据清理12、Web2、Platform2、Runtime17、
Core12、MCP981、Runner 8 Node smoke + 8 Vitest。MCP的1项跳过是既有Windows条件；
日志的单文件行和总计行提及的是同一项，不能重复计数。没有新增跳过或禁用断言。
两次成功证明本机固定候选的可重复结果，不保证所有环境永不出现不稳定。

## 独立审查

Claude 在既有长期会话 round-186 阅读29份实际源码快照，指出 Provider preparation
仍留在 Runner 的职责缺口，已迁入 Runtime。新增精确回执、跨包锁和真实 Skill worker
解析验证。关于 source hook 解析失效的猜测没有复现，因此未按猜测修改生产解析器。

round-187 只读复核迁移后的29份代码快照，未发现必须修复的缺陷。round-188
补充审查4份此前未提供的文件，确认 Runtime 只重导出 Platform 进程实现、
旧 setup 参数移除测试已存在，且 Runner 的公开装配入口没有违反分层。
Claude 最终结论为静态审查通过，没有未解决的拆分阻塞。主助手核对并采纳该结论；
可选强化建议不扩大本轮范围。
round-186至188去重后共44个审查文件的最新摘要与最终候选一致。

审查禁用模型工具，输入为明确选择的源码快照；不把静态审查当作执行测试、
产品真实模型 smoke 或用户验收，也不授予运行时切换权限。

## 限制与下一步

本机验证环境为 Windows、Node 22.22.0。Linux/macOS 未运行；Unix executable bit
用例在 Windows 按既有条件跳过，不应标作所有平台通过。没有真实顾问产品调用、
其他宿主试用、PTY、Pi/OpenCode 实现或 Python 新消费者联调。

本批无未解决的工程检查失败，下一步是选择隔离的真实 Todo/Consult 试用。
本轮没有实际 setup、运行时激活、真实顾问产品调用、数据迁移或提交推送。
上述动作不因自动化测试全绿而获得授权。Todo 保持 active，完成与归档仍分别需要
用户决定；Python及其他领域的后续迁移不计入本批已完成范围。
