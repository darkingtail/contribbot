# 旧 d3fa 工作区与 Knowledge stash 并入评估

## 结论与范围

本轮只做静态审查，未合并、恢复 stash、提交、推送、清理旧工作区或运行测试。
当前本地 `main` 为 `21263da`，工作区在审查开始时干净，领先本地记录的
`origin/main` 21 个提交；旧 `d3fa` 工作区位于 `f25650f`。远端未 fetch，
这里的判断仅针对这两个本地候选和 `stash@{0}`。

旧工作区的 Git 状态包含很多仅换行形式不同的路径；排除行尾差异后，
实质改动为 **28 个已跟踪路径**，另外有 **12 个未跟踪路径**。
未跟踪路径与 `main` 逐文件比较 SHA-256，6 个相同、6 个不同。
`stash@{0}` 涉及 **10 个路径**。下面逐项列出全部 50 个路径快照；
同一路径出现在旧工作区和 stash 时分别审查，不将它们算作独立新功能。

**本次需要直接合并到 `main` 的旧文件：0。** 已有功能使用新版实现，
其余旧方案依赖 `owner/repo`、旧配置结构、fork 自动归属或旧工具边界，
不能以恢复工作区或 `stash pop` 的方式搬入。`docs/design.md` 的一段
知识审核原则可在以后按现有 v3 契约补写，是可选文档整理，不是恢复
旧 stash 或本轮业务代码的前置条件。

“已吸收”指审查到当前源码中有相应能力或更完整的实现，**不是**指
文件字节相同、旧测试在当前候选重新执行，或所有运行时场景已验收。
“不原样合入”不等于永远不需要该需求；若以后立项，须以当前契约重新设计。

## 已跟踪的实质改动（28）

| 路径 | 判断 | 备注 |
| --- | --- | --- |
| `CONTRIBUTING.md` | 已吸收 | `main` 已有依赖安装及开发 setup/check/remove 指南。 |
| `docs/development/local-dev-runtime.md` | 已吸收 | `main` 仍有安装、备份、移除与数据重置说明，并补充当前 Todo/Runner/MCP 源码探测；旧验收日期不能当今天结果。 |
| `docs/tools.md` | 不原样合入 | 旧表格按 59/62 个工具和 `owner/repo` 记载；`main` 已按 v3 身份、项目生命周期与 Knowledge 演进更新。 |
| `package.json` | 已吸收 | 安装、开发检查、数据重置与测试脚本在 `main`，并有包边界检查及当前测试顺序。 |
| `packages/agent/src/contribbot_agent/cli.py` | 不原样合入 | 旧 `--upstream owner/repo` 已由当前 tracking 三字段输入语义取代；旧命令不能直接恢复。 |
| `packages/agent/src/contribbot_agent/init_context.py` | 不原样合入 | 旧实现从展示文本读取 canonical `owner/repo` 与 upstream HTML 标记；当前用结构化身份与 tracking 状态。 |
| `packages/agent/src/contribbot_agent/models.py` | 已吸收 | 巡检批次的 skipped 结果已在 `main`，并使用当前仓库身份。 |
| `packages/agent/src/contribbot_agent/orchestrator.py` | 已吸收 | 归档项目跳过和批次报告已有新版实现；不能恢复旧字符串项目键。 |
| `packages/agent/src/contribbot_agent/patrol.py` | 已吸收 | `main` 已在新巡检及恢复前读取 `project_status`，旧实现使用 `owner/repo` 参数。 |
| `packages/agent/tests/test_init_context.py` | 已吸收 | 当前有 tracking 状态、显式选择与不猜展示文字的回归；旧 upstream 标记断言不适用。 |
| `packages/agent/tests/test_orchestrator.py` | 已吸收 | 归档跳过与发现活跃项目的测试已有新版身份语义。 |
| `packages/agent/tests/test_patrol.py` | 已吸收 | 当前测试涵盖归档/未知状态阻断及巡检前置调用。 |
| `packages/mcp/src/core/enums.ts` | 已吸收 | 项目生命周期枚举已有；旧文件同时含过时的 Todo 状态，不可覆盖当前六态。 |
| `packages/mcp/src/core/storage/repo-config.ts` | 不原样合入 | 旧 `role/org/fork/upstream` 与 `upstream_confirmed` 已换为五键 v3 的 `parent/tracking/lifecycle`。 |
| `packages/mcp/src/core/tools/core/project-init.ts` | 不原样合入 | 当前初始化使用完整身份且不把 fork 自动搬到 parent；旧提示中的字符串仓库和 upstream 参数会倒退。 |
| `packages/mcp/src/core/tools/core/project-list.ts` | 已吸收 | 当前提供活跃/归档/全部筛选；数据目录与身份为 v3 digest。 |
| `packages/mcp/src/core/tools/core/repo-config-tool.ts` | 不原样合入 | 当前 tracking 明确选择已结构化；旧代码会引入 fork→parent 重定向及字符串来源。 |
| `packages/mcp/src/index.ts` | 已吸收 | 生命周期入口现已导出，类型是完整仓库对象。 |
| `packages/mcp/src/mcp/server.test.ts` | 已吸收 | 生命周期注册与 tracking 待确认测试已有，当前另要求完整仓库对象。 |
| `packages/mcp/src/mcp/server.ts` | 不原样合入 | 当前 MCP 参数明确是 `{platform, instance, path}`；旧注册接受 `owner/repo` 和旧 upstream 语义。 |
| `packages/web/package.json` | 已吸收 | Web 的测试入口在 `main`。 |
| `packages/web/public/app.js` | 已吸收 | Web 的活跃/归档筛选和状态显示已有新版投影。 |
| `packages/web/server.mjs` | 已吸收 | 筛选和 HTTP 错误处理已有；旧目录枚举读取不能覆盖 v3 digest 项目加载。 |
| `pnpm-lock.yaml` | 不原样合入 | 锁文件应随当前 `package.json` 与 workspace 保留，旧依赖快照不可覆盖。 |
| `skills/daily-sync/SKILL.md` | 已吸收 | 当前先读项目状态、阻断归档项目，并传完整身份。 |
| `skills/dashboard/SKILL.md` | 已吸收 | 项目筛选及显式归档/恢复流程已有；旧 `owner/repo` 示例不可覆盖。 |
| `skills/init/SKILL.md` | 已吸收 | pending/none/configured 与明确选择流程已有，当前使用 tracking 而非 upstream 字符串。 |
| `skills/project-onboard/SKILL.md` | 已吸收 | 当前区分 parent 事实和 tracking 意图，并按完整身份接入。 |

## 未跟踪路径（12）

| 路径 | 判断 | 备注 |
| --- | --- | --- |
| `docs/development/init-upstream-confirmation.md` | 仅供参考 | 与 `main` 字节不同，说明旧 HTML 标记与 `--upstream`；当前已使用 tracking 结构化协议，不宜复制。 |
| `docs/development/phase3-collaboration.md` | 已吸收 | 与 `main` 字节相同。 |
| `docs/development/project-archive.md` | 已吸收 | 与 `main` 字节相同。 |
| `docs/development/worktree-workflow.md` | 已吸收 | 与 `main` 字节相同。 |
| `packages/mcp/src/core/tools/core/project-init.test.ts` | 已吸收 | 字节不同，但当前测试另覆盖 fork 不改归属、归档保留及 tracking 待确认；旧 fixture 不能直接用。 |
| `packages/mcp/src/core/tools/core/project-lifecycle.test.ts` | 已吸收 | 字节不同，当前测试覆盖状态往返、隔离与未配置读取，使用 v3 生命周期字段。 |
| `packages/mcp/src/core/tools/core/project-lifecycle.ts` | 已吸收 | 字节不同，当前实现在 `lifecycle` 下读写并返回完整身份；旧状态缺配置时默认 active 不宜回退。 |
| `packages/web/server.test.mjs` | 已吸收 | 字节不同，当前 HTTP/API 用例覆盖归档筛选和历史保留；仍不等于浏览器交互验收。 |
| `scripts/data-reset.mjs` | 已吸收 | 与 `main` 字节相同。 |
| `scripts/data-reset.test.mjs` | 已吸收 | 与 `main` 字节相同。 |
| `scripts/dev-setup.mjs` | 已吸收 | 字节不同，当前脚本沿用安装/恢复能力，另探测 Todo 执行助手、Runner 与 MCP 源码入口；不可用旧 tsx 启动路径替换。 |
| `scripts/dev-setup.test.mjs` | 已吸收 | 字节不同，当前保留旧的安装/移除安全用例，并增补当前启动路径及源码检查。 |

## `stash@{0}` Knowledge 路径（10）

| 路径 | 判断 | 备注 |
| --- | --- | --- |
| `docs/design.md` | 可选后续整理 | 旧 stash 增加一段“提案需审阅才应用”的原则；现行 `docs/tools.md` 已详述。若补设计总览，应以 v3 知识位置和现行五工具为准，不能粘贴旧 `owner/repo` 说明。 |
| `docs/superpowers/plans/2026-06-07-phase3-evolving-knowledge-implementation.md` | 仅供历史参考 | 旧计划只有 propose/apply 两工具、未完成勾选，和当前代码、测试及存储契约不匹配。 |
| `docs/tools.md` | 不原样合入 | stash 文档还写 `knowledge://{repo}/{name}` 和 `owner/repo` 路径；当前是 `knowledge://project/{digest}/{name}`。 |
| `packages/mcp/src/core/storage/knowledge-proposal-store.test.ts` | 已吸收 | 当前覆盖持久化、状态、回滚快照、patrol 去重和符号链接检查。 |
| `packages/mcp/src/core/storage/knowledge-proposal-store.ts` | 不原样合入 | 旧提案 `repo: string`、宽松 YAML 加载与无回滚状态；当前完整仓库对象、schema 校验、驳回/回滚和来源计数更完整。 |
| `packages/mcp/src/core/tools/core/knowledge-evolution.test.ts` | 已吸收 | 当前覆盖 propose/apply/create/append/revise 及回滚、隔离等更多行为。 |
| `packages/mcp/src/core/tools/core/knowledge-evolution.ts` | 不原样合入 | 旧只提供 propose/apply，且沿用旧数据目录与字符串仓库；当前还提供列表、驳回、回滚与 provenance。 |
| `packages/mcp/src/index.ts` | 已吸收 | 当前已导出 Knowledge 演进入口，旧类型签名不适用。 |
| `packages/mcp/src/mcp/server.test.ts` | 已吸收 | 当前 schema 用例已有 Knowledge 工具及完整仓库对象断言。 |
| `packages/mcp/src/mcp/server.ts` | 不原样合入 | 旧只注册两个工具，且为字符串 repo；当前注册完整提案流和 v3 资源。 |

## 后续与限制

本批没有必须搬入的业务代码或测试。若要维护 `docs/design.md` 的知识原则，
单独按当前实现补一小段即可。Python Agent CLI 对自托管实例输入、真实私有
GitLab、浏览器交互验收等仍可作为**新任务**评估；旧文件不能替代当前契约设计
或新验证。不要为了“合并所有改动”恢复旧 stash 或快进旧脏工作区。

本次依据为 `git status`、排除行尾差异的旧工作区 diff、未跟踪文件 SHA-256、
stash diff 及当前源码/测试静态对照。未对本地 `main` 重跑任何业务测试，
没有据此宣称旧候选或当前候选新通过。旧工作区和 stash 原样保留，后续清理
须另行确定范围与数据保留方式。
