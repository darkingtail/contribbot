# schema v3 恢复提示与公开关系入口复核

日期：2026-10-02，Asia/Shanghai。
范围：既有三字段身份契约的恢复提示遗漏、活跃文档校准，
以及用户已批准的独立 parent 关系刷新公开入口。入口已实现，
最新受影响回归 8 文件、143/143 通过；整体 goal 尚未完成。
下文“待确认”和早期收尾状态保留为历史，当前结果见末节。

## 恢复提示修复

| 问题 | 实施 | 备注 |
| --- | --- | --- |
| `todo_claim` 远端评论已返回、本地关联失败时仍提示字符串 repo | 序列化 `resolveRepo` 返回的完整 repository | 稳定 Todo ID、原 operation marker 和本地恢复规则不变 |
| `issue_close` 两处示例仍提示字符串 repo | 将已解析 repository 传入私有函数，在示例中输出完整对象 | 不改内部 GitHub-only journal、锁键或远端交付 target |
| managed 关闭失败示例可能遗漏 completion | 仅提示携未变更 completion 重试原请求，不再给不完整的可调用示例 | 不放宽预检或重新授权任何远端动作 |
| 未提供 comment 时生成 `comment=undefined` | 未提供的参数不输出；有评论时保留原值 | 不改 comment digest、请求等价或幂等规则 |

实际 RED 先为 3 个目标断言失败；补充 managed 和无评论场景后，保留记录的
定向 RED 为 **5 失败、152 未选中**。修复后同命令为
**5 通过、152 未选中**。未选中不表示测试已运行后通过或平台不支持。
原测试中的不重复评论、不重复关闭、稳定 ID、完成不归档和后续取消验证保留。

原始结果：

- `.catpaw/discussions/phase3-claude/2026-10-02-recovery-guidance-red.json`
- `.catpaw/discussions/phase3-claude/2026-10-02-recovery-guidance-green.json`

MCP 类型检查、构建与 `git diff --check` 已通过。七文件扩大回归最终
**211/211 通过、0 失败、0 跳过**，退出码 0；其中 issue-close 142 项、
todo-claim 15 项、MCP server 19 项、项目身份 15 项、parent helper 7 项、
sync-fork 5 项、repo-config-tool 8 项。定向 5 项包含在该 211 项中，
不重复累计。原始报告：
`.catpaw/discussions/phase3-claude/2026-10-02-recovery-guidance-regression.json`。
这不是本次新候选的全量回归或整体用户验收；此前完整回归中的 Windows
超时两项失败没有被修改或豁免。

## Claude 意见与采纳

两轮均沿项目既有 Claude 会话续接，模型工具禁用，只发送必要源码快照；
正常退出、结果可读，所附全文件指纹未漂移。不是严格读取隔离，
CLI 可保存自己的会话，所选代码会发往模型服务。顾问没有执行测试。

| 轮次 | 意见与主助手处理 | 备注 |
| --- | --- | --- |
| `2026-10-02-recovery-guidance` | 顾问确认这是既有契约缺口；采纳完整身份传递、保留 completion 和省略缺失 comment | 不采纳把必填参数放在可选参数之后的建议；使用可通过 TypeScript 校验的位置 |
| `2026-10-02-recovery-review-parent-entry` | 对实际恢复提示补丁未发现具体缺陷；主助手复查 diff 与定向结果后采纳 | 仅覆盖附带片段，不代表整体 schema 升级或文档全部取得独立审查 |

原始回复与 manifest 位于 `.catpaw/discussions/phase3-claude/`，
以表中轮次名为前缀；不能把顾问判断当作用户授权或测试回执。

## 文档校准与证据

README 中英文、工具文档、Web README、本地 AGENTS 和 init/onboard Skill
已按现有实现校准五键配置、主体归属、digest 目录及 tracking 选择。
明确旧目录不迁移、MCP 无隐式绑定、GitLab 首次初始化尚缺适配；
没有将 Python 宿主的 GitHub 简写入口误改成 MCP 也可收字符串。
`todo_list`、`sync_fork`、`project_init` 的工具描述同步到实际行为。

专用本地检查将两份 README 的 YAML 示例交给实际 `parseConfig`，
并通过内存 MCP `tools/list` 核对描述，均通过。首次检查脚本因 Windows
动态 import 使用裸绝对路径而在读取夹具前失败；转换 file URL 后通过，
这是脚本问题，不是业务测试失败。结果与文档指纹：
`.catpaw/discussions/phase3-claude/2026-10-02-schema-guidance-check.json`。

`AGENTS.md` 被现有 `.gitignore` 忽略，本地说明已修改但不进入普通 git diff；
未更改忽略规则，也未强行加入版本管理。

## parent 公开入口方案（确认前历史）

本节记录提出方案时的事实和建议，不是当前待决项。用户随后明确同意，
公开入口已接通；最新审查、并发提示修正和验证见末节。

已核实的场景：首次 `project_init` 保存 `parent.unknown`；
`repo_config` 只读配置或更新 tracking；`sync_fork` 拒绝未知 parent。
`refreshParentRelation` 只有内部实现和测试调用，不在公开工具注册中。
实际 `tools/list` 返回 80 个工具，没有 parent 刷新入口。
2026-09-30 进度也曾明确留待确认，该缺口没有因内部测试通过而完成。

提出时尚未实施的推荐方案：

| 场景 | 拟采用行为 | 备注 |
| --- | --- | --- |
| 用户要求核实当前项目从哪里 fork | 独立 `parent_refresh(repo)`，复用现有 helper | repo 是完整对象；不在 init、查看配置或同步时偷偷刷新 |
| 成功确认直接来源或明确不是 fork | 更新本地 parent 和关系核实时间 | 不同步代码，不改 tracking、项目生命周期或 Todo |
| API 返回但关系证据不足 | 返回明确的 unavailable 状态，保留原快照与原时间 | 不能读成“没有 parent”或“本轮重新确认了旧关系” |
| 请求失败、身份不符、并发冲突 | 返回错误，不覆盖原配置 | 不吞错，不静默降级或自动重试 |
| 已归档的已初始化项目 | 允许用户明确要求的配置维护，不恢复项目 | 沿用既有契约，不另增归档禁令 |

拟议响应为 `structuredContent` 中的
`{schema_version: 1, repository, status, parent}`，附可读文字；
`status` 为 refreshed/unavailable，`parent` 保留其已有状态对象，
仅 confirmed 时其中的 `repository` 为完整三字段对象。
不新加原因枚举或持久字段；传输/请求错误仍使用普通 MCP 错误结果。
顾问倾向这一独立入口，主助手采纳为建议，**尚待用户确认公开行为**。
不是“Claude 同意便可开发”。

确认后最小验证应包含公开参数与响应、GitHub-only 拒绝、未知和不可见关系、
未初始化不建目录、归档不恢复、自引用、网络/身份失败与并发更新保全。
私有 GitLab 的实例级凭据来源和 Windows 检查超时保证是另两项原有待决事项，
本轮未替用户接受，也未改失败断言。

## 恢复提示批次收尾状态（历史）

本轮测试与两次 Claude 调用均已结束。按本轮脚本和测试临时目录标记
检查本机进程，未发现匹配的遗留 Node/Claude/命令进程；此为限定范围检查，
不是对整台机器所有进程的声明。
工作区仍为 main，相对本地 origin/main ahead 10；无本项目提交或推送。
未执行 setup、切换运行时、操作活动 `.contribbot`、写 GitHub，亦未完成、
取消或归档用户 Todo。goal 未完成；本轮有实际修复与验证，不标 blocked。

## 后续保全测试与用户决定

公开入口实施前，仅扩充 `project-parent.test.ts`，没有改业务实现或注册工具。
parent helper 从 7 项扩至 12 项，覆盖自引用、归档不恢复、未初始化不建目录、
不支持实例，以及 unknown/none/confirmed 三种旧快照在证据不足时的字节保全。
网络失败与身份变化也核对 config 字节及目录条目没有变化。

实际组合结果为 parent 12、配置 48、项目入口 8，共 **68/68 通过**，
0 失败、0 跳过；MCP 类型检查和 `git diff --check` 通过。
原始结果为 `.catpaw/discussions/phase3-claude/2026-10-02-parent-preservation-tests.json`。
它与此前 211 项有重叠，不累计，也不声称此前 Claude 审查覆盖了新增测试。

用户随后回复“同意”，按最近提出的独立 `parent_refresh` 公开方案继续实施。
上节“待确认”保留为提出时的历史状态；当前只解除公开关系刷新入口的待决项，
不扩大为接受 Windows 超时保证、私有 GitLab 凭据来源或整体用户验收。
当时公开入口及其回归尚未完成；下节记录其后已发生的实施与验证。

## parent 公开入口最终复核与验证

独立 `parent_refresh(repo)` 已注册并导出，复用原关系刷新 helper，
要求显式完整 `{platform, instance, path}`。只允许已初始化的 GitHub.com
项目；可靠证据才更新本地 parent，归档项目不恢复。
不初始化、不改 tracking/lifecycle/Todo、不同步代码或写远端。
响应仍为 `{schema_version: 1, repository, status, parent}`，不新增持久字段。

沿原生 Claude 会话 `0e4058f9-0d2b-423c-838b-eaa1bc6e13b2`
完成两次工具禁用的只读审查，均正常退出、所附快照在调用期间无漂移。
顾问没有运行测试，也没有取得严格读取隔离。

| 复核项 | Claude 意见与主助手处理 | 备注 |
| --- | --- | --- |
| F1：unavailable 的并发提示 | 初审指出旧句错误地承诺旧快照与磁盘“未变”；复现后顾问撤回重新 load 建议，认可精确文案修正 | 并发成功写入和配置字节保留，不是丢失更新；重读也不能保证返回时磁盘一致 |
| F2：私有 instance 路径中的 Markdown 字符 | 主助手核实本入口在读取或格式化前拒绝非精确 GitHub.com，顾问认可本入口不可达 | 其他展示工具未因此被证明安全，留待另案复核；本轮不收紧身份接受集 |
| F3/F4/F5 | 重复解析、转换提示为可选建议；远端身份严格相等是既定行为，均未改动 | 不将顾问可选建议扩成用户待决或实施范围 |

唯一跟进业务修改是 unavailable 的说明：

```text
Parent relationship was not reverified. This request did not update the local config. The returned snapshot was read before the query and is not fresh evidence.
```

它只陈述本请求未写入、返回查询前快照和旧时间，不宣称该快照在响应时仍是
最新磁盘状态。跟进审查发生在替换前，但 prompt 包含最终采用的精确新句；
因此是入口有限静态审查及精确修正方案复核，不是顾问重测或再次审查最终源码。

| 检查 | 实际结果 | 备注 |
| --- | --- | --- |
| 最初公开入口 RED/GREEN | 6 通过、14 失败，随后 20/20 通过 | 使用临时 HOME 和模拟 GitHub；保留原失败报告 |
| 新并发文案 RED/GREEN | 1 失败、20 未选中，随后 1 通过、20 未选中 | 同一交错下成功写入保留；未选中不是运行后通过 |
| 最后受影响回归 | 8 文件、143/143 通过，0 失败、0 跳过，退出码 0 | 包含入口 21、parent 12、配置 48、项目初始化 15、注册 19、身份 15、同步 5、配置工具 8 |
| `pnpm typecheck` / `pnpm build` | 五包类型检查及 workspace 构建通过 | 调用均已结束，不等于 setup 或激活当前 MCP |
| 构建产物探针 | 导出、类型声明、内存 tools/list 与 schema 检查通过 | 81 个工具且恰好一个 parent_refresh；必填完整身份，无项目数据创建 |
| 候选核对与空白检查 | 构建探针所附五份源码摘要与当前文件一致；`git diff --check` 通过 | 探针临时 HOME 已删除；未改变 Git 行尾配置 |

最新 143 项已包含入口 21 项及并发用例，与此前 211、68、142 项有重叠，
不累加为新的全量总数。原始文件均在 `.catpaw/discussions/phase3-claude/`：

- `2026-10-02-parent-entry-implementation-review.response.md` 及对应 manifest
- `2026-10-02-parent-snapshot-review.response.md` 及对应 manifest
- `2026-10-02-parent-entry-snapshot-red.json`
- `2026-10-02-parent-entry-snapshot-green.json`
- `2026-10-02-parent-entry-snapshot-regression.json`
- `2026-10-02-parent-entry-dist-check.json`

最新业务源码 SHA-256：
`7cbe8c1b95fa0a2708f6f93302bbf185f0be3cf002d19d86f8949fc6a6915dc5`；
入口测试 SHA-256：
`f3476273b6748fcbe7fb30a4ee1ff189be4f02ff0c9d9aa10c3069d4010227b6`。
构建探针只列工具，不调用 parent_refresh 或真实远端。
真实 GitHub 的可见/不可见关系、最新候选全量回归与用户验收仍未完成。

本轮测试、构建及两次 Claude 调用已结束；没有提交、推送、setup、
切换运行时、操作活动 `.contribbot` 或写 GitHub，也没有改变用户 Todo。
23:54 按本轮审查、探针及测试标记查询，未发现匹配的遗留执行进程；
此为限定范围检查，不是对其他任务或整台机器的判断。
整体 goal 保持 active、未完成；Windows Todo 命令超时承诺和私有 GitLab
首次初始化的实例级凭据来源仍各自待用户决定，不由本次同意代替。
