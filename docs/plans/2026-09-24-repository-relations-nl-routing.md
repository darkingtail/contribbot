# 仓库关系命名与 nl 路由草案

> 2026-09-25 阅读提示：本文件保留历轮讨论过程；最新具体方案见
> [Project 配置设计](2026-09-25-project-config-design.md)。
> 用户只确认六项分离原则，完整结构仍待确认。下文“未修改/数据保持原状”等
> 表述是对应轮次的历史快照，当前候选与数据状态以每日进度记录为准。

日期：2026-09-24，Asia/Shanghai。
状态：Claude 第 202 轮已返回；第 18 节确定单用户开发阶段采用“整体备份后按 V2 重建”，第 17 节记录按仓库建模访问权限。
Skill 结构方向已确认，config 方案仍在说明与讨论，未授权实际配置写入。
第 3–10 节保留此前讨论过程；其中“暂不记录 parent”的范围建议已由第 11 节修订，未改写历史决定。
未修改业务代码、Skill、实际 config、Todo 或 GitHub，未授权配置迁移。

## 1. 要解决什么

用户在任务“同步分支”中说“同步上游分支”，意图是个人 fork 与源仓库的分支
对齐。助手最初选择了包含 commit 追踪的 daily-sync，后来才正确收窄。
最终同步成功，不等于初始范围判断正确；没有发生已证实的外部追踪误执行。
过程见[调查报告](../reviews/2026-09-24-nl-fork-sync-routing.md)。

本方案区分两个问题：仓库关系叫什么，以及用户这次想对哪个对象做什么。
仅改字段名不能保证 nl 路由正确，新增 Skill 也不能替代执行前的范围核对。

## 2. 已核实的术语与配置

| 名称 | 含义与本案对应关系 | 备注 |
| --- | --- | --- |
| 个人 fork | `darkingtail/antdv-next` | 分支同步的目标仓库 |
| GitHub `parent` | 直接 fork 来源：`antdv-next/antdv-next` | GitHub API 的关系字段 |
| GitHub `source` | fork 网络根仓库：本案同为 `antdv-next/antdv-next` | 多层 fork 时可能不同；不能把 parent/source 当作永远相同 |
| GitHub 文档中的 upstream repository | 通常指 fork 的原仓库 | 因而不能在通用 nl 中断言 upstream 必然指外部技术参考源 |
| Git remote `upstream` | 用户可命名的本地 remote；本案指向 antdv-next 源仓库 | 需看实际 URL，名称本身不证明关系 |
| contribbot 当前 `config.upstream` | 用户选择的外部追踪源 | 用户本次所指为 ant-design，但当前磁盘配置仍为 null/pending |

本日先前实际执行的只读 GitHub API 查询返回：

```json
{
  "repo": "darkingtail/antdv-next",
  "fork": true,
  "parent": "antdv-next/antdv-next",
  "source": "antdv-next/antdv-next",
  "default_branch": "main"
}
```

配置位置为 `C:/Users/WANGX/.contribbot/antdv-next/antdv-next/config.yaml`，
当前 `role: read`、`fork: darkingtail/antdv-next`、`upstream: null`，
没有 `upstream_confirmed`。本轮没有将用户的概念讨论写成实际配置决定。
canonical project 目前由解析规则与数据目录确定，不等同于任意名为 upstream 的 remote。

官方资料：GitHub REST「Get a repository」说明 fork 返回 parent/source；
「Configuring a remote repository for a fork」使用 upstream 指原仓库。

```text
https://docs.github.com/en/rest/repos/repos#get-a-repository
https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/configuring-a-remote-repository-for-a-fork
```

## 3. Claude 意见与主助手判断

| 议题 | Claude 第 192 轮建议 | 主助手判断 | 备注 |
| --- | --- | --- | --- |
| 外部追踪字段 | 改为 `external_upstream`，确认标记同步改名 | 支持作为设计方向，减少与 Git/GitHub 惯例的冲突 | 尚未批准实施或迁移 |
| 显示 fork 来源 | 可保存 `fork_parent`、`fork_source`，但只能作为关系快照 | 支持显式 parent；source 不必成为必填配置，快照不得成为第二套权威关系 | 不通过字段变更自动重定向数据目录 |
| ProjectMode | 不强求本批修改枚举 | 建议先保留内部模式值，明确用户可见的关系名称 | 避免为命名扩展整个迁移范围 |
| Skill 入口 | 新增 fork-sync，收窄 daily-sync，统一 MCP 描述与 Prompt | 支持；边界应按操作目的而非关键词堆叠 | 不是新增一份名称不同、行为相同的完整巡检 |
| pending 时的宽泛 nl | 有 fork、外部源 pending 时直接 branch-only | 不整体采纳；pending 不是用户意图，也不是操作许可 | 明确 fork 同步不必被外部源未确认阻塞；目标仍不清楚则询问 |
| 巡检的前置动作 | 保留先 sync_fork，以保证数据新鲜 | 不采纳该理由：查询来源的新提交不要求先修改个人 fork | “查看/巡检”不能自动扩大为 Git 分支写入；具体契约仍待确认 |
| 配置示例 | 使用 role=write、null+confirmed=true | 拒绝照搬；与当前 role=read、pending 不一致 | 没有用户明确“不追踪”的决定，不得伪造 none |
| 旧配置兼容期 | 可保留一至两个版本双读 | 不默认加入；用户此前不要求投入旧数据兼容层 | 是否迁移真实配置仍需独立授权，不能以“不兼容”为由清空数据 |

Claude 的建议不是用户决定、独立验收或实现证明。主助手以上异议也不构成实施授权。

## 4. 配置建议

建议把用户设置与 GitHub 关系分开理解。`fork`、`external_upstream` 属于项目配置；
`fork_parent` 是从 GitHub 核实的关系信息，不允许仅凭手写字段认定其为有效同步来源。
若持久化 parent/source，应记录查询来源、时间和新鲜度；读取配置不必每次强制联网，
但关系不明或冲突时，涉及分支写入的操作不能悄悄采用陈旧值。
快照结构、刷新规则及测试范围仍需在实施方案中明确。

下面仅展示“用户已确认追踪 ant-design”时的关系部分，**不是当前磁盘配置**：

```yaml
fork: darkingtail/antdv-next
fork_parent: antdv-next/antdv-next  # GitHub 关系快照，不是另一个可任意设置的追踪源
external_upstream: ant-design/ant-design
external_upstream_confirmed: true
```

当前 pending 若进入获批迁移，仍应保留 pending，不得因为示例而写入 ant-design
或 confirmed=true。不擅自改变 role、org、项目生命周期、数据目录或现有 Todo。
无需把 Git remote 改名为 parent；产品字段与用户的 Git remote 命名是两层概念。

## 5. nl 分流建议

先核实项目关系，再识别本次动作、来源和目标。明确表达不机械重复确认；
有多个合理解释且会改变操作范围时，先用一句自然语言询问。

| 用户 nl | 建议处理 | 备注 |
| --- | --- | --- |
| 把我的 fork main 同步到 antdv-next 源仓库 main | fork-sync，只做明确授权的分支同步 | 不额外执行 upstream_daily、跳噪音或创建任务 |
| 同步上游分支 | 优先识别为 Git 分支操作，排除直接进入完整巡检 | 来源、目标或本地/远端范围不清楚时确认，不凭“上游”一词扩展 |
| 同步上游／同步一下 | fork 与外部追踪关系并存且语义不清时，展示实际仓库并询问 | 没有配置外部源也不代表所有歧义都消失 |
| 追踪 ant-design 的新提交 | 在已确认来源与授权范围内进入 commit 追踪 | 不因此同步 fork 分支；未确认来源先核实，不静默配置 |
| ant-design 最近更新了什么／源仓库有更新吗 | 只读查询 | 不因出现“更新”就运行写入工作流 |
| 做一次日常巡检 | 确认所需巡检范围后进入相应入口 | 不把“巡检”自动等同于允许改分支、跳过条目或公开创建 Issue |

当两种来源均已核实时，可以问：

> 这里有两个来源。你是要把个人 fork 的 main 对齐 antdv-next/antdv-next，
> 还是查看 ant-design/ant-design 的新提交？

这只是询问示例，不要求用户输入固定口令。必须使用当时已核实的仓库和分支；
pending 时不能把 ant-design 描述成已配置来源。用户本轮正在讨论设计，
不能把这些 nl 例子当成真实同步授权。

## 6. 实施范围建议与未来验收

| 范围 | 建议调整 | 备注 |
| --- | --- | --- |
| config 与输出 | 外部追踪名称明确化，显式展示 parent；确定快照与旧字段处置规则 | 不新建第二个 canonical repo 真值 |
| fork-sync Skill | 分支同步独立入口，允许现有 branch 参数，说明远端 fork 与本地 checkout 的区别 | 本地更新不是 sync_fork 已经完成的隐含副作用 |
| daily-sync Skill | 明确排除仅分支同步，区分查询、追踪记录与 Git/GitHub 写入 | 不单靠增加触发词 |
| MCP Instructions/描述/Prompts | 统一 fork parent、外部追踪源及动作边界 | 不允许 Skill 与工具提示相互矛盾 |
| 确定性测试 | 配置解析与 pending 保留、关系冲突、工具参数、只同步分支不调用追踪工具 | 尚未编写或执行 |
| 真实 nl 验证 | 在明确/模糊表达、四种模式、pending/none/configured 下做调用轨迹核对 | 文本测试不证明宿主 LLM 每次路由正确；重点复现本次原话 |

眼下需要用户确认的是这项改进的方向与实施范围，不要求用户先裁决所有字段细节。
若认可方向，先补齐快照和迁移方案中真正影响行为的细节，再改代码。
不顺带扩展 Todo 嵌套、Agent Team、自动巡检调度或已待确认的其他开发批次。

## 7. 本轮咨询与证据

| 事件 | 实际结果 | 备注 |
| --- | --- | --- |
| 第 191 轮，11:18:29–11:25:25 | HTTP 503，exit 1，未取得建议 | stdout JSON 的 is_error=true；不能只看 subtype=success；原记录保留 |
| 用户要求“再试一下Claude” | 授权对同一问题重新调用一次 | 没有自动连续重试或更换顾问 |
| 第 192 轮，11:37:06–11:39:13 | exit 0，is_error=false，长期 session ID 匹配，完整回复已读回 | 工具禁用、无硬截止；stderr 为 CLI 网关兼容提示，并非空 |
| 材料 | 同一问题与 5 个源码/Skill 文件的冻结材料 | 5 个摘要读回无漂移；未发送实际 config 原文或凭据 |
| 当前交付 | 本草案、进度记录、咨询综合与检查回执 | 没有新业务测试、配置迁移、提交推送或用户验收 |

原始咨询记录保存在本机忽略目录
`D:/dev/darkingtail/contribbot/.catpaw/discussions/phase3-claude/`，
包括 round-191/192 的 prompt、snapshot、stdout、stderr、response 与 session 元数据。
本轮结果只支持“已取得顾问意见并整理草案”，不支持“方案已批准”或“nl 问题已修复”。

## 8. 第二次讨论：反方复审与收敛结论

用户要求再次讨论后，第 193 轮继续使用同一个 Claude 长期会话，针对第 192 轮
做反方复审。该轮于 13:52:38–13:54:15 返回，exit 0、session ID 匹配，
5 个冻结材料摘要未变。它不是新实施授权，也没有运行命令、测试或修改文件。

### 8.1 第 193 轮相对上一轮的变化

| 议题 | 第 192 轮 | 第 193 轮 | 主助手综合 | 备注 |
| --- | --- | --- | --- | --- |
| `upstream` 存储字段 | 建议改成 `external_upstream` | 撤回破坏性重命名，改为输出层统一术语 | 采纳第 193 轮：本批不迁移字段，用户可见语义统一为 external upstream | 降低迁移与兼容成本，但源码注释、schema 描述、输出都要明确 |
| `fork_parent/source` | 可写入 config 作为快照 | 撤回，关系事实与用户决策分离 | 采纳：不写入 config；当前也不新增缓存 | 将来确有离线或审计需求，再设计独立 discovery metadata |
| canonical repo | 未主张改变 | 保持 direct parent，不递归到 source | 暂时维持现状并补测试；不把 source 等同于 external upstream | 多层 fork 是已知边界，不在本批扩大迁移 |
| Skill 结构 | 新增 fork-sync、收窄 daily-sync | 不新增 Skill，把 daily-sync 改为澄清路由器 | 不采纳第 193 轮这一点：仍建议新增窄 fork-sync，并明确 daily-sync 排除 branch-only | 本次误选正是宽入口先吞掉窄意图；继续做万能路由会保留根因 |
| 宽泛 nl | fork+external 时询问 | pending 时也可询问，并区分 read/preview/write | 采纳三维 intent/object/scope；是否询问看实际歧义和副作用 | 不按关键词或 ProjectMode 机械询问 |
| 巡检 | 上轮允许完整流程 | 本轮建议先预览再确认写入 | 采纳行为边界：只读发现可直接做，写入动作另需明确范围 | 不把“巡检”解释成允许同步分支或创建/跳过记录 |

### 8.2 最小稳定领域模型

| 层级 | 保存或处理什么 | 位置 | 备注 |
| --- | --- | --- | --- |
| 用户项目配置 | `fork`、现有 `upstream`、确认状态、role/org/status | `config.yaml` | `upstream` 的用户可见名称统一为 external upstream；本批不改磁盘字段 |
| GitHub 关系事实 | `parent`、`source`、默认分支 | 操作前按需查询，或复用当次已核实结果 | 不写 config；当前不为假设的离线需求增加缓存 |
| canonical project identity | 当前数据目录与 resolve-to-direct-parent 规则 | `~/.contribbot/{owner}/{repo}` 与 resolver | 仍是一套真值；source 不自动改写项目身份 |
| 本次执行意图 | read / preview / write、目标对象、操作范围 | 每次 nl 请求的运行时上下文 | 不持久化成项目配置，也不从 pending 状态推断 |

因此，用户最初提出“把 parent 加到 config”是合理的诊断方向，但不是最终推荐。
真正缺失的是**可见且可核实的关系展示**，不一定是另一个持久化字段。
`repo_config` 或初始化输出可以在可用时展示 fork parent/source，并标明来源和查询时间；
查询失败时说明无法核实，不能回退到用户可编辑字段并把它当 GitHub 事实。

当前 antdv-next 配置保持真实状态：

```yaml
role: read
org: null
fork: darkingtail/antdv-next
upstream: null
# upstream_confirmed 缺省，因此 external upstream 状态仍为 pending
```

已核实的 GitHub 关系另行展示：`parent=antdv-next/antdv-next`、
`source=antdv-next/antdv-next`。用户提到的 `ant-design/ant-design` 仍只是待确认的
external upstream 候选，不能写进上述示例或显示为已配置。

### 8.3 nl 的最终分流原则

先判断 intent、object、scope，再决定直接执行、只读预览或询问；ProjectMode 只是关系背景。

| nl 与已知上下文 | intent / object / scope | 行为 | 备注 |
| --- | --- | --- | --- |
| “把我的 fork main 对齐 antdv-next 源仓库 main” | write / fork parent / branch-only | 进入 fork-sync | 对象、范围明确；仍遵守具体 Git/GitHub 写入权限 |
| “同步上游分支”，项目同时存在 fork 与已配置 external upstream | write / object 可能歧义 / branch | 展示两个真实关系，询问是 fork parent 分支对齐还是 external source 追踪 | 这是用户特别提出应先询问的场景 |
| “同步上游分支”，只有已核实 fork 关系 | write / fork parent / branch | 可解释为 branch sync；执行前说明精确源、目标和分支 | 不凭 pending 候选虚构第二个来源 |
| “查看 ant-design 新提交” | read / external source / commit list | 只读查询；未配置时先核实候选，不自动保存配置 | 查询不等于 tracking，不修改 fork |
| “追踪 ant-design 新提交” | write-local / external source / commit tracking | 预览将写入的追踪范围；来源未确认时先确认配置 | 不自动同步个人 fork |
| “日常巡检” | read-first / configured sources / inspection | 先做只读发现并展示后续候选动作 | 后续跳过、建 Todo/Issue、同步分支分别按动作边界处理 |
| “同步一下” | intent、object、scope 均不清楚 | 询问一个简短问题 | 不让用户选择内部技术名，使用真实仓库和动作说明 |

### 8.4 Skill 与 MCP 边界

维持“纯 MCP 工具层”：MCP 工具接收显式参数并完成一个窄动作，不解析 nl，
不因为 ProjectMode 自动串联多个有副作用的操作。Skill/宿主负责理解 nl、展示关系、
询问必要歧义并编排工具。

| 入口 | 推荐职责 | 备注 |
| --- | --- | --- |
| 新增 `fork-sync` Skill | 只处理 fork 与 direct parent 的分支对齐；明确排除 commit 追踪和巡检 | Skill 名称与动作一一对应，修复本次入口范围过宽的问题 |
| 收窄 `daily-sync` Skill | 只读发现优先，组织 commit tracking 与维护巡检；明确排除“仅同步分支” | 不再把 `sync_fork` 作为所有巡检的默认前置写操作 |
| `sync_fork` MCP 工具 | 描述改为 fork 与 parent 的分支同步，返回精确源、目标、分支 | 不使用裸 upstream 指代 parent |
| repo/config 输出 | 存储字段不变，用户输出统一写 external upstream；可展示实时核实的 parent/source | 不将 API 关系写回 config |
| MCP Prompts / Instructions | 加入 intent/object/scope 与 read/preview/write 边界 | 必须和两个 Skill 的适用与排除范围一致 |

不新增 `repository-sync` 万能路由 Skill。宽泛 nl 的必要询问可以由宿主规则完成；
再加一个宽入口只会把选择问题上移一层，并不能替代窄 Skill 的明确边界。

### 8.5 当前推荐的实施批次

| 批次 | 内容 | 验收重点 | 备注 |
| --- | --- | --- | --- |
| 1 | 统一用户可见术语；修正 `sync_fork` 描述；新增 fork-sync；收窄 daily-sync 与 MCP Prompt | 原话“同步上游分支”不进入完整 daily-sync；明确表达可直达，歧义表达会询问 | 不改 config schema，不增加关系缓存 |
| 2 | 补关系展示与 resolver 测试，包括第一层、多层 fork 夹具和 API 不可用 | parent/source 不写 config，canonical 仍唯一且失败行为明确 | 是否需要缓存由真实问题驱动 |
| 3 | 在测试仓库和 antdv-next 做 nl 调用轨迹验证 | 区分只读预览、branch write、tracking write；不把最终成功替代初始路由验收 | 真实写操作仍需当次授权 |

本次再次讨论后，没有需要用户先裁决的底层存储选项。真正需要用户确认的只有：
是否接受以上收敛方向，进入批次 1 的设计实现。接受该方向也不等于授权迁移实际配置、
执行同步、提交、推送或完成现有 Todo。

## 9. 第三次讨论：按事实与用例校正，不以轮数代替验证

用户再次要求讨论。第 194 轮沿用既有长期会话，于 14:21:27–14:22:55 成功返回。
本轮增加 `upstream-daily.ts` 作为第六个冻结文件，核实工具实际副作用。
主助手已核对 exit 0、is_error=false、session 一致、完整回复与 6 个材料摘要。
这是静态设计讨论，不是新实现、业务测试、独立验收或用户决定。

### 9.1 纠正此前的过强表述

| 说法 | 事实与本轮判断 | 备注 |
| --- | --- | --- |
| config 只能保存用户决策 | 不成立。`detectConfig` 已自动探测并保存 role/org/fork；关键是数据来源、更新方式和冲突处理 | 本批暂不增加 parent/source 字段，不等于这些字段永远不能放 config |
| `upstream` 不应改名，因为迁移代价高 | 未做完整影响面评估，不能声称代价已量化。当前先改清楚领域描述，不把迁移作为本次 nl 修复的前置 | 长期字段名仍可讨论；用户不要求旧数据兼容也不是静默迁移许可 |
| 所有 upstream 工具都是外部追踪 | 不成立。`upstream_daily` 的来源参数也可指 fork 来源 | 区分 config.upstream 的特定语义与通用追踪工具，不能全局机械加 external |
| `role: read` 就不能同步 fork | 不成立。这里 role 探测的是 canonical 项目，而写入目标是个人 fork | 权限按实际目标核实；用户明确授权、参数正确后才能执行，不能用写入试探代替授权 |
| “查看 config”和“拉取 commits”都只读 | 不成立。`repoConfig` 缺配置时可能初始化；`upstreamDaily` 会写版本、提交与关联记录 | 查询方案必须核对实际调用路径；不能把 upstream_daily 当只读预览 |
| 新增 fork-sync 就修复了路由根因 | 待测假设。它能提供更窄的说明，但不能保证宿主选择正确 | 两种 Skill 组织方案都要检查适用范围，误选后也必须停止或重定向 |
| 两来源并存就每次询问 | 过度。明确对象或当前上文已消歧时不重复问；只有一个已知来源也可能不清楚要查看还是修改 | fork+upstream 是关系背景，不是本次行动 |

核实依据为本批源码；官方术语与 CLI 边界另与 GitHub REST 和 CLI 手册核对：

```text
https://docs.github.com/en/rest/repos/repos#get-a-repository
https://cli.github.com/manual/gh_repo_sync
```

parent 指直接 fork 来源，source 指网络根。当前工具显式传入远端 fork 作为
`gh repo sync` 的目标，来源采用 gh 默认 parent；它不会因此更新本地 checkout。
未指定分支时采用源的默认分支，不可在用户指定 main 时悄悄省略 branch 参数。
默认 fast-forward 与 `--force` 的 hard reset 有区别；本批不授权任何强制覆盖。

### 9.2 不随 Skill 组织方式改变的行为边界

| 用例 | 预期行为 | 备注 |
| --- | --- | --- |
| 两来源均配置，明确“个人 fork main 对齐 antdv-next main” | 核实目标和分支后，按已明确的同步请求执行窄动作，传入指定 branch | 不附加 tracking 或更新本地 checkout |
| 两来源均配置，无上文，只说“同步上游” | 用实际仓库说明歧义，询问是 fork 分支同步还是外部变更追踪 | 不因选中 daily-sync 而执行完整流程 |
| “同步上游分支”，上文已确认个人 fork | 复用仍有效的本轮上下文，不重复确认 | 无此上下文且仍存在实质歧义时才问 |
| external pending，明确“看看 ant-design/ant-design 最近更新” | 可只读查询已明确的仓库；简称有歧义则先核实对象 | 不要求先配置追踪源，不调用会写记录的 upstream_daily |
| external pending，只说“同步一下” | 询问本次目标，不伪造已配置 external 来源，也不发起无关 onboarding | 不能把“同步 parent”和“暂不配置但仍同步 parent”列为两个选择 |
| “日常巡检”，本次范围及本地追踪记录已有有效批准 | 在已有范围内继续，不机械再确认；没有授权的分支修改、skip 或公开写入不附带执行 | 配置存在不等于已授权当前操作 |
| “日常巡检”，没有范围约定 | 可先做能保证无写入的观察，只有会影响后续动作的范围不清才询问 | 不默认为 sync_fork + upstream_daily 整套工作流 |
| parent 只读、个人 fork 可写 | 分开看实际目标权限，不能按 parent 的 read 提前拒绝 fork 操作 | 权限失败如实保留，不擅自切换账号或目标 |
| remote fork 已更新、本地 main 未更新 | 只报告远端 fork 同步结果，本地状态单独说明 | 本地 dirty/diverged 不自动 stash/reset/force；远端分叉也不能强制覆盖 |

例如，两种来源都已配置且意图不明时：

> 这里的“上游”是指 antdv-next/antdv-next 吗？你是要把自己的 fork 分支对齐它，
> 还是查看 ant-design/ant-design 的变更？

只有 fork 已核实、用户说“同步一下”且上下文不足时：

> 你是要更新 GitHub 上的个人 fork，还是也要更新当前本地分支？

示例是说明询问方式，不是要求所有请求照问或强制二选一。仓库名、分支与已有确认
均从当时事实取得；不得由 pending 状态虚构候选。

### 9.3 顾问建议、主助手判断与未决项

Claude 仍倾向把 daily-sync 改为澄清入口，主助手仍倾向独立 fork-sync 加明确
排除边界。前者理由是复用入口，后者理由是让“一次分支对齐”和“维护巡检”
各有用途明确的说明；双方都没有真实宿主对照结果，不能把其中一种说成已证实更可靠。
无论采用哪种，工具 descriptions、MCP Prompts 和 Skills 必须使用同一操作边界。

本批继续建议：先让 parent 与外部追踪源可见，暂不增加持久化字段、关系缓存，
不调整 canonical 目录或递归到 source。以上是当前范围取舍，不是永久架构禁令。
字段改名与路由修复分开判断，不能把“存储名保留”说成 nl 歧义已经解决。

第 194 轮有用但仍有不足，主助手不整体采纳：

| 顾问回复中的问题 | 主助手处理 | 备注 |
| --- | --- | --- |
| 巡检示例重新包含 sync_fork，且已有有效范围也要再问 | 按上表区分现有授权与新增动作，撤掉隐含分支同步 | 不以安全为由反复询问同一已明确决定 |
| pending 询问仍夹带“配置追踪源”选项 | 只澄清当前请求，不顺带开启配置流程 | 用户主动要求配置时另行处理 |
| 用例指定 main，示例命令没有显式 branch | 保留指定分支的工具参数要求 | 不把 CLI 默认分支当成用户所指分支 |
| 声称真实 nl 轨迹不可自动化 | 过强；可以设计宿主回放评估，但须实际记录工具轨迹 | 本轮未建立回放或运行路由测试 |
| 把“输出无裸 upstream”作为验收 | 改为术语与指向准确，不禁止 Git remote 名或通用追踪工具正常用词 | 关键词检查不是意图识别验证 |

验证仍分两类：工具契约检查参数、写入范围、错误结果与数据保持；真实宿主轨迹
检查明确表达直达、歧义表达询问、误选入口后纠正，以及没有额外副作用。
本轮只完成前置阅读与用例推演，没有执行上述验证。
用户尚未确认实现范围，不要求用户为了继续讨论先作技术二选一。

## 10. 用户确认独立 fork-sync，询问 config 如何调整

用户明确：“我赞同新增独立 fork-sync，config.yaml怎么改？”
已确认采用独立 fork-sync，而非将 daily-sync 扩大为所有同步的入口。
此前第 9 节的顾问与主助手分歧作为历史保留，当前不再要求用户重复选择 Skill 结构。
该决定不是已实现，也不代表用户已确认 config 方案或要求立刻修改实际数据。

沿用第 9 节已讨论的本批方案，**独立 Skill 不要求改变 config schema**。
已有 `fork` 用于指定个人 fork；直接来源按需核实 parent。
`upstream` 继续作为外部追踪源的存储字段，输出明确标为 external upstream；
本批暂不新增 parent/source 字段，也不迁移 canonical 数据目录。
本次是说明已有建议及记录用户决定，没有新一轮顾问调用或新增设计取舍。

14:56 从实际配置重新读取的相关字段如下，示例不包含全部可选字段：

```yaml
role: read
org: antdv-next
fork: darkingtail/antdv-next
upstream: null
```

实际 `upstream_confirmed` 缺省，因此外部追踪状态仍为 pending。
此前讨论里的 `org: null` 示例不应当作当前磁盘值；本轮没有修改 org。
pending 不妨碍目标已明确且获授权的 fork 分支同步。

若后续核实并由用户明确确认启用 `ant-design/ant-design`，现有 schema 即可表达：

```yaml
upstream: ant-design/ant-design
upstream_confirmed: true
```

这里只展示届时的两个字段，不是全文件替换，不代表已经写入或本次得到配置授权。
显式不追踪才是 `upstream: null` 加 `upstream_confirmed: true`；
未决定仍保持 pending，不替用户补确认。
其他实际字段保持不变，不新增同步自动执行开关，不因配置来源而授权巡检或公开写入。

## 11. parent 是否记录：建议保存 fork_parent，待用户确认

用户追问“不记录parent吗？”后，第 195 轮在既有 Claude 长期会话中针对这一点
重新评估。15:08:58–15:09:57 返回成功，exit 0、is_error=false、session 一致，
完整回复已读回，4 个冻结文件摘要未变。没有再次讨论已确认的独立 fork-sync。

Claude 建议保存 `fork_parent`，主助手采纳为新的设计建议：配置可直接说明
个人 fork、它的直接来源与外部追踪源，便于跨会话理解和核对。此前“不记录”
主要是为了缩小范围，并没有证据证明保存一个关系字段成本不可接受。
GitHub 仍是关系事实的权威；保存本地记录不等于把手工填写值当成最新关系。
这项权衡是针对配置可读性作出的修订，不是“能够查询的事实都应持久化”的新规则。

建议关系片段如下，**属于拟议 schema，不是已修改的实际配置**：

```yaml
role: read
org: antdv-next
fork: darkingtail/antdv-next
fork_parent: antdv-next/antdv-next
upstream: null
# upstream_confirmed 仍缺省，外部追踪源保持 pending
```

选择 `fork_parent` 而非裸 `parent`，明确它描述 `config.fork` 的直接来源，
避免多层 fork 时误解为 canonical 项目自身的 parent。
本批只提议这一字段，不加 `source`、核验时间、TTL 或独立缓存文件；
不改 `upstream` 字段名、ProjectMode、权限和 canonical 数据目录。

| 场景 | 建议行为 | 备注 |
| --- | --- | --- |
| 获授权的初始化或关系刷新 | 由 GitHub 查询核实 config.fork 的直接来源，再保存 fork_parent | 不从目录名称或用户猜测直接填入 |
| 查看已有配置 | 展示已记录的关系，明确它不是本次实时核验结果 | 不因查看而联网回填或迁移实际配置 |
| 同步前 | 重新核实实际关系，与记录比对；来源和分支明确后才执行 | 保存关系不能代替执行时的校验 |
| 关系不一致 | 停止相关同步，展示记录与当前观察差异，确认如何处理 | 不静默换源、移动 Todo 数据目录或重设外部来源 |
| API 失败 | 保留旧记录，说明无法核实，暂不进行本次同步 | 不擦成 null，不以用户口头确认冒充已完成 API 核验 |
| 字段缺失或没有 fork | 缺失表示未记录；明确无 fork 时可用 null | 不把“尚未查到”和“确定没有关系”混为一谈 |

当前代码尚无该字段的声明及核验行为，仅手动加 YAML 不会完成这个功能。
顾问提出“同步时查到即可自动补齐”与“失败后手动确认继续”，主助手没有把它们
采纳为默认行为：实际回填应处于明确的初始化/刷新范围，人工确认不能替代关系核验。
缺失字段如何提示刷新、执行时如何绑定核实的来源和返回结果，实施前需补测试契约，
不能把先读 API、再调用 gh 当作没有任何时序风险的原子操作。

用户本轮是追问，不是同意落盘。独立 fork-sync 已确认；新增 fork_parent 是
待确认建议。实际 config、源码、Skill、Todo 与 GitHub 均未修改，未运行新业务测试。

## 12. `fork.parent` 与关系 schema：讨论中的 v2 候选

用户提出将扁平 `fork_parent` 改为 `fork.parent`，并要求先讨论 `config.yaml`
整体设计。第 196 轮于 16:28:36–16:30:15 延续原 Claude 长期会话并成功返回；
exit 0、is_error=false、session 一致，8 份冻结材料摘要已写入调用记录。
本轮仅为设计评审，没有修改业务代码、Skill 或实际配置。

### 12.1 已核实的影响面

当前 `fork` 不是纯展示字段，而是一个字符串契约：它参与 ProjectMode 推断、
canonical config 反向查找、PR 目标选择、本地执行仓库校验和 `sync_fork` 命令。
因此从 `fork: string` 改成对象不是简单改名，而是一次 config schema 变更。

| 候选 | 优点 | 代价 | 备注 |
| --- | --- | --- | --- |
| `fork` + `fork_parent` | 改动较小，现有 `config.fork` 调用基本保留 | 关系字段继续依赖前缀命名；以后加入 source 会继续横向增加字段 | Claude 第 196 轮推荐 |
| `fork.repository` + `fork.parent` | YAML 直接表达一组 GitHub fork 关系；以后可自然增加可选 source | 所有读取 `config.fork` 的代码和测试都要迁移 | 主助手当前倾向，属于 schema v2 |

Claude 认为嵌套对象的语义收益不足，建议沿用扁平 `fork` 并新增
`fork_parent`；同时保持 `upstream + upstream_confirmed`。主助手不完全采纳：
既然此次目标是让配置准确表达仓库关系，`fork.repository` 与 `fork.parent`
比两个平铺字符串更接近领域结构，也避免未来继续增加 `fork_*` 字段。
这项收益建立在愿意承担一次完整迁移的前提上，不应伪装成低成本补丁。

### 12.2 主助手建议的最小一致结构

当前建议使用 `repository` 而不是 `repo`：配置主要面向人阅读，完整名称更明确；
`parent` 沿用 GitHub API 术语。V1 不加入 `source`、核验时间、TTL 或关系历史。

```yaml
role: read
org: antdv-next
status: active

fork:
  repository: darkingtail/antdv-next
  parent: antdv-next/antdv-next

external_upstream:
  status: pending
```

不建议一边把 fork 结构化、一边继续保留含义容易混淆的
`upstream + upstream_confirmed` 组合。若接受 schema v2，外部技术追踪源也应采用
带判别状态的对象，避免 `null` 和可选布尔值共同表达三态：

```yaml
# 待用户决定
external_upstream:
  status: pending

# 用户明确不追踪
external_upstream:
  status: none

# 已配置
external_upstream:
  status: configured
  repository: ant-design/ant-design
```

`external_upstream` 比裸 `upstream` 更长，但能直接区分 GitHub fork parent、
Git remote 的惯用名和跨项目技术追踪源。内部 ProjectMode 是否继续使用
`upstream` 命名属于后续实现细节，不要求用户理解存储兼容层。

### 12.3 三种项目示例

普通仓库、外部追踪源尚未决定：

```yaml
role: write
org: null
status: active
fork: null
external_upstream:
  status: pending
```

个人 fork、外部追踪源尚未决定：

```yaml
role: read
org: antdv-next
status: active
fork:
  repository: darkingtail/antdv-next
  parent: antdv-next/antdv-next
external_upstream:
  status: pending
```

个人 fork 加已配置外部追踪源：

```yaml
role: read
org: antdv-next
status: active
fork:
  repository: darkingtail/antdv-next
  parent: antdv-next/antdv-next
external_upstream:
  status: configured
  repository: ant-design/ant-design
```

### 12.4 字段权威与刷新边界

| 字段 | 来源与权威 | 建议写入时机 | 备注 |
| --- | --- | --- | --- |
| `fork.repository` | 当前项目上下文中已核实的个人或组织 fork | 明确初始化或关系刷新 | 有歧义时询问用户，不按同名仓库猜测 |
| `fork.parent` | GitHub API 的直接 parent | 核实 fork 后与 repository 一起保存 | config 是记录，GitHub 仍是关系权威 |
| `external_upstream.status` | 用户决定 | onboarding 或用户明确更改时 | 查看配置不能把 pending 静默写成 none |
| `external_upstream.repository` | 用户确认且已查证的外部追踪源 | status 进入 configured 时 | pending/none 时不应保留陈旧 repository |
| `role` / `org` | GitHub 观察信息 | 初始化或明确刷新 | 不因普通只读查看自动改写 |
| `status` | contribbot 项目生命周期决定 | 用户归档或恢复时 | 与仓库关系正交 |

普通 `repo_config` 查看只展示已记录值，不联网刷新或写回。`fork-sync` 在执行前
必须重新核实目标 fork 的当前 parent；不一致或 API 失败时停止同步、保留旧记录并
展示差异，不静默改配置。canonical project 仍由工具参数和数据目录确定，暂不在
config 中重复保存，避免双重权威。

### 12.5 尚待用户确认

当前真正的产品取舍不是单独选择下划线还是点号，而是：是否接受一次关系 schema v2，
把 `fork` 与 external upstream 都改成自描述对象。主助手建议接受该方向；Claude
建议维持扁平字段以缩小改动。用户尚未确认最终 schema，本节不构成迁移或实施授权。

## 13. `external_upstream` 是否必要：最新建议改回 `upstream`

用户追问“为什么非要加一个 external？”后，第 197 轮于
16:39:35–16:40:26 延续同一 Claude 长期会话并成功返回；exit 0、
is_error=false、session 一致，6 份冻结材料摘要已记录。本轮只讨论命名，
没有修改源码、Skill 或真实配置。

`external_` 原本用于区分三种容易混淆的对象：GitHub fork parent、名为
`upstream` 的 Git remote，以及 contribbot 的跨项目追踪源。但在 schema v2 中，
GitHub 关系已明确放入 `fork.parent`，对象结构已经完成了关键消歧。

Claude 与主助手本轮意见一致：存储字段使用结构化 `upstream`，不增加
`external_` 前缀。理由如下：

| 判断 | 结论 | 备注 |
| --- | --- | --- |
| 配置可读性 | `fork.parent` 与顶层 `upstream` 已可区分 | 不需要依赖更长字段名再次消歧 |
| 现有领域术语 | 保留 `upstream_*` 工具、ProjectMode 和文档概念 | schema 结构仍会变化，但无需同时扩大术语迁移 |
| Git remote 冲突 | `.git/config` 与 contribbot config 是不同层次 | 用户可见文本仍应说明这里是跨项目追踪源 |
| 长期扩展 | `upstream` 对象可增加状态和仓库，不需要前缀 | 不提前增加 source、TTL 或历史字段 |

最新推荐片段修订为：

```yaml
fork:
  repository: darkingtail/antdv-next
  parent: antdv-next/antdv-next

upstream:
  status: pending
```

配置完成后的形式：

```yaml
upstream:
  status: configured
  repository: ant-design/ant-design
```

用户可见说明仍需准确表达为“跨项目追踪源”或在必要时使用
“external upstream”解释语义，但这不要求存储键名也包含 `external_`。
第 12 节的 `external_upstream` 保留为前一版候选历史，不再是当前推荐。
用户尚未确认完整 schema v2，本轮问题也不构成实施或迁移授权。

## 14. 若弃用 upstream：当前首选 `tracking`

用户继续询问：“如果说 upstream 有歧义，那么换成什么比较好？”第 198 轮于
16:43:45–16:45:14 延续原 Claude 长期会话并成功返回；exit 0、
is_error=false、session 一致，8 份冻结材料摘要已记录。本轮没有修改业务代码、
Skill、实际 config 或 Todo。

本字段实际表达的不是仓库血缘，也不只是静态参考，而是 contribbot 对另一个仓库
持续拉取 commits/releases、筛选噪音、记录处理决定并支持移植评估的行为。
因此 Claude 与主助手当前都推荐按行为命名为 `tracking`：

```yaml
fork:
  repository: darkingtail/antdv-next
  parent: antdv-next/antdv-next

tracking:
  status: pending
```

配置追踪仓库时：

```yaml
tracking:
  status: configured
  repository: ant-design/ant-design
```

明确不启用跨项目追踪时：

```yaml
tracking:
  status: none
```

| 候选 | 判断 | 备注 |
| --- | --- | --- |
| `tracking` | 当前首选，直接描述持续追踪行为 | 在 repo config 上下文中，和 Todo/Issue tracking 可以区分 |
| `reference` | 次选，适合强调技术参考 | 语义偏静态，不能完整表达主动拉取和处理变更 |
| `upstream` | 若不做 schema v2 可继续兼容，但不是最佳新命名 | 与 Git/GitHub fork 原仓库和 Git remote 术语重叠 |
| `tracking_source` | 不推荐 | 过长，且 source 可能与未来 `fork.source` 混淆 |
| `reference_repository` | 不推荐 | 顶层键过长，和子字段 `repository` 重复 |

选择 `tracking` 不意味着必须立即重命名全部 `upstream_*` 工具或
`upstream.yaml` 文件。配置 schema、用户可见术语、MCP 工具兼容名和内部存储文件
可以分批处理；实施方案仍需明确哪些名称保留别名、哪些进入新契约。

当前最新的 schema v2 候选因此是 `fork.repository + fork.parent` 与
`tracking.status + tracking.repository?`。这是顾问和主助手的推荐，不是用户最终决定，
也不构成迁移、测试、同步、提交或推送授权。第 13 节保留为上一轮命名讨论历史。

## 15. 面向扩展的 config schema v2

用户认可 `tracking` 方向，并指出当前单层 `config.yaml` 不足以承载后续扩展，
要求与 Claude 讨论整体结构。第 199 轮于 16:52:26–16:54:34 延续原长期会话
并成功返回；exit 0、is_error=false、session 一致，12 份冻结材料摘要已记录。
本轮没有修改业务代码、Skill、实际 config 或 Todo。

### 15.1 推荐的稳定顶层域

```yaml
schema_version: 2

project:
  role: read
  org: antdv-next
  status: active
  archived_at: null

fork:
  repository: darkingtail/antdv-next
  parent: antdv-next/antdv-next

tracking:
  status: pending
```

| 域 | 负责内容 | 稳定不变量 | 备注 |
| --- | --- | --- | --- |
| `schema_version` | 配置格式版本 | 读取和迁移必须按版本分派 | 不代表 MCP 或 Skill 版本 |
| `project` | contribbot 项目管理与权限快照 | 生命周期和权限字段不承担仓库血缘 | `role/org` 是观察快照，`status` 是本地项目状态 |
| `fork` | GitHub fork 关系 | 一个仓库最多一个直接 `parent` | `parent` 是记录，操作前仍需核实 |
| `tracking` | 跨项目追踪决定与目标 | 状态和目标组合必须合法 | V1 保持单一追踪源对象 |

暂不增加抽象的 `relations`、对称的 `repository`、插件配置或任意 metadata 区域：
它们没有当前不变量，只会把未来问题提前引入。

### 15.2 为什么 tracking 先保持单对象

当前真实需求是一个被追踪仓库。V1 使用：

```yaml
tracking:
  status: configured
  repository: ant-design/ant-design
```

而不是现在就改成数组。这样状态语义、用户确认和工具调用都简单；将来出现多源
需求时，在新的 schema 版本中把 `tracking.repository` 扩展为
`tracking.sources[]`，不会把 V1 的配置误读成多个 parent。这里的“预留”体现为
明确的版本边界和独立域，不是提前实现多源执行。

### 15.3 状态与无效组合

```yaml
# 用户尚未决定
tracking:
  status: pending

# 用户明确不追踪
tracking:
  status: none

# 用户确认并设置目标
tracking:
  status: configured
  repository: ant-design/ant-design
```

约束如下：`configured` 必须有合法 `repository`；`pending` 与 `none` 不得带目标。
从 `configured` 改为 `none` 时，必须一并清除旧目标，不能留下陈旧值。
`ProjectMode` 是由配置计算出的派生结果，不再另存一份状态。

### 15.4 迁移与未知版本边界

Claude 建议缺失版本按 V1、首次读取时迁移到 V2，并在未知高版本上尝试 best-effort
读取。主助手采纳“显式 `schema_version` 和可测试迁移”，但不同意普通读取自动写盘
或对未知版本 best-effort 写入：

| 情况 | 建议行为 | 原因 |
| --- | --- | --- |
| 缺少 `schema_version` | 按 legacy V1 解析为内存中的规范化视图 | 兼容旧数据，但读取不改文件 |
| `schema_version: 1` | 只在明确迁移动作中转换 | 迁移前可预览、备份、校验和回退 |
| `schema_version: 2` | 严格校验后读写 | 当前契约 |
| 大于当前版本 | 只读提示不支持，禁止写入或降级覆盖 | 防止丢失未知字段 |
| 版本格式非法 | 报错并保持原文件 | 不猜测用户数据含义 |

因此迁移应是独立、明确的操作，具备 dry-run、备份和失败保留原文件的行为；
`repo_config` 普通查看、`project_init` 的只读阶段和工具加载不能暗中触发迁移。

### 15.5 权威边界

| 信息 | 权威来源 | config 的角色 | 备注 |
| --- | --- | --- | --- |
| `fork.parent` | GitHub API | 已核实关系快照 | fork-sync 前重新核实，不把快照当授权 |
| `fork.repository` | 当前项目上下文与用户确认 | 工作目标记录 | 不由同名仓库猜测 |
| `tracking.status` | 用户决定 | 持久化决定 | 查询结果不能自动变更决定 |
| `tracking.repository` | 用户确认且候选已查证 | 追踪目标记录 | 只在 configured 时存在 |
| `project.role/org` | GitHub 观察 | 可更新快照 | 失败不静默写成无权限或无组织 |
| `project.status` | contribbot 生命周期操作 | 本地状态 | 与 fork/tracking 正交 |
| `ProjectMode` | 代码派生 | 不持久化 | 避免状态漂移 |

### 15.6 当前结论与待确认项

Claude 与主助手对整体方向基本一致：采用嵌套 schema v2、加入版本字段、保留
canonical 身份隐含、fork 使用对象、tracking V1 使用单对象、状态使用显式判别值。
主助手额外收紧了迁移和未知版本处理，避免自动写盘和降级覆盖。

当前只需要用户确认一个大方向：是否接受这套 schema v2。确认后再分别设计：
V1 兼容读取、显式迁移命令、严格校验、各工具适配和测试矩阵。尚未开始实现，
也不应因为设计记录而改变实际 `~/.contribbot` 数据。

## 16. 拆分 project：lifecycle 独立，role/org 不持久化

用户明确指出 `project` 混合了两类来源不同的信息，要求拆开。第 200 轮于
17:15:06–17:17:08 延续原 Claude 长期会话并成功返回；exit 0、
is_error=false、session 一致，6 份冻结材料摘要已记录。本轮没有修改业务代码、
Skill、实际 config 或 Todo。

### 16.1 源码事实

| 旧字段 | 实际用途 | 结论 | 备注 |
| --- | --- | --- | --- |
| `status` | 归档/恢复、项目列表、Web、维护门禁 | 持久化到 `lifecycle.status` | 真实业务状态 |
| `archived_at` | 归档时间及展示 | 仅 archived 时持久化 | active 时省略，不写无意义 null |
| `role` | repo_config 与 Web 展示 | 默认不持久化，按需查询 | 当前 API 失败会误用默认 read，必须修正为 unknown |
| `org` | repo_config 展示 | 删除，按需查询 owner type | 值重复 canonical owner，且无业务消费者 |

`role` 实际表示当前 GitHub 用户对 canonical 仓库的权限，不代表个人 fork 权限，
裸名称容易误导。`org` 只是 owner 为 Organization 时重复保存 owner 字符串；canonical
身份已由数据目录和工具 `repo` 参数确定。两者都不应仅因“方便展示”进入持久配置。

### 16.2 最新推荐 schema

当前 antdv-next 候选：

```yaml
schema_version: 2

lifecycle:
  status: active

fork:
  repository: darkingtail/antdv-next
  parent: antdv-next/antdv-next

tracking:
  status: pending
```

归档项目使用判别式结构：

```yaml
lifecycle:
  status: archived
  archived_at: "2026-09-24T09:00:00.000Z"
```

有效约束：`active` 不带 `archived_at`；`archived` 必须带合法时间。恢复时整体写成
`status: active` 并删除旧时间，避免生命周期状态与时间戳漂移。

### 16.3 GitHub 信息如何展示

`repo_config` 或 Web 需要权限和 owner 类型时按需查询 GitHub：

```text
canonical permission: read | triage | write | maintain | admin | unknown
owner type: user | organization | unknown
```

API 失败必须显示 `unknown` 和原因，不能把失败降级成 `read`。这些观察结果不授权
GitHub 写操作；执行写操作仍由具体工具实时校验权限和返回结果。

若未来出现明确的离线展示需求，可在新的设计中增加带 `observed_at` 的
`observations` 快照，但当前不添加。没有时间和刷新语义的权限快照比不保存更容易误导。

### 16.4 V1 到 V2 的处理

| V1 字段 | V2 处理 | 备注 |
| --- | --- | --- |
| `status` | `lifecycle.status` | 缺失按 legacy active 规范化 |
| `archived_at` | `lifecycle.archived_at` | 仅 archived 时接受并校验 |
| `role` | 不迁移 | 后续显示时重新查询，失败为 unknown |
| `org` | 不迁移 | owner type 按需查询 |
| `fork` | `fork.repository` | parent 需 GitHub 核实后才能写入 |
| `upstream/upstream_confirmed` | `tracking` 判别对象 | 按 pending/none/configured 显式转换 |

普通读取仍只产生内存中的 V2 视图，不静默删掉旧文件中的 role/org。实际落盘转换
必须通过显式迁移预览、备份、校验和 apply；未知高版本保持只读并拒绝覆盖。

### 16.5 当前决定与剩余问题

用户已确认 `project` 必须拆开，因此不再把“是否拆分 lifecycle”列为待决定项。
Claude 与主助手建议：删除 `project`，新增独立 `lifecycle`，并默认移除持久化
`role/org`。尚待用户确认的是：是否接受 role/org 改为按需查询，而不是建立
`observations` 快照。该确认仍只完成 schema 设计，不自动授权代码迁移。

## 17. fork、parent、tracking 的权限必须分别建模

用户指出：`fork`、`parent` 和 `tracking` 对应的仓库权限并不相同，不能用一个
项目级 `role` 表示。这是对第 16 节“直接移除 role/org”表述的重要修正：
**不能把权限概念删除，而要把它从项目级字段改成按仓库的访问事实。**

第 201 轮于 17:30:53–17:32:54 延续原 Claude 长期会话并成功返回；exit 0、
is_error=false、session 一致，6 份冻结材料摘要已记录。本轮没有修改业务代码、
Skill、实际 config 或 Todo。

### 17.1 三层模型

| 层 | 保存什么 | 示例 | 权威/时效 |
| --- | --- | --- | --- |
| 关系配置 | 仓库名称及关系、用户是否启用追踪 | `fork.parent`、`tracking.status` | GitHub 关系或用户决定，跨会话稳定 |
| 访问观察 | 每个仓库当前可达性和 GitHub 权限 | fork=admin、parent=read、tracking=public | GitHub API 观察，容易过期 |
| 操作能力 | 某个动作是否可以执行 | `can_sync_fork`、`can_track`、`can_push_pr` | 每次动作前根据最新观察派生，不持久化为真值 |

例如：个人 fork 可以是 `admin`，parent 只有 `read`，tracking 仓库公开可读但
对当前账号没有写权限。这三个结果都成立，不能用一个 `role: read` 概括。

### 17.2 配置核心保持关系，不把权限内联进去

当前推荐的 `config.yaml` 核心仍是：

```yaml
schema_version: 2

lifecycle:
  status: active

fork:
  repository: darkingtail/antdv-next
  parent: antdv-next/antdv-next

tracking:
  status: pending
```

我不建议立刻写成下面这种深层结构：

```yaml
fork:
  repository:
    full_name: darkingtail/antdv-next
    permission: admin
  parent:
    full_name: antdv-next/antdv-next
    permission: read
```

因为权限是会变化的观察结果，且同一个仓库可能同时出现在多个关系中；把它内联
会产生重复和陈旧数据。`config.yaml` 负责回答“涉及哪些仓库、它们是什么关系、
用户决定追踪谁”，不负责永久保存“此刻 API 返回了什么权限”。

### 17.3 访问观察的最小模型

运行时查询每个仓库，返回类似：

```yaml
repository: darkingtail/antdv-next
permission: admin
state: reachable
observed_at: "2026-09-24T17:30:00+08:00"
```

字段含义：

| 字段 | 含义 | 允许值/备注 |
| --- | --- | --- |
| `repository` | 仓库全名 | `owner/repo`，作为记录键和值来源 |
| `permission` | 当前认证账号在 GitHub 返回的权限 | `read/triage/write/maintain/admin/unknown` |
| `state` | 是否能够访问和查询 | `reachable/public/forbidden/not_found/api_error` |
| `observed_at` | 本次观察时间 | 观察事实，不是有效期或授权时间 |

`permission` 与 `state` 必须分开：公开 tracking 仓库可能是
`permission: unknown, state: public`；API 503 是 `state: api_error`，不能降级成
`permission: read`。`can_sync_fork` 等能力不写入配置，而是在执行前重新查询并派生。

### 17.4 是否持久化访问观察

当前建议分两步：

1. V2 初始实现只在本次调用或会话内保存观察结果，执行前强制重新查询。
2. 真有离线仪表盘或权限变化审计需求时，再增加独立的可选
   `access.yaml`，而不是把易过期数据混进关系 `config.yaml`：

```yaml
schema_version: 1
repositories:
  darkingtail/antdv-next:
    permission: admin
    state: reachable
    observed_at: "2026-09-24T17:30:00+08:00"
  antdv-next/antdv-next:
    permission: read
    state: reachable
    observed_at: "2026-09-24T17:30:00+08:00"
  ant-design/ant-design:
    permission: unknown
    state: public
    observed_at: "2026-09-24T17:30:00+08:00"
```

如果未来确实需要缓存，缓存必须明确是可删除、非权威、带观察时间的快照；不能
授权同步、写 PR 或替代执行前核验。Claude 本轮提出的可选 `access_cache` 与此
目标相同，但主助手倾向把它放在独立文件，避免 config 同时承担意图和易变观察。

### 17.5 `org` 与旧 `role` 的迁移

`org` 不需要迁移：owner 已包含在 `repository` 全名和 canonical 数据路径中；
owner 类型没有当前消费者，按需查询即可。旧 `role: read` 不能直接映射成 fork、
parent 或 tracking 任一仓库的权限，因为它既没有明确对象，也可能是 API 失败时的
错误默认值。迁移应保留旧文件备份，新的访问观察从各仓库重新查询；查询失败就记录
`unknown/api_error`，不猜测。

### 17.6 当前待确认项

用户指出的“不同仓库有不同权限”已经成为模型约束，不再是待讨论事实。下一项需要
确认的是访问观察的持久化边界：**V2 先只读实时查询，未来需要离线时再单独增加
`access.yaml`；还是现在就把可选访问快照纳入第一版？** 无论选择哪种，执行前重新
核实权限都应保留。

## 18. 单用户开发阶段：整体备份后按 V2 重建

用户明确说明：当前只有本人使用，不需要照顾本机旧配置的兼容性；历史数据直接
备份，备份后重新开始。第 202 轮于 17:55:39–17:58:01 延续原 Claude 长期会话
完成复核并成功返回；exit 0、is_error=false、session 一致，6 份材料摘要已记录。
本轮只确认设计边界，没有触碰本机数据、源码或实际配置。

### 18.1 采用的工程取舍

| 决定 | 处理方式 | 备注 |
| --- | --- | --- |
| 旧 config 兼容 | 不实现 V1 reader 或 V1→V2 迁移 | 当前是单用户开发环境 |
| 历史数据 | 整体备份，不纳入新运行时读取 | 包括 todos、upstream、knowledge、patrol 等 |
| 新配置 | 直接生成严格 V2 | 必须带 `schema_version: 2` |
| 其他项目 | 与本次重建一起作为历史备份保留，不逐个迁移 | 新运行从干净数据开始 |
| 回滚 | 从明确的备份目录恢复 | 恢复旧配置需要匹配旧版本代码，不由 V2 自动读取 |

这不是把历史数据判定为无价值，而是把“保留历史”和“让新代码兼容历史”分开。
备份提供恢复可能性，不能授予新代码读取旧 schema 的权限。

### 18.2 备份与重建边界

目标操作协议为：

1. 读取并确认当前 `~/.contribbot` 的绝对路径。
2. 将整个 `~/.contribbot` 复制到带时间戳的备份目录，例如：
   `~/.contribbot-backup/2026-09-24T175800+0800/`。
3. 校验备份存在且至少包含原目录的文件清单。
4. 在用户明确授权后，清空活动数据目录或移走旧活动目录。
5. 新代码用 V2 初始化所需的最小目录和 `config.yaml`。
6. 用真实 `project_init`、关系查询、tracking 三态和生命周期测试新环境。

“有备份”不等于自动允许第 4 步。备份、清空、重新初始化分别报告结果；
清空前必须展示实际目标绝对路径，避免把其他目录或备份目录当成活动目录。
本轮没有执行其中任何一步。

### 18.3 V2.0 范围

V2.0 只实现新 schema 和真实需要：严格校验、`lifecycle`、`fork` 关系对象、
单一 `tracking` 对象、按仓库实时查询 permission/state，以及执行前的能力核实。
明确不做：V1 兼容、迁移命令、access.yaml 持久化、多 tracking 源、权限历史、
完整仓库注册表和任意 metadata。

仍保留 `schema_version: 2`。它不是为了兼容旧数据，而是为了让未来 V2→V3
有明确的格式边界，并让错误版本在加载时直接失败。

### 18.4 当前 V2 配置

```yaml
schema_version: 2

lifecycle:
  status: active

fork:
  repository: darkingtail/antdv-next
  parent: antdv-next/antdv-next

tracking:
  status: pending
```

当前实际 `~/.contribbot` 仍保持原状。用户已确认的是“不做旧数据兼容、历史整体
备份后重建”的设计方向；真正执行备份和清空仍需单独明确开始操作。
