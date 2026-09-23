# OBS-003 跨项目 Todo 读取隔离

状态：已实施并完成本轮验证；未提交或推送，Todo 仍待用户决定收尾。
Todo：`darkingtail/contribbot` / `OBS-003` /
`t-c8bb3fbc-1d19-4e0b-a41d-8f2ef98fb44e`。

## 目标与边界

一个被跟踪项目的无效 Todo 数据，不应阻塞另一个健康项目的 init。
本次计划覆盖整个 OBS-003：`completion_scope=task`，`remaining_scope=[]`。
交付为工作区内修复、回归测试与记录，不包含 commit、push、安装或运行时切换。
用户已确认实施；此前的 CatPaw 长会话意见与本轮 contribbot Consult V1 意见已区分记录。
不恢复旧 Todo 状态兼容，不迁移、删除或修复真实个人数据。

## 调查事实

2026-09-21 的 `project_init` 和 `todo_list` 显示本项目没有 Todo；
只读检查对应数据目录仅有 `config.yaml`，没有归档索引，故通过 `todo_add`
建立上述跟踪项。未建立重复项，未激活实施。

源码候选：`c5a6448ca97953eb1dfbba751555cf3b00b0356c`。
`project-init.ts:42` 调用全局 `projectList()`；
`project-list.ts:65` 对每个纳入汇总的项目调用 `TodoStore.list()`，无错误隔离。
存储层拒绝旧状态本身符合约定，异常传播到无关项目才是本缺陷。

隔离探针通过 stdin 运行 Node + 当前仓库 tsx，不创建或修改测试源码。
子进程设置 `HOME` 与 `USERPROFILE` 并断言 `homedir()` 为临时目录：
`C:/Users/WANGX/AppData/Local/Temp/contribbot-obs003-investigation-LOqA3Z`。
两个项目均预置本地配置，没有 GitHub 调用。

| 观察 | 结果 | 备注 |
| --- | --- | --- |
| 加入无效邻居 Todo 前 | 健康项目 init 成功 | 使用空 Todo 夹具 |
| 加入 `pr_submitted` Todo 后 | 健康项目 init 与全局列表均抛错 | `Unsupported Todo status`；成功复现缺陷，不是修复通过 |
| 健康项目直接读取 Todo | 成功 | 证明当前项目数据不是失败来源 |
| 两份 Todo 夹具字节对比 | 未变化 | 无迁移或自动纠正 |
| 业务回归 | 本轮未运行 | 不把日报中此前全绿结果冒充本修复验证 |

## 已实施方案

1. 只在 `project-list.ts` 的单项目 Todo 读取处隔离异常。保留失败项目行、
   已知项目状态、上游统计、最后活动时间和其他健康项目数据。
   Todo 计数明确显示 `unknown / unknown`，不能显示零或复用上游的 `—`；
   保留 active/archived 备注并追加固定诊断：
   `Todo data unreadable (todos.yaml); use todo_list for this project to inspect the error.`
   该入口仍会严格报错，其错误用于定位，不承诺返回正常列表。
   不嵌入原始 YAML 异常内容，不删除失败行或减少项目总数，不从 Todo 推断项目状态。
2. 保持存储校验与当前项目 init 恢复严格报错，不捕获整个 init 来伪造成功。
   不扩展到 config、upstream 或目录枚举失败的通用容错。
3. 已先加失败回归再实施最小修复。覆盖无效状态与损坏 YAML 的邻居、
   健康项目恢复信息、失败项目未知计数、健康零计数、当前项目仍拒绝无效数据、
   归档筛选、归档说明与诊断共存及夹具字节不变。
   使用现有测试的独立临时 HOME/USERPROFILE。
4. 已运行项目列表、init、项目生命周期和相关 Todo 存储回归、类型检查，并按影响面
   扩展 MCP 回归。测试夹具全部在临时目录，不能使用真实 `~/.contribbot`。

实现细节：`project-list.ts` 只对 `todoStore.list()` 建立局部错误边界；读取失败时保留
项目行，Todo 计数使用显式 `unknown / unknown` 格式化，Note 同时保留 active/archived
说明和固定诊断。没有修改 `TodoStore`、`projectInit` 或 config/upstream 读取路径。

## 验证结果

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| RED | 通过建立失败基线 | 新增 4 个场景先按预期复现现状失败；未先改生产代码 |
| focused regression | 通过 | 2 个测试文件，26/26；临时 HOME/USERPROFILE |
| MCP 全量测试 | 通过 | 69 文件，962 通过、1 跳过；跳过项为平台相关 |
| TypeScript | 通过 | `pnpm --filter contribbot-mcp typecheck` |
| Build | 通过 | `pnpm --filter contribbot-mcp build` |
| 无写入 | 通过 | 失败 Todo 项目目录文件清单和内容保持不变；未使用真实 `~/.contribbot` |
| Git 交付 | 未执行 | 工作区保留未提交改动；未 commit、push、安装或切换运行时 |

当前候选是工作区内容，不是 commit；验证结果不等于用户最终验收或 Todo 完成。

## 咨询与下一步

此前的 CatPaw Claude 长会话 `round-168` 不是 contribbot Consult V1，已作为测试发现单独标注。
随后使用 contribbot Consult V1 派发一轮 Claude one-shot：
`discussion-b3ded6b744a53020f2e7501b61fd5851` /
`turn-b3ded6b744a53020f2e7501b61fd5851`，状态 settled/returned，完整性 ok。
Consult V1 建议已用于补强失败行保留、unknown 计数、严格性和无写入回归；顾问意见
不作为验收、Proof 或实施授权。

### Claude 意见

支持汇总层隔离、固定诊断和存储层严格校验。提醒捕获范围包括 TodoStore 构造、
诊断与归档备注合并、未知计数不得混同零或不适用；必须核实当前目标的
`listForDisplay()` 确实严格。config/upstream 失败仍可能影响全局列表，应明确残留范围。

### 主助手综合与核实

采纳上述隔离、文案及测试建议，具体实现已反映在前节。未采纳错误类型字符串分类：
当前存储层没有稳定的错误类型，强行按字符串分类会制造脆弱契约；本次只包住严格
`list()` 读取调用，不包构造器、配置或 upstream 读取。

Claude 关于构造期校验的说法是条件性风险，不是现有缺陷：
源码 `todo-store.ts:286` 构造器只设置路径；
`listForDisplay -> displayEntries -> list` 保持严格。
另以原隔离夹具实际调用 `listForDisplay()`，确认抛 `Unsupported Todo status`，
未写夹具。因此本次不需要修改 `renderTodoRecovery`。
实施后仍须用回归确认当前目标的完整 init 拒绝路径，不能用此局部探针替代。

### 当前剩余范围

`config.yaml`、`upstream.yaml`、目录枚举和 `statSync` 失败仍可能阻断全局汇总，
本次没有扩大处理；如需隔离应另开观察项或 Todo。当前没有 commit/push，Todo 尚未
完成或归档，等待用户验收和明确收尾决定。
