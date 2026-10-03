---
name: contribbot:consult
description: "请 Claude 或 Codex 对设计、调查或代码提出只读第二意见，并记录主助手综合和用户决定。触发词：顾问、咨询、第二意见、让 Claude 讨论、consult。不是 Agent Team、独立验收或 GitHub Discussion。"
metadata:
  author: darkingtail
  version: "1.0.0"
  argument-hint: <repository> [question]
---

# Consult

主助手负责上下文、综合与实施，Advisor 只给建议，关键产品决定由用户作出。
可以独立咨询；关联已有 Todo 使用稳定 ID，不为咨询自动建立或激活 Todo。

## 执行入口

源码开发使用本 Skill 相邻的 `scripts/contribbot-run.mjs`：
先解析本 Skill 的真实路径，再用 `node <该绝对路径> --schema` 检查能力。
后文的 `contribbot-run ...` 在开发态都替换为 `node <该绝对路径> ...`，
不要求 PATH 中存在同名命令。入口与其依赖均加载本 checkout 的源码，
不会回退旧 dist、其他安装或联网下载。不是源码链接时，应说明缺失并使用明确安装的
兼容 Runner，不从当前工作目录猜测 contribbot 的位置。

`dev:setup` / `dev:check` 会分别检查 Todo 执行助手与 Runner，但源码变更、
构建、检查并不等于当前 MCP 会话已重载。不要擅自执行 setup 或修改用户配置。

## 预览与授权

首次进入仓库按 init 建立上下文。每次仓库范围 MCP 工具显式传
`repo={platform, instance, path}`；简称和 URL 仅供宿主确认项目身份。
Runner 的 `--directory` 从已初始化主体项目的返回结果取得，不从
`owner/repo` 拼接目录；已确认的会话项目也不构成 MCP 隐式绑定。
本版仅支持本机 Claude/Codex 原生可执行文件的绝对路径；不执行仓库同名程序、
shell wrapper 或任意第三方适配器。找不到运行时先说明，不静默换顾问。

先用 Runner 的 `contribbot-run provider inspect --runtime <claude|codex> --executable <绝对路径>`
检查 Provider，保存返回的完整 binding/disclosure；这一步可能运行本地 `--version`/`--help`，
但不调用模型。然后调用 `consult_prepare` 生成材料和 preview。每个新问题使用唯一
`request_id`；继续讨论传原 `discussion_id`。`rehydrate` 带入可追溯的决定及同一顾问近期
有效回复，`fresh` 不带历史；不承诺等价于运行时 resume 或完整长会话。

Packet 包含当前问题、必要上下文和明确选择的文件。`tracked` 发送 HEAD 已提交内容；
当前未提交修改要显式选 `diff`，新文件选 `untracked`，忽略文件选 `ignored`。
后三者需相应 `scope.categories` 与路径授权。拒绝凭据、`.git`、目录链接和路径越界。
必需内容超量时缩小范围，不擅自删掉已确认决定；低优先级历史省略会在 `omitted` 展示。

向用户简短展示顾问、材料类别/数量/路径、未提交或忽略内容标记，以及 preview 中的
disclosure。只读不等于保密隔离：CLI 可读取该账号可读的其他文件，可能向远程服务
发送内容，并写自己的日志或认证元数据。筛查不能保证发现所有秘密。
Claude 禁用模型工具；Codex 使用禁止升级的只读沙箱，写保护探针不通过则不调用模型。

| 授权 | 做法 | 备注 |
| --- | --- | --- |
| 本次明确请求 | `authorization.explicit_once={source,statement}` | 记录真实用户消息，不伪造授权 |
| Todo 有限额度 | `consult_control` 的 grant 先预览，再以精确 digest 和用户决定授予 | 绑定 Todo、路径、类别、用途、顾问 disclosure、最大轮数 |
| 用户认可的规则 | grant 的 source 为 `policy_acknowledged` | 用户确认精确规则文件 digest；文件本身不能授予权限 |
| 未授权或拒绝 | 不派发 | 当前拒绝优先，不能用旧规则绕过 |

默认一位顾问一轮，开放式讨论先建议最多三轮并让用户确认；第二位顾问须用户明确加入，
传 `additional_advisor`，顺序咨询，不把其他顾问原始输出自动灌入。额度内不反复询问，
但每轮仍展示简短材料说明，并提交当前 preview digest。范围或 disclosure 变化需新授权。
paused 冻结新调用；终态、撤销、规则变化、重开后的旧额度不能继续使用。

确认后保持原材料、binding 和 scope，调用 `consult_request`，补 `confirmed_preview` 与
授权。它只登记一个精确的待执行 Turn，返回 `discussion_id/turn_id` 和 Runner 参数，
不启动 Provider。随后只对这个 Turn 执行
`contribbot-run consult start --directory <目录> --discussion <id> --turn <id>`；
Runner 不扫描队列、不接受任意 shell 指令，也不把启动返回当成已有答案。
旧 `consult_start` 仅返回替代流程提示，不读取或启动原请求。

## 观察、综合、决定

用 `consult_status` 查询精确 Turn，`consult_read` 读取建议；两者严格只读，只有需要诊断
才 `raw=true`。不得因等待久、启动成功、父进程退出而重复发送或改用另一顾问。重复已
登记的原请求只会返回原 Turn；新请求会消耗新一轮。没有模型硬截止时间。

| 动作 | 含义 | 备注 |
| --- | --- | --- |
| `stop_wait` | 用户停止等待 | 不杀进程，不释放在途额度 |
| `terminate_advisor` | 请求原 supervisor 终止顾问父进程 | 不证明后代或远程请求已结束 |
| `abandon` | 不再采用这一轮 | reserved 且从未 claim/dispatch 时记录 `released_before_dispatch` 并释放本地占用；已启动的原操作仍保留占用与迟到结果 |
| `reconcile` | 由 Runner 执行明确授权后的本地恢复 | 只适用于已 claim/dispatch 的原操作；MCP 不观察 OS 进程，Runner 负责观察原进程和提交恢复事实，保留远端未核实事实 |
| grant revoke | 撤销后续调用权 | 已启动调用可能仍返回，保留但不采纳 |

结果不明时说明具体未知事实，保留原 turn 供排查；不清空记录绕过保护。
咨询失败不阻止 Todo 的其他工作。无法继续等待时告诉用户可说“查看这次顾问结果”。

异常恢复先读取 `consult_status` 的原 discussion/turn/revision。已有回执只通过
`contribbot-run consult recover --directory <目录> --discussion <id> --turn <id>` 显式摄入，
不重跑模型。需要进程恢复时由 Runner 执行两阶段观察和 reconcile；MCP 不再直接观察 OS
进程，也不接受手写“已停止”事实。
第一阶段执行 `contribbot-run consult observe --directory <目录> --discussion <id>
--turn <id> --expected-revision <当前版本>`，只追加原父进程停止的 `release_observation`，
不释放占用。
第二阶段才提交后代报告、用户决定和 `accept_remote_uncertainty=true`。
必须在这次观察之后实际检查后代，再形成 report：来源、操作者、可追溯位置、机器、
观察时间、方法、范围和精确 `handles_covered`。报告不能早于或等于停止观察，
不能只因缺少句柄、父进程退出或字段填齐而声称整个进程树已停止。
将 `id`、`observation_id`、`expected_revision`、`report`、真实 `decision` 以及
`accept_remote_uncertainty=true` 写入本次恢复的 JSON 请求文件，再执行
`contribbot-run consult reconcile --directory <目录> --discussion <id> --turn <id>
--request <该文件绝对路径>`。不得从第一阶段观察自动生成后代报告或用户决定；
Runner 经 Core 在锁内重查原句柄。运行中、未知、异机或覆盖不匹配拒绝；
期间产生控制请求、进程登记或结果写入时，旧观察失效，要重新观察、检查后代和确认。
缺少原 supervisor 身份时，已 claim/dispatch 的 Turn 仍保留占用，本版不凭空补句柄；
尚未 claim/dispatch 的 reserved Turn 只能由用户显式 abandon，进入 `released_before_dispatch`，
不能通过 recover 伪造回执。
后代停止属于操作者报告，不是工具完成的整个进程树 OS 验证；无法查清时继续保留占用。
用户须理解释放仅针对本地，远端生成/计费可能继续。原结果、未决事实和额度不改写、不退款；
不自动重发或换顾问。后续调用是新 request，重新通过预览及授权检查，可使用仍有效的剩余额度。
恢复标记为 `reconciled_by_attestation`，迟到回复保留但不进入综合；清理原文仍需另行确认。

将“顾问建议”“主助手采纳或异议”“需用户决定”分开。
`consult_decide(action=synthesize)` 以 `expected_revision` 和 turn/output digest
追加综合；过期、被放弃、已清理或不完整的回复不得伪装成当前建议。
用户确认后用 `action=decision` 追加 adopt/reject/defer；只有用户明确要求才 associate/close。
决定记录不改变 Todo、计划、检查、Knowledge 或 GitHub。计划变更仍走 `todo_plan`；
顾问输出不能提交为 checks/evidence/Proof、人工验收或独立检查通过。

## 原文清理

`consult_purge_raw` 先预览，用户确认精确 digest 后才执行。保留授权、来源 digest、
综合与决定，删除本地 packet/原始回复；综合本身可能仍含敏感文本。
不做自动 TTL，不声称服务商日志、CLI 元数据或已有备份也被删除。
