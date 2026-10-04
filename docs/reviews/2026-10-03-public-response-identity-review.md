# Schema v3 公开返回身份复核

日期：2026-10-03，Asia/Shanghai。
状态：已复现、已沿原 Claude 会话完成两轮只读讨论；用户已明确批准四处返回修补
及对应测试，**修复已实施并通过当前候选自动验证**。原范围待决已解除；下方待确认
表述保留为设计与调查阶段历史，不再作为当前阻塞。完整 schema v3 目标保留，不是完成
声明，也不改变 contribbot Todo。

## 已确认现状

| 位置 | 当前结果与实际影响 | 备注 |
| --- | --- | --- |
| `todo-workflow.ts:16` | `todo_context/resume/check` 返回的 `repo` 只剩 path，丢失平台和实例 | 3 个合成项目均实际复现；不是目录或 Todo 串写 |
| `todo-workflow.ts:33` | `todo_plan/control` 同样返回路径字符串；`todo_operation` 共用此返回点 | 前两个实际复现，operation 只有源码映射证据，未执行 |
| `todo-lifecycle.ts:127` | `todo_cancel` 返回的 `repo` 仍是路径字符串 | 合成未开工 Todo 取消成功、未归档；不代表用户真实任务被取消 |
| `project-lifecycle.ts:10-15` | `project_status` JSON 缺少 `docs/tools.md:94` 承诺的完整 `repository` | 当前 Python 调用方只读 status，没有观察到错误选仓 |

前述三处 Todo 返回值无法原样作为下一次 MCP 的仓库入参：完整三字段输入已经严格校验，
旧字符串会被拒绝。两个实例同 path 返回相同值，宿主不能从该值找回实例。
应修的是机器使用的身份字段，不是把所有人读文字或 GitHub API 参数都改成对象。

## 实际复现

20:42:07-20:42:08 执行
`.catpaw/discussions/phase3-claude/2026-10-03-todo-response-identity-probe.mjs`：
使用源码 MCP、SDK `InMemoryTransport` 和独立临时 HOME；两个 GitLab 实例均为
`team/subgroup/app`，另有一个 GitHub.com 对照。六工具乘三项目共 18 次成功调用的
返回 `repo` 均为字符串、不能通过 `repositoryRefSchema`；回灌三次 `todo_context`
均被拒绝。三个目录不同，各项目 config、只读阶段 Todo YAML、其他项目 YAML
保全，归档数量为零，fetch 调用为零，九份所列源码 `sourceDrift: []`。

20:54:31-20:54:32 执行
`.catpaw/discussions/phase3-claude/2026-10-03-project-status-identity-probe.mjs`：
两个合法 GitLab 身份仅协议不同，`http://code.example.test/gitlab` 与
`https://code.example.test/gitlab` 的目录不同；`project_status` 的 JSON
均只有标签 `repo`、`configured/status/archived_at`，没有 `repository`。
两个标签相同不是独立缺陷，因为标签从来不能用于反解身份；缺少文档约定字段才是缺口。
config 字节保全，fetch 为零，五份所列材料 `sourceDrift: []`。

两个脚本退出码 0 表示缺口按预期复现，**不是产品回归通过**。临时项目保留，
没有操作真实 `.contribbot`、用户 Todo、远端、凭据、工作区绑定或运行时安装。
两份同名 `.json` 保存具体请求结果、时间、源码摘要和限制。
探针不覆盖真实 stdio、所有调用方、真实私有平台、宿主加载或用户验收。

## Claude 与主助手

原生会话始终为 `0e4058f9-0d2b-423c-838b-eaa1bc6e13b2`。
第一轮 `2026-10-03-todo-response-identity-review` 于 20:46:27-20:48:23 返回；
补充新文档证据的第二轮 `2026-10-03-project-status-identity-review` 于
20:57:56-20:59:28 返回。两轮均退出 0，session 一致、材料无漂移。
模型工具禁用，只发送源码/契约摘录与合成结果；CLI 元数据和服务端传输仍存在，
不是保密隔离。顾问没有执行测试，不作为独立验收或用户批准。

| 顾问意见 | 主助手核实与处置 | 备注 |
| --- | --- | --- |
| 三处 Todo 返回改为 `resolved.repository` | 采纳为待确认修补建议；六工具已复现，共用点还涉及 operation | `executionContext` 自身不返回 repo，不存在第二个被覆盖的身份源 |
| 保留键名 `repo` 与响应 `schema_version: 1` | 建议采纳，不新增旧字符串分支 | 这是输出修补建议，不改变五键 config 的版本；用户尚未批准本次范围 |
| `project_status` 先查 Python 是否反解标签 | 已查 `patrol.py:170-175`，只使用 status | 不采纳“当前 Python 身份误用”的假设，不启动巡检验证 |
| 补上 `project_status.repository`，保留人读 repo 标签与文本 JSON 入口 | 文档明确已有字段承诺，第二轮建议与 Web 的身份/标签分离一致 | 使用已解析请求身份，未初始化时也可返回，不从不存在的 config 取值 |
| 不改变 Knowledge URI、Web 标签和 GitHub API owner/name | 采纳范围限制 | 它们分别有 digest、独立完整 repository 或 GitHub.com 平台守卫 |
| 旧 claim 锁摘要可能出现跨实例碰撞 | 不作为当前缺陷采纳 | 除 GitHub.com 守卫外，锁本身位于不同项目目录；相同摘要不等于同一个锁文件 |

顾问把部分范围建议称作“用户已要求”不构成事实或授权；本轮用户明确的是完整身份契约、
不兼容旧数据，以及遇到问题讨论后由用户决定。输出键名和版本的具体修补建议仍在本表中待确认。

## 建议修补范围

| 文件或验证 | 具体内容 | 备注 |
| --- | --- | --- |
| `packages/mcp/src/core/tools/core/todo-workflow.ts` | 两个结果中的 repo 使用已解析的完整对象 | 覆盖 context/resume/check/plan/operation/control；其余字段不变 |
| `packages/mcp/src/core/tools/core/todo-lifecycle.ts` | cancel 结果中的 repo 使用完整对象 | 不变更取消决定、版本保护、终态或归档规则 |
| `packages/mcp/src/core/tools/core/project-lifecycle.ts` | status 的 JSON 增加 repository，保留 repo 标签 | 不改文本 JSON 传输，不增加 schema_version，不初始化或恢复项目 |
| 定向回归 | 七工具的输出、回灌、跨实例隔离、无隐式绑定、非法或过期请求拒绝 | operation 使用已有真实本地 bound-attempt 夹具，不以共用函数代替该工具实测 |
| project_status 回归 | active、archived、未初始化；协议/端口/前缀区分及字节保全 | 非规范化 URL 仍拒绝，不默默归一化既有配置 |
| 工程验证 | 定向 RED/GREEN、类型检查、构建、当前候选全量与所需入口 smoke、独立复核 | 先收回本次范围决定；模拟测试不替代用户真实验收 |

不改 config schema、项目目录、持久化 identity、平台 API、GitHub head/base、
共享显示函数或旧数据。不补隐式绑定，不做迁移、setup、自动提交推送或 Todo 收尾。
保留标签不是旧身份格式兼容入口，程序只使用完整对象或 digest 定位。

## 测试证据新鲜度

20:58 按既有验证器相同规则重新完整枚举 packages/scripts/skills 与根依赖配置，
当前仍为 344 条路径，但候选为
`0c58cdb31b9d80372e890005888fa48fbd87a8eccb83d8ae1d03f02996397b4c`。
早晨 final-current 回执记录
`97683767294420ff07dfe6a6fc1209a899b151a160d455773949f6b0d41c0c12`，
其中 42 条路径与当前字节不同，无新增或缺失路径。该比较不是运行测试，
也未证明 42 处都对应行为变化。

同样，11:09 的身份审查所附旧快照确实包含字符串字段，17 份材料有 16 份与当前字节不同；
因此旧意见针对旧候选，不能把已实现的结构化持久字段重新当作缺口。
早晨回执的 `sourceDrift: []` 仅说明该次执行前后无漂移，不证明它覆盖较晚的提交。

当前 Git 为 `main`、HEAD `521c027`，相对本地 `origin/main` ahead 17，未 fetch。
15:44-16:06 的 1377 通过仍保留为已提交日报的执行报告；本次未找到并读回该次独立完整日志，
不能用它填补当前完整证据核对。早晨各项通过保留为历史候选结果。
21:00 核对阶段没有重跑完整测试、类型检查或构建；之后的定向结果如下，不改写前序记录。

### 21:10 定向验证

用户尚未回复修补范围，自动续行不视为批准。没有改业务代码或正式断言，
只运行原验证器的 `regression current-baseline1` 和 `typecheck current-baseline1`。
前者 20 文件、366 通过、0 失败、0 跳过；后者五包类型检查通过。
两组于 21:08:51 启动，分别于 21:09:05、21:09:12 结束，exit 0。
前后候选均为上述 `0c58cdb...`，`sourceDrift: []`，原始回执及日志保存在
讨论目录 `2026-10-03-gitlab-{regression,typecheck}-current-baseline1.*`。

这些已有用例不检查新发现的完整返回字段，不能证明四处缺口已修复；
没有全量重跑、构建、运行时激活、真实平台或用户验收。
获准修补后仍须新增相应断言，并为修补后的候选取得完整回执。

## 修复后验证

用户批准后，当前工作区实施了上述四处修补及配套回归：

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| 响应身份与工作流定向回归 | 26/26 通过 | `response-identity.test.ts` 12/12；`workflow.test.ts` 14/14 |
| MCP 全量回归 | 94 文件；1390 通过、2 跳过、0 失败 | 当前候选实际运行，`pnpm --filter contribbot-mcp test` |
| 根级类型检查 | 通过 | `pnpm typecheck` |
| Workspace 构建 | 通过 | `pnpm build` |

验证确认：完整身份可从公开响应回灌下一次 MCP 调用；跨平台/实例目录仍隔离；过期请求、
生命周期、归档规则和配置内容未被修补改变。尚未完成用户实际 MCP 会话验收、真实私有
GitLab 验证、远端写入验证或宿主重新加载新构建。

## 下一步

用户已明确批准上述四处返回修补及配套验证。当前先新增回归锁定原缺口，再修复、
验证；不重发已经结束的设计咨询，不重复请求相同批准。
21:30 的 blocked 是批准前历史状态；21:10 的已有定向及类型检查证据保留，
不冒充修复后的测试结果。
真正的目标仍是完整 schema v3 升级，不缩减成只修返回值；余下全量验证、
独立复核、运行时及真实使用验收的边界继续保留。
