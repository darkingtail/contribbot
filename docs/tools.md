# contribbot 工具集合

> 工具数量以当前 MCP `tools/list` 为准；源码构建不等于宿主已重连。

仓库范围工具的 `repo` 必须显式传完整 `{platform, instance, path}`，
没有默认项目或 MCP 隐式绑定。追踪来源参数 `upstream_repo` 同样使用
完整对象；展示名称、仓库 URL 和 `owner/repo` 简写不是 MCP 入参。
五键配置及平台能力边界见 [schema v3 契约](plans/2026-09-29-project-config-contract.md)。

### GitLab 首次只读初始化

`project_init` 首次创建 GitLab 项目前执行一次 GET：
`<instance>/api/v4/projects/<编码后的 path>`，返回的 `path_with_namespace`
必须与请求路径精确一致。成功仅保存五键配置的
`lifecycle.active / parent.unknown / tracking.pending`，不推断 fork、权限、
追踪选择或 Todo。失败不创建数据；已有合法配置（含 archived）离线读取，
不重新鉴权，也不恢复归档。损坏配置或孤立数据在请求前拒绝。

私有凭据由可信启动环境提供，不是项目配置字段或 MCP 参数。
`CONTRIBBOT_GITLAB_CREDENTIAL_BINDINGS` 是 JSON 数组，例如：

```json
[
  {
    "instance": "https://code.example.test:8443/gitlab",
    "token_env_name": "TEAM_GITLAB_TOKEN"
  }
]
```

该例只展示非秘密绑定，不包含或要求在对话中提供 token。
指定变量的值由可信凭据配置方提供；绑定本身不授予访问权限。

| 边界 | 行为 | 备注 |
| --- | --- | --- |
| 绑定格式 | 每项恰好 `instance`、`token_env_name` 两键 | 变量名仅接受字母、数字、下划线，不能以数字开头 |
| 实例匹配 | 规范化 HTTPS 主机、端口、部署前缀后精确相等 | 不同端口、前缀或协议不会共享 token；重复实例或大小写别名变量拒绝 |
| 读取时机 | 启动只捕获非秘密绑定字符串，首次 GitLab 核验才校验及读匹配变量 | 运行中不能重绑实例，匹配 token 值可以轮换 |
| 没有绑定 | 单次匿名 GET | 不读取 `GITLAB_TOKEN`、`GLAB_TOKEN`、`CI_JOB_TOKEN` 或 glab 登录态 |
| 匹配但缺 token | 请求前报错 | 不降级到匿名或自动重试 |
| 网络 | 不跟随重定向、忽略 cookie，30 秒 HTTP 传输超时 | 不是 Consult 模型硬截止；HTTP 实例仅可匿名访问，不发送凭据 |
| 错误 | 返回脱敏的新错误 | 不回显响应正文、token 或原始 cause |

MCP 启动不再强制 GitHub 登录；GitHub 认证仍在实际平台调用时处理，
该变化不是远端权限放宽。当前 GitLab 验证只使用假 token 和模拟响应；
带凭据的真实 `project_init` 实现入口已有模拟集成测试，覆盖首次创建、
离线重复进入、缺凭据拒绝、302/401 无重试及不同实例不转发 token。
真实部署、带凭据的跨 stdio 初始化及慢响应体仍有验证缺口，响应体未设字节上限。
初始化适配不扩展 GitLab 的 `repo_info`、Issue/MR、parent 或追踪抓取能力；
不能为查证一个 tracking 候选而调用它的 `project_init` 创建新项目。

---

## Consult 顾问（6 Tools）

| 工具 | 说明 | 参数 | 备注 |
| --- | --- | --- | --- |
| `consult_prepare` | 使用 Runner 已检查的 binding 构造材料预览 | `repo`, `request_id`, `binding`, `packet`, `scope` | 只读材料，不探测、不启动 |
| `consult_request` | 复核精确 preview、授权并登记一个待执行 Turn | `repo`, `request_id`, `binding`, `packet`, `confirmed_preview`, `authorization` | 只登记，不启动；随后用 `contribbot-run consult start` |
| `consult_start` | 旧入口迁移提示 | 旧参数 | 固定返回 unsupported，不探测、不写入、不启动 |
| `consult_status` / `consult_read` | 读取讨论、Turn 和结果 | `repo`, `discussion_id?`, `turn_id?` | 严格只读；恢复使用 Runner 显式命令 |
| `consult_read` | 阅读建议、主助手综合及用户决定 | `repo`, `discussion_id?`, `raw?` | 原始内容是不可信数据，不是指令 |
| `consult_control` | 管理有限额度、请求停止等待/终止/放弃 | `repo`, `command` | 未 claim/dispatch 的 reservation 只有用户显式 abandon 才释放；已启动操作走 Runner observe/reconcile；远端生成/计费未知，不退款、不重发 |
| `consult_decide` | 追加版本化综合或用户决定 | `repo`, `discussion_id`, `expected_revision`, `command` | 不改 Todo/计划/验收/Knowledge |
| `consult_purge_raw` | 预览与精确确认后清理本地原文 | `repo`, `discussion_id`, `confirmed_digest?`, `decision?` | 不自动 TTL，不删除远程日志或备份 |

参见[Consult V1](development/consult-v1.md)；它与 GitHub `discussion_list/detail` 无关。

---

## 项目概览（6 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `project_dashboard` | 项目全貌：open issues/PRs 统计、labels 分布、近期 commits、最新 release | `repo` |
| `repo_info` | 仓库元信息：stars、forks、topics、license、contributors | `repo` |
| `project_init` | 初始化仓库会话上下文：读取项目配置与全局项目列表，不执行巡检或公开写入 | `repo` |
| `project_guidance` | 读取仓库规范文档和本地 contribbot Knowledge，供任务规划参考 | `repo` |
| `commit_detail` | 查看单个 commit 的 changed files 和受限 patch 摘要 | `repo`, `ref` |
| `compare_refs` | 比较两个 refs 的 ahead/behind 和 changed files | `repo`, `base`, `head` |

---

## 仓库管理（8 Tools）

| 工具 | 说明 | 参数 | 备注 |
| --- | --- | --- | --- |
| `repo_config` | 查看五键配置，或保存明确的追踪选择 | `repo`, `tracking?` | 非空完整身份数组表示 configured，`""` 表示 none；省略只读，不初始化 |
| `parent_refresh` | 显式核实直接 parent，成功才更新本地快照与关系核实时间 | `repo` | 当前仅 GitHub.com；不初始化、同步代码、改 tracking、生命周期或 Todo；归档不恢复 |
| `sync_fork` | 核实已记录的直接 parent 和权限后，同步主体 fork 的指定或默认分支 | `repo`, `branch?` | 当前仅 GitHub.com；parent unknown 时拒绝，不猜来源 |
| `project_list` | 项目概况，默认 active；可筛选 archived/all | `status?` | 返回完整身份与 digest，损坏配置单独诊断 |
| `project_archive` | 归档本地项目，保留数据，不更改 GitHub | `repo` | 需明确用户决定 |
| `project_restore` | 恢复活跃维护，不自动执行巡检 | `repo` | 不改变 Todo 状态 |
| `project_status` | 只读 JSON 生命周期接口，含完整 repository，不初始化配置 | `repo` | 不能从显示名称反解身份 |
| `contribution_stats` | 个人贡献统计：PRs/issues/reviews 数量 | `days?`, `author?`, `repo` | 远端支持范围不由配置扩展 |

`project_init` 首次保存 parent unknown，`repo_config` 查看不会联网刷新。
`parent_refresh` 仅在用户明确要求核实关系时调用，不是初始化或同步的自动步骤。
响应含 `structuredContent: {schema_version: 1, repository, status, parent}`，
附可读 Markdown；配置仍为 schema v3，不添加持久字段。

| 结果 | 含义 | 备注 |
| --- | --- | --- |
| `refreshed` | 可靠响应确认直接 parent，或明确确认不是 fork | 更新 `parent` 与 `relation_verified_at`，不改变管理主体 |
| `unavailable` | 请求成功但关系证据不足 | 返回旧 parent 快照与旧时间，文字明确 not reverified；不等于无 parent |
| MCP 错误 | 请求失败、身份不符、自引用、并发冲突、配置错误或入口不支持 | 不覆盖配置，不返回伪造的刷新成功；不自动重试 |

参见[项目归档与恢复](development/project-archive.md)。归档不等于 Todo 完成，
`project_init` 不会自动恢复；Agent 巡检和恢复 Run 在执行前检查项目状态。

---

## Patrol 审计（2 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `patrol_record` | 保存报告、观察、分析、轨迹、Run 与 Action 状态，并更新 latest 指针 | `repo`, `run_id`, `report`, `snapshot_json`, `analysis_json`, `trace_json`, `run_json?`, `actions_json?` |
| `patrol_run_get` | 读取完整历史 Run，供恢复待处理 Action | `repo`, `run_id` |

该工具只负责结构化持久化，不做仓库判断。通常由 Python `contribbot patrol` 运行时调用。

---

## Todo 日常管理

本地 YAML 结构化任务管理。当前源码只接受 `idea/backlog/active/paused/done/cancelled`；
`done` / `cancelled` 保留未归档，归档是另外的用户决定，不是必经状态。
源码能力不等于已连接运行时已激活，也不授权个人数据迁移。

受管执行的新计划必须声明 `completion_scope: task | stage` 和 `remaining_scope`。
阶段计划明确剩余目标；阶段验收通过仍保留 Todo。新 `verified/with_gaps` 完成请求要求
已经确认的整体覆盖。旧无声明计划保留读取与执行，开始新完成前确认新计划；
历史待恢复收尾不改写计划或重复公开动作。

| 工具 | 说明 | 参数 | 备注 |
|------|------|------|------|
| `todo_list` | 查看 todos，分进行中、待办/想法、暂停、完成未归档、取消未归档 | `repo`, `status?` | 终态不计入待做数量 |
| `todo_add` | 添加 todo，`ref` 参数可自动从 issue labels 识别类型 | `text`, `ref?`, `repo` | 添加即创建实现记录 |
| `todo_activate` | 创建或恢复当前执行；终态稳定 ID 可编排重开并激活 | `item`, `branch?`, `repo` | 查看历史不应调用此工具 |
| `todo_claim` | 领取 issue 工作项：评论到 GitHub + 本地记录，自动升 active | `item`, `items[]`, `repo` | 公开写入须授权 |
| `todo_detail` | 查看稳定 ID、当前执行与历史实现记录 | `item`, `repo` | 历史检查不代表当前候选通过 |
| `todo_context` | 读取结构化 Todo、执行与版本 | `repo`, `todo_id`, `execution_id?` | 取消所需版本取 `todo.lifecycle_revision`，缺省为 0 |
| `todo_progress` | 更新当前执行的 Phase、Next、阻塞项并追加 Evidence | `item`, `phase?`, `next?`, `blocked_on?`, `evidence?`, `repo` | managed 使用受管执行入口 |
| `todo_update` | 更新 idea/backlog/active、追加 PR 关联、分支或笔记 | `item`, `status?`, `pr?`, `branch?`, `note?`, `repo` | 关联不改变主状态；不得绕过收尾或重新打开 |
| `todo_done` | 结束执行但不归档；managed 要求完整 completion | `item`, `repo`, `completion?` | 完成不能绕过证据与安全收尾 |
| `todo_cancel` | 明确取消未开工或非受管 Todo，不归档 | `repo`, `todo_id`, `expected_lifecycle_revision`, `decision` | 精确稳定 ID；不为取消创建执行 |
| `todo_control` | 记录受管执行的暂停或取消请求 | `repo`, `todo_id`, `execution_id`, `request_id`, `expected_revision`, `command` | 请求不等于安全停止，仍需本地安顿或收尾 |
| `todo_delete` | 永久删除 Todo | `item`, `force?`, `repo` | 有执行历史时须明确 `force=true` |
| `todo_archive` | 默认预览；按明确选择的稳定 ID 与快照归档终态 | `repo`, `selections?: [{todo_id,snapshot}]`, `prepare?` | `prepare` 只补旧记录缺失 ID，不归档 |
| `todo_restore` | 恢复展示，保留终态和历史 | `repo`, `item`（稳定 ID） | 不启动执行 |
| `todo_reopen` | 重开至 backlog；开工再用 todo_activate | `repo`, `item`（稳定 ID） | 不启动执行 |
| `todo_compact` | 按日期或数量删除旧归档记录 | `before?`, `keep?`, `force?`, `repo` | 含执行历史时须明确 `force=true` |

当前显式归档中断可用原 `todo_archive` 的 `selections` 重试，仍核对精确快照；
不再支持旧完成/归档合并请求的恢复。

完成交互先执行已授权的检查和审阅，再汇总实际结果和缺少的用户判断。
待评价结果已存在、其余收尾条件已满足，且用户明确验收整项并要求结束时，
同一条反馈可支持实际观察对象的人工报告和完成决定，核对全部门禁后完成，
不机械重复询问，也不代填未观察的人工项。无人工项的计划不临时新增通用人工项，检查全绿仍不代表用户
已决定结束；条件自动收尾尚未启用。详见
[一次验收与完成](../skills/todo/references/execution.md#一次验收与完成)。

### 取消

先用 `todo_context(repo, todo_id)` 读取 `todo.lifecycle_revision`（缺省为 `0`），
作为 `todo_cancel.expected_lifecycle_revision`；不要使用 `workflow_revision` 或为取消先激活。
`todo_cancel` 在锁内核对精确稳定 ID 与版本，保存
`last_cancellation: {decision, at, lifecycle_revision}`，置为 `cancelled`。
没有执行时不补造执行；已有普通执行以 outcome `abandoned` 结束。
版本变化需重读并取得新的取消决定；未处置的操作不能绕过。不归档、不改 GitHub。

当前受管执行必须先通过 `todo_control` 提交 `command.action=request_control`、
`command.kind=cancel` 与真实 `command.decision`，安全处置原操作后，以匹配 decision 的本地
`stopped` 收尾。暂停使用 `kind=pause` 和本地 `settle-pause`。
完整参数与恢复边界见 [执行参考](../skills/todo/references/execution.md#暂停取消与继续)。

### Compact 用法

`todo_compact` 和 `upstream_compact` 支持两种互斥参数：

```bash
# 查看归档统计（不传参数）
todo_compact(repo={platform:"github", instance:"https://github.com", path:"darkingtail/repo"})
upstream_compact(upstream_repo={platform:"github", instance:"https://github.com", path:"team/source"}, repo={platform:"github", instance:"https://github.com", path:"darkingtail/repo"})

# 按条数：Todo 删除超量的旧归档；upstream 归档超量的已处理条目
todo_compact(repo={platform:"github", instance:"https://github.com", path:"darkingtail/repo"}, keep=50)
upstream_compact(upstream_repo={platform:"github", instance:"https://github.com", path:"team/source"}, repo={platform:"github", instance:"https://github.com", path:"darkingtail/repo"}, keep=100)

# 按日期：Todo 删除早于此日期的归档；upstream 归档较早的已处理条目
todo_compact(repo={platform:"github", instance:"https://github.com", path:"darkingtail/repo"}, before="2025-01-01")
upstream_compact(upstream_repo={platform:"github", instance:"https://github.com", path:"team/source"}, repo={platform:"github", instance:"https://github.com", path:"darkingtail/repo"}, before="2025-06-01")
```

- `before` 和 `keep` **互斥**，只能传一个
- `keep=0` 清空所有归档 / 已处理 commits
- `todo_archive` 移到 `todos.archive.yaml`；`todo_compact` 会删除旧归档，不是再归档。
- `upstream_compact` 将符合条件的已处理条目移到 `upstream.archive.yaml`。

### 枚举值

- **存储 status**: `idea` · `backlog` · `active` · `paused` · `done` · `cancelled`
- **`todo_update` 可写 status**: `idea` · `backlog` · `active`；完成使用 `todo_done`，取消按上述路径分流

旧 Todo 状态 `pr_submitted` / `not_planned` 不再接受：`todo_update` 在写入前拒绝，
存储读取也拒绝，不提供自动转换或旧状态读取兼容。上游条目的 `pr_submitted` 不受影响。
PR 关联保留多条，旧单值 `pr` 仍兼容读取；这不表示兼容旧 Todo 状态。
`todo_detail` 独立展示关联 PR 的 draft/open/closed/merged/unknown 与观察时间；
最多查询 20 项、并发 4，失败或未读取明确显示 unknown，不持久化为验收证据。
PR 合并不自动触发 Todo 完成、取消或归档。源码实现与验证范围见
[PR 关联与独立进度](development/todo-delivery.md)。
- **type**: `bug` · `feature` · `docs` · `chore`
- **difficulty**: `easy` · `medium` · `hard`

---

## Bounty 协调（7 Tools）

为 GitHub 原生开源协作流程增加可选悬赏协调能力。bounty 数据本地存储在 `~/.contribbot/projects/v1/<digest>/bounties.yaml`，不托管资金，不替代 GitHub issue / PR / review。

| 工具 | 说明 | 参数 |
|------|------|------|
| `bounty_create` | 创建 bounty，关联 issue 或 todo ref，记录金额和首选 payout rail | `repo`, `title`, `amount`, `rail`, `ref?`, `currency?`, `creator?` |
| `bounty_list` | 查看仓库 bounty 列表，可按状态过滤 | `repo`, `status?` |
| `bounty_detail` | 查看单个 bounty 的 claim、PR、settlement 状态 | `repo`, `id` |
| `bounty_claim` | 认领 bounty，记录 claimant、钱包地址和认领说明，返回可粘贴到 GitHub 的 markdown | `repo`, `id`, `claimant`, `claimant_wallet?`, `claim_note?` |
| `bounty_link_pr` | 关联 bounty 到 PR | `repo`, `id`, `pr` |
| `bounty_mark_ready` | 维护者确认 bounty 已满足结算条件 | `repo`, `id` |
| `bounty_settle` | 记录结算结果或结算指令，支持 Arc USDC / GitHub Sponsors / manual | `repo`, `id`, `rail`, `tx?`, `note?` |

### Bounty 枚举值

- **rail**: `arc-usdc` · `github-sponsors` · `manual`
- **status**: `open` · `claimed` · `ready` · `settled` · `cancelled`

### MVP 边界

- `arc-usdc` 在 MVP 中记录 Arc USDC settlement instruction 或 testnet tx，不托管私钥。
- `github-sponsors` 和 `manual` 记录外部支付确认。
- bounty 是可选协作增强，不改变 GitHub 的 issue / PR / review 中心地位。

---

## Issues & PRs（11 Tools）

### Issues（4 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `issue_list` | 搜索 issues，支持 state/label/关键词过滤 | `repo`, `state?`, `labels?`, `query?` |
| `issue_detail` | Issue 详情：标题、标签、关联 PRs、评论摘要 | `issue_number`, `repo` |
| `issue_create` | 创建 issue，可关联 upstream commit + 自动建 todo | `title`, `body?`, `labels?`, `upstream_sha?`, `upstream_repo?`, `auto_todo?`, `repo` |
| `issue_close` | 关闭 issue，可附评论并关联收尾；managed completion 必须携带精确 todo_item，先预检再做远端操作 | `issue_number`, `comment?`, `todo_item?`, `repo`, `completion?` |

### Pull Requests（5 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `pr_list` | 搜索 PRs，支持 state/关键词过滤 | `repo`, `state?`, `query?` |
| `pr_summary` | PR 摘要：author、status、变更文件、CI checks、reviews | `pr_number`, `repo` |
| `pr_create` | 创建 PR，可追加 Todo 关联，保留多个 PR 且不改变主状态 | `title`, `head?`, `base?`, `body?`, `draft?`, `todo_item?`, `repo` |
| `pr_update` | 更新 PR（标题/描述/状态/草稿） | `pr_number`, `title?`, `body?`, `state?`, `draft?`, `repo` |
| `pr_review_comments` | 列出 PR review 评论（含 ID、diff 上下文、内容） | `pr_number`, `repo` |

### 通用（2 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `pr_review_reply` | 回复 PR review 评论 | `pr_number`, `comment_id`, `body`, `repo` |
| `comment_create` | Issue/PR 通用评论 | `issue_number`, `body`, `repo` |

---

## Discussions（2 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `discussion_list` | Discussion 列表，可按 category 过滤 | `repo`, `category?` |
| `discussion_detail` | Discussion 详情（含所有评论） | `discussion_number`, `repo` |

---

## 上游追踪（9 Tools）

支持 parent 来源和外部 tracking 来源。追踪记录的来源键由完整 `{platform, instance, path}` 身份生成；当前远端抓取仅支持 GitHub.com。无 release 的仓库自动 fallback 到 tags。

### 版本同步（4 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `upstream_sync_check` | 对比上游 release 与目标仓库，按 feat/fix 分组；保存时按来源、版本、目标分支隔离到 `sync/releases/v1/` | `upstream_repo`, `repo`, `version?`, `target_branch?`, `save?` |
| `upstream_list` | 版本同步总览 + 每日 commits 摘要 | `repo`, `upstream_repo?` |
| `upstream_detail` | 查看某版本同步详情或实现记录 | `upstream_repo`, `version`, `repo` |
| `upstream_update` | 更新同步条目：状态 / 关联 PR / 难度 | `upstream_repo`, `version`, `item_index`, `status?`, `pr?`, `difficulty?`, `repo` |

### 每日追踪（4 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `upstream_daily` | 拉取上游 commits（anchor..HEAD），首次引导选择基准版本，支持 releases 和 tags | `upstream_repo`, `since_tag?`, `repo` |
| `upstream_daily_act` | 标记某条 commit 的动作 | `upstream_repo`, `sha`, `action`, `ref?`, `repo` |
| `upstream_daily_skip_noise` | 批量跳过噪音 commits（CI/deps/build/style） | `upstream_repo`, `repo` |
| `upstream_compact` | 清理已处理的 daily commits，按日期（before）或条数（keep）| `upstream_repo`, `before?`, `keep?`, `repo` |

### 历史记录（1 Tool）

| 工具 | 说明 | 参数 |
|------|------|------|
| `sync_history` | 查看已核验来源身份的版本报告；旧 `sync/*.md` 保留但不读取 | `repo` |

仓库参数 `repo` 与 `upstream_repo` 都是完整的三字段对象，不接受
`owner/repo` 简写。`target_branch` 省略时检查全部分支，历史报告也将此
情况与指定分支分开。旧版本报告不自动迁移、覆盖或混入新历史列表。

### 来源存储与隔离

主体项目位于 `projects/v1/<project-digest>/`。以下来源 digest 使用同一
`repository-key-v1` 规则，从来源的完整三字段身份生成，不只使用仓库路径。

| 文件 | 当前格式 | 备注 |
| --- | --- | --- |
| `upstream.yaml` | `schema_version: 1`；`sources.<source-digest>` 含 `repository`、`versions`、`daily` | 读取核对内嵌身份与键；不同实例的相同 SHA 不合并 |
| `upstream.archive.yaml` | `schema_version: 1`；`sources.<source-digest>` 含 `repository`、`commits` | 归档失败保留活动记录；重试不重复追加完全相同的已归档提交 |
| `upstream/<source-digest>/<version>.md` | 按来源隔离的实现记录路径 | 仅使用安全版本文件名；现有读取器不回退旧 `owner/repo` 路径 |

来源身份错误、旧格式或归档内容冲突时明确报错，不自动转换或覆盖数据。
本次身份升级没有扩展远端平台能力：远端 release/commit 抓取仍只支持
GitHub.com。当前 `upstream_daily_act` 和 `upstream_daily_skip_noise`
也仍要求 GitHub.com 主体；不得将能表示 GitLab 来源说成所有工具已支持 GitLab。

### 枚举值

- **upstream item status**: `active` · `pr_submitted` · `done`
- **upstream version status**: `active` · `done`
- **daily commit action**: `skip` · `todo` · `issue` · `pr` · `synced`

### 工作流

```
upstream_daily ──→ upstream_daily_skip_noise ──→ 逐条 upstream_daily_act
       ↓                                              ↓
  首次：选锚点                                  skip / todo / issue / pr / synced
  后续：增量拉取
```

---

## 质量 & 安全（2 Tools）

| 工具 | 说明 | 参数 |
|------|------|------|
| `actions_status` | GitHub Actions CI 状态，高亮失败 | `repo`, `branch?` |
| `security_overview` | Dependabot 漏洞 + code scanning 告警 | `repo` |

---

## Knowledge（1 Resource + 5 Tools）

项目知识沉淀系统，存储在 `~/.contribbot/projects/v1/<digest>/knowledge/` 下；资源列表显示完整仓库身份。

| 类型 | 标识 | 说明 |
|------|------|------|
| Resource | `knowledge://project/{digest}/{knowledgeName}` | 只读访问项目知识，`digest` 定位 v3 项目；支持 list + read |
| Tool | `knowledge_write` | 直接创建/更新项目知识（`name` + `content` + `repo`） |

### 知识演进（Phase 3A — 可审计提案流）

静态 `knowledge_write` 之外的 **propose → review → apply → audit** 工作流：host AI 推理出提案，
maintainer 确认后才写入 canonical 知识，写入时带 provenance 脚注。提案索引存于
`~/.contribbot/projects/v1/<digest>/knowledge.proposals.yaml`。

| Tool | 说明 |
|------|------|
| `knowledge_propose_update` | 创建一条待审提案（不写 canonical）。入参：`target` / `action`(create/append/revise) / `source_type` / `title` / `rationale` / `proposed_content` / `source_ref?` / `repo` |
| `knowledge_proposals` | 列出提案（可按 `status` = pending/applied/rejected/rolled_back 过滤），用于拿 `kp-N` ID |
| `knowledge_apply_update` | 应用已批准提案到 canonical 知识，写 provenance 脚注。入参：`proposal_id` / `repo` |
| `knowledge_reject_update` | 驳回 pending 提案，不改 canonical。入参：`proposal_id` / `reason?` / `repo` |
| `knowledge_rollback_update` | 用 apply 时保存的旧内容回滚 applied 提案。入参：`proposal_id` / `repo` |

**action 语义**：`create` 目标必须不存在；`append` 追加到已有；`revise` 用完整新内容替换已有。
provenance 脚注用 `<!-- contribbot:provenance -->` 标记包裹，多次 revise 不堆叠。

---

## Prompts（4 Prompts）

预定义的多步工作流模板。

### daily-sync — 每日同步

```
1. repo_config → 查看项目模式
2. 已确认 parent 且用户授权同步：sync_fork → 同步当前主体 fork
3. For each tracking source:
   - upstream_daily → 拉取新 commits
   - upstream_daily_skip_noise → 跳过噪音
   - 逐条 triage → upstream_daily_act
4. If none: 跳过追踪，展示 project_dashboard
```

参数：`repo`

### start-task — 开始任务

```
1. project_dashboard → 项目全貌
2. todo_list → 当前 todos
3. todo_activate → 激活指定 todo（或帮选一个），创建/恢复当前执行
4. todo_detail → 查看 Phase/Next、执行历史和实现记录
5. todo_progress → 用户确认方案后写入第一个可执行 Next
6. 总结：任务内容、相关 issues、建议方案
```

参数：`repo`, `item?`

### pre-submit — 提交前检查

```
1. pr_summary → PR 变更概览
2. pr_review_comments → 检查未解决评论
3. actions_status → 确认 CI 通过
4. 必要时 pr_review_reply → 回复评论
5. 报告：CI 状态、未解决评论、合并就绪度
```

参数：`repo`, `pr`

### weekly-review — 周回顾

```
单项目：
1. contribution_stats → 本周贡献数据
2. todo_list → 进展和阻塞
3. upstream_list → 上游同步覆盖率
4. todo_archive → 预览 done/cancelled；用户另行选择精确快照后才归档
5. 总结：成果、阻塞、下周重点

跨项目：
1. project_list → 所有项目概况
2. 逐项目检查 stats/todos/upstream
3. 跨项目总结
```

参数：`repo?`

---

## 工具组合逻辑

| 步骤 | 工具组 | 说明 |
|------|--------|------|
| 1. 同步 fork | `sync_fork` | fork/fork+tracking 模式下，确认 parent 与用户授权后同步主体仓库 |
| 2. 建立上下文 | `project_dashboard` | 项目全貌 |
| 3. 任务管理 | `todo_add` → `todo_activate` → `todo_progress` / `todo_detail` → `todo_update` → `todo_done`；取消按 `todo_cancel` / `todo_control` 分流 | 结束不自动归档；`todo_archive` 另行预览与选择 |
| 4. 深入调查 | `issue_detail` / `pr_summary` / `discussion_detail` | 了解具体内容 |
| 5. 上游追踪 | `upstream_daily` → `upstream_daily_act` → `upstream_daily_skip_noise` | 抓取 + triage |
| 6. 版本同步 | `upstream_sync_check` → `upstream_list` → `upstream_detail` | 版本级对比 |
| 7. 质量保障 | `actions_status` / `security_overview` | CI + 安全 |
| 8. GitHub 写入 | `issue_create` / `issue_close` / `comment_create` / `pr_create` / `pr_update` / `pr_review_reply` | 写操作 |
| 9. 知识沉淀 | `knowledge_write` | 项目知识记录 |
| 10. 全局视图 | `project_list` / `repo_config` | 跨项目管理 |

---

## Agent 行为规则

- 首次进入项目：`project_init` 核实主体并读取/创建最小配置，再用 `repo_config` 查看关系和追踪选择；不从 parent 自动推断追踪
- 创建 PR 时传 `todo_item`，成功后不重复 `todo_update`；部分失败按原请求恢复日志与关联，不重复发布
- 每完成一个可恢复执行单元：`todo_progress` 更新 Phase、Next、阻塞项和 Evidence
- 创建 issue 后：如来自 upstream daily，自动 `upstream_daily_act` 关联
- 关闭 issue 时：仅在传入精确 `todo_item` 时联动完成；managed 还须完整 completion，预检失败不能退化为只关闭 GitHub
- 回复 review 前：先用 `pr_review_comments` 获取评论列表
- 仓库范围 repo 参数必须显式传完整 `{platform, instance, path}`，无默认值；展示名称不作输入，不保存 MCP 项目绑定
- 所有输出为 markdown 格式，表格类输出带备注列
