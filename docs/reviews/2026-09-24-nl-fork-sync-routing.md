# nl 路由调查：fork 分支同步被先选为 daily-sync

日期：2026-09-24，Asia/Shanghai。
状态：已从指定任务原始记录核实；未实施修复，未重跑同步，也未制定新路由契约。
用户约定：后续使用 **nl** 指代自然语言表达。

## 用户报告与调查范围

任务名称：**同步分支**。
任务 ID：`019ed0ad-510b-7440-92a3-250ca45967ed`。
最新相关 turn：`01a0d135-7c2c-7f53-a61a-0a768232c533`。
工作目录：`D:/dev/darkingtail/antdv-next`。

用户在该任务输入“同步上游分支”，实际希望自己的 fork 分支与源仓库分支一致，
而不是进入外部 upstream 的 commit 追踪。用户本轮报告：助手先选 daily-sync，
虽然后来正确收窄了动作。本轮只核对该报告，不将引述的同步请求当作新的执行授权。

`read_thread` 返回最近相关轮的元信息，但 items 为空；因此按精确任务 ID
定位本机原始 JSONL，再读取用户消息、公开助手回复及实际命令回执。
没有引用或解释模型内部推理。最近三次实际用户输入为：

| 北京时间 | 用户输入 | 备注 |
| --- | --- | --- |
| 9 月 16 日 17:57 | 你是通过 contribbot 吗 | 回答区分本地 dist 函数调用与 MCP 协议调用 |
| 9 月 19 日 10:30 | 以当前仓库说明 monorepo、pnpm workspace | 随后中断，不是本次同步 |
| 9 月 24 日 10:18:59 | 同步上游分支 | 本次问题对应的完整执行轮 |

## 观察到的顺序

| 北京时间 | 可核实事件 | 备注 |
| --- | --- | --- |
| 10:19:13 | 助手首句选择 `contribbot:daily-sync` 的 fork+upstream 模式，计划同步 fork parent，并检查 external upstream `ant-design/ant-design` | 尚未读取本轮项目配置，初始计划范围已大于用户实际意图 |
| 10:19:24 | 读取安装的 daily-sync Skill、工作区和 Git remotes | origin 是个人 fork；名为 upstream 的 remote 是 fork 源仓库 |
| 10:20:15 | `project_status` / `repo_config` 读回 active、canonical repo、fork；external upstream 为空且 pending | 不能把助手首句中的 ant-design 当作本轮配置已确认的追踪源 |
| 10:20:30 | 助手明确“不触碰 ant-design 的 commit 追踪”，将本次解释为 Git fork parent 同步 | 可见回复把 pending 与收窄范围联系起来；不能推断所有配置下都会正确收窄 |
| 10:20:35 | `syncFork('antdv-next/antdv-next', 'main')` 返回个人 fork 同步成功，执行 exit 0 | 实际直接导入本机 dist，不是 MCP 通道调用 |
| 10:21:08 | Git 引用更新后观察到本地纯落后 81 个提交，工作区干净、可 fast-forward | 历史命令回执，不是本轮重新 fetch |
| 10:21:42 | `git merge --ff-only upstream/main` 后三方 SHA 均为 `64716b25`，差异 `0 0`，执行 exit 0 | 最终完成的是用户需要的分支同步；未出现 upstream_daily 调用 |

相关命令最后的输出为：

```text
## main...origin/main
64716b25
64716b25
64716b25
0	0
```

三行 SHA 的顺序为本地 HEAD、origin/main、upstream/main。
原任务未运行测试；本调查也没有运行任何业务测试或重新核验远端当前状态。

## 同名概念不是同一关系

| 对象 | 该任务中观察到的含义 | 备注 |
| --- | --- | --- |
| Git remote `origin` | `darkingtail/antdv-next` | 用户自己的 fork |
| Git remote `upstream` | `antdv-next/antdv-next` | fork 源仓库；这是本次分支同步的源 |
| contribbot `config.upstream` | 外部追踪源；本轮返回为空、pending | 与 Git remote 名称独立；首句提到 ant-design 不代表实际配置 |
| daily-sync 工作流 | 可同时包含 fork 同步、commit 拉取、噪音过滤和处理决策 | 范围远大于单次分支对齐，并非 external upstream 的专用工具 |

因此用户说“不是同步 upstream”，这里是指不做 contribbot 的外部追踪，
并不意味着不能使用名字叫 `upstream` 的 Git remote。
问题也不是“daily-sync 只能处理外部仓库”：它的 fork 分支同样包含 commit 追踪。

## 源码与 Skill 的可确认线索

| 文件 | 实际内容 | 备注 |
| --- | --- | --- |
| `skills/daily-sync/SKILL.md` | 标题为“每日上游同步”，按项目模式分流；fork 模式先 sync_fork，再 upstream_daily/skip_noise/triage；fork+upstream 要执行两套来源 | 没有明确将“仅同步 Git 分支”排除在完整工作流之外 |
| `packages/mcp/src/mcp/server.ts` | daily-sync Prompt 包含同步 fork、遍历所有追踪来源、过滤及处理 commits | 与本次初始扩展计划一致；不能据此证明它是模型选择的唯一原因 |
| 同上 `sync_fork` 描述 | 使用泛化的 “with upstream” | 和外部 upstream 字段并列，存在术语重叠 |
| `packages/mcp/src/core/tools/linkage/sync-fork.ts` | 读取 config.fork，调用 `gh repo sync` 并可指定 branch | 没有在该函数里执行外部 commit 追踪；本次不是它报错或把分支同步到 ant-design |

已核实安装 Skill 的 realpath 指向本 checkout 的同一文件、SHA256 相同。
没有证据将这次 nl 路由问题归因于“Skill 未更新”或“需要重启 Codex”。
dist 的构建新鲜度本轮未核实，不能把源码读取当作目标任务使用最新 dist 的证明。

## 结论与限制

用户报告成立：**最初选中了过宽的完整同步/巡检流程，随后才收窄；最终分支同步正确。**
这是一次真实 nl 入口误选范围的观察，不是一次已经发生的外部 upstream 误追踪事故。
已有术语与 Skill 范围提供了可检查线索，但未做模型对照实验，
不能宣称已穷尽根因、证明每次都误选，或断言 external upstream configured 时必然误执行。

外部 upstream 的确认状态与本次 fork 分支对齐意图是两项不同事实。
本次可见过程没有证明 nl 一开始就正确限定范围，不能仅以最终成功作为路由验收通过。
`config.upstream` 为 pending 的历史原因不在本次调查范围，不重新追问用户配置，
也不将它作为本次分支同步的必要前置。

本轮只记录观察和证据，不新增 Todo、不改变原开发批次、不改 Skill 或业务代码。
若进入修复设计，再按项目规则与 Claude 讨论；本轮未调用顾问，也不将先前讨论
冒充这项问题的设计评审。

原始记录在本机：
`C:/Users/WANGX/.codex/sessions/2026/06/16/rollout-2026-06-16T21-44-44-019ed0ad-510b-7440-92a3-250ca45967ed.jsonl`。
相关行：905、911、913、930–940、947、956、958、963。
精确相关轮的消息及命令证据摘录保存在忽略目录
`.catpaw/discussions/phase3-claude/nl-fork-sync-audit-20260924/observations.json`，
不把整份私有任务历史复制进公开文档。
