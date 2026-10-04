# Schema v3 整体升级验证

## 2026-10-04 当前候选结论

用户已批准四处公开响应身份修补，当前候选已实施：

- Todo 工作流的 `todo_context`、`todo_operation` 和 `todo_cancel` 返回完整
  `{ platform, instance, path }`；
- `project_status` 新增完整 `repository`，保留面向人的 `repo` 文本；
- 配置结构、存储、Todo 生命周期和归档规则未改变。

新增响应身份回归 **12/12**、MCP 工作流回归 **14/14**，workspace build 和五包
TypeScript 类型检查通过。当前候选 MCP 全套 Vitest 为 **94 文件、1390 通过、
2 跳过、0 失败**；Runner CLI **9/9**、Runner Vitest **13/13**、Web **10/10**，
Python 测试使用临时 `UV_CACHE_DIR` 后 **118/118 通过**。
此前候选的 `checks.test.ts:410` 执行层超时清理失败及随后 **1/1** 独立重跑结果
仍保留为历史证据，不把历史失败抹掉，也不影响当前候选全量通过结论。本轮未新增
独立 Claude 审查，修复依据此前已完成的讨论和用户批准，不把旧讨论当成本轮新回执。
整体 goal 仍 active，用户实际验收尚未完成。

下方 10 月 3 日内容保留为对应时点的历史证据，不再表示当前修补待确认。

## 10 月 3 日待决状态（历史）

21:30 自动续行核对源码，四处公开返回缺口仍在，用户尚未确认修补范围。
同一待决已连续多轮；目标状态工具实际返回 Codex goal 为 blocked，停止自动空转。
本轮未改业务代码、重跑测试或重发顾问。整体升级未完成，Todo 状态不变；
下方 active 及通过结论均保留为对应时点、对应候选的历史记录。

## 21:10 当前候选定向结果

当前 `0c58cdb...` 候选实际完成已有身份与配置定向回归：
20 文件、366 通过、0 失败、0 跳过；五包类型检查也退出 0。
两组 21:08:51 启动，分别于 21:09:05 和 21:09:12 结束，
完整 344 路径候选前后一致、`sourceDrift: []`。
回执为讨论目录 `2026-10-03-gitlab-{regression,typecheck}-current-baseline1.*`。

没有修改业务代码或正式测试。已有用例未断言新发现的公开返回身份字段，
因此这些通过不表示四处缺口已修复，更不表示当前候选全量通过。
用户尚未确认修补范围；没有新跑全量、构建或真实使用验收。

## 21:00 新鲜度订正

下方“最终候选”是早晨执行时的历史候选，不是当前工作区验收结论。
按原验证器范围完整枚举，当前 344 路径候选为
`0c58cdb31b9d80372e890005888fa48fbd87a8eccb83d8ae1d03f02996397b4c`；
与早晨 `976837...` 回执有 42 条路径字节不同，无新增或缺失。
原回执的 `sourceDrift: []` 只覆盖该次运行前后，不覆盖后来的源码提交。
下午 1377 通过目前保留为已提交日报的原执行报告，本次未读回独立完整日志。

当前已复现 Todo 公开返回路径字符串及 project_status 缺完整 repository 两类缺口，
两轮 Claude 讨论已返回，修补范围待用户确认；详见
[公开返回身份复核](2026-10-03-public-response-identity-review.md)。
本轮没有修改业务代码或重跑全量；修补后须为新候选取得新的完整验证。
本表历史结果不改写为失败，也不能用它宣布当前版本已完成。Goal 仍 active，
用户尚未整体验收。

## 早晨候选摘要（历史）

日期按 Asia/Shanghai。当时状态：该候选的自动验证已全部结束并通过；用户尚未
进行人工验收，因此不是完成声明。最终候选为 `97683767294420ff07dfe6a6fc1209a899b151a160d455773949f6b0d41c0c12`，
覆盖 344 个源码、Skills 和根依赖路径，所有 final-current 回执均为 `exited`、
退出码 0、`sourceDrift: []`。历史失败回执继续保留，不被改写。

## 当前最终候选结论

分支 `main`，HEAD `49a0d9055a24bc2619ab0cec37aa9d795924d0af`，相对本地
`origin/main` 领先 10 个提交。最终候选使用临时 HOME/USERPROFILE 和空凭据绑定，
只执行合成夹具，没有安装依赖、访问真实凭据、连接真实平台或写入远端。

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| 根 `pnpm test` | 93 个文件；1376 通过、2 跳过、0 失败；退出码 0 | `gitlab-root-final-current1`，07:46-08:05，候选前后相同 |
| Python | 118/118；退出码 0 | `gitlab-python-final-current1`，与同一候选绑定 |
| 五包 TypeScript 类型检查 | 通过；退出码 0 | `gitlab-typecheck-final-current2` |
| workspace build | 通过；退出码 0 | `gitlab-build-final-current3` |
| Runner | CLI 9/9、Vitest 13/13 | `gitlab-runner-final-current4` |
| Web | 10/10 | `gitlab-web-final-current5` |
| stdio 启动 | 无凭据通过；假凭据 6/6 | `startup-dist-final-current6/7`，只用合成凭据与响应 |
| 执行 smoke | 构建态 28/28；源码 Skill 入口 28/28 | 两个入口覆盖相同场景，不累计为 56 个独立行为 |
| 文档 guidance | 通过；检查 105 个本地链接目标 | `gitlab-guidance-final-current10`，不检查渲染、fragment 或远端 URL |

以上结果证明当前候选在隔离的自动验证范围内通过，不等于真实私有 GitLab、真实
外部仓库读写、所有 Windows 后代进程停止能力或宿主已加载新构建。用户人工验收、
真实平台流程和跨运行环境验证仍未完成。Goal 保持 active，不自动完成、取消或归档。

### 当前只读审查的后续风险

Claude 沿原会话在北京时间 08:26-08:29 完成最新有限源码复核；输入为 41 份源码
和 3 份契约文档，未执行测试或访问真实项目。它确认三处此前修补已生效，没有发现
本批自动验证阻断，但记录了四项后续风险：

| 风险 | 当前判断 | 备注 |
| --- | --- | --- |
| tracking 较慢时终止错误文案可能夸大“未 settle” | 低风险，行为状态不变 | `blocked`、`process_stopped:false`、`unknown` 和禁重试契约未受影响 |
| `upstream_daily` 的 commit 表仍手工拼接 | 低风险，未在本轮复现 | commit message 含 `|` 时可能破坏表格，未扩大本批修复 |
| TypeScript/Python 仓库身份规范化缺少同源对拍 | 待补验证 | 默认端口、尾斜杠等边界可能产生 digest 分叉，未取得失败样本 |
| pending 夹具的 finally 等待没有独立上限 | 测试健壮性缺口 | 当前未复现挂死，不改变生产停止策略 |

这些是后续风险和验证建议，不是本轮自动测试失败，也没有据此擅自修改业务代码。

## 候选与范围

分支 `main`，HEAD `49a0d9055a24bc2619ab0cec37aa9d795924d0af`。
06:02-06:22 根测试覆盖 344 路径源码、Skills 及依赖配置，候选 SHA-256 为
`762f947467da3b4c8f49428610d06d196fa65eecd428e9c67a85e1c48fe256ba`。
与本日此前 `928141be...` 候选相比，仅 `checks.test.ts` 内容变化；
生产停止实现和其他业务源码没有变化。文档及忽略的构建产物不在该摘要中。
审查返回后仅在测试的 `import type` 加入已导出的 `CheckRunResult`，没有
改变运行时导入或断言。当前候选为
`035f17e23059d24a86ec2e02d49f9c68b24be7661da71cc58f0c2f630c7d5703`，
仍为 344 路径。新回执使用 `stop-final2`，不覆盖失败的 `stop-final1` 类型检查。

已批准契约见 [schema v3](../plans/2026-09-29-project-config-contract.md)、
[Windows 停止边界](2026-10-03-windows-stop-contract-review.md)。
本轮不做旧数据迁移、不切换宿主运行时、不访问真实凭据或私有平台。

## 早期候选验证（历史）

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| 根 `pnpm test`，`stop-final1` | 06:02:28-06:22:02，退出码 0 | `762f9474...`；使用隔离 HOME；前后完整候选相同、无源码漂移 |
| MCP | 93 文件通过；1374 通过、2 跳过、0 失败 | 上一行根测试的一部分，不重复累计 |
| 包边界、开发脚本、数据重置 | 11、44、12 项通过 | setup/reset 只操作测试夹具，不修改真实配置或数据 |
| Platform、Agent Runtime、Core | 2、17、19 项通过 | 根测试的一部分 |
| Runner、Web | CLI 9、Vitest 13、Web 10 项通过 | 本次根命令实际执行完成，不是沿用此前补跑 |
| 五包类型检查，`stop-final1` | 退出码 2 | `762f9474...`；缺失类型导入的原失败保留 |
| 五包类型检查，`stop-final2` | 退出码 0 | `035f17e...`；补类型导入后实际重跑，无源码漂移 |
| Python，`stop-final2` | 118/118，退出码 0 | `035f17e...`；包含 TS/Python 共用身份 fixture 的已有用例 |
| 根 `pnpm test`，`stop-final2` | 早期记录为进行中 | 后续 `final-current` 已结束并通过；本行保留历史状态 |
| `git diff --check` | 退出码 0 | 只检查补丁空白，不替代编译或业务验证 |

两项平台相关跳过分别是 `candidate.test.ts` 的非 Windows executable-bit
检查和 `upstream-sync-check.test.ts` 的 linked history file 检查。
本轮没有新增跳过，也没有把此前两项 Windows 迟到写入失败改写为通过：
用户批准改变验收契约后，新测试验证终止请求及回执顺序，
保留 `blocked`、`process_stopped:false`、operation `unknown` 与禁止自动重试。

原始材料位于 `.catpaw/discussions/phase3-claude/`：
`2026-10-03-gitlab-root-stop-final1.receipt.json` 及同前缀 stdout，
`2026-10-03-gitlab-typecheck-stop-final1.receipt.json` 及同前缀 stdout。
完整枚举审计为 `2026-10-03-schema-candidate-audit-pre-fix.json`；
其中根状态是审计发生时的 running，根最终结果以已结束回执为准。

## 既有结果

以下为 2026-10-03 较早的 `928141be...` 候选结果，不冒充本阶段重跑。
完整路径审计确认其后只有停止测试文件变化；这些检查所用的业务代码没有变化。

| 检查 | 已读取的历史结果 | 备注 |
| --- | --- | --- |
| GitLab 定向 | 365/365 | 假 token、模拟响应；与根测试有重叠 |
| Python | 118/118 | 同一套测试在最新候选又实际运行通过，见上；不是额外 118 个行为 |
| workspace build | 退出码 0 | 不代表宿主已加载新版本 |
| stdio | 无凭据两组、假凭据 6/6 | 模拟 fetch 没有网络 fallback；夹具初次失败另存未覆盖 |
| 执行 smoke | dist/source 各 28/28 | 同场景两个入口；合成用户决定，不是人工验收 |
| 文档解析及本地链接 | 通过 | 文档后续有更新，应再核对；不覆盖渲染、fragment 或远端 URL |

原根 `final1` 的 1372 通过、2 失败、2 跳过及退出码 1 永久保留为历史事实。

## 审查与限制

Claude 沿原会话的 `2026-10-03-schema-final-review` 于北京时间
06:09:48-06:28:40 实际完成，输入 41 份相关源码和 3 份契约文档，
模型工具禁用，原生 session 一致，退出码 0、源码与材料无漂移。
原回复为同前缀 `.response.md`，manifest 保存所读文件的 SHA-256。
它没有执行测试，也没有审计未附的所有源码或真实项目数据。
审查读取的是 `762f9474...` 快照；随后类型导入修改正是其明确建议的单行修正，
主助手核对并重跑类型检查，不声称 Claude 已再次读取修改后的整份候选。

| Claude 意见 | 主助手核实 | 处置与备注 |
| --- | --- | --- |
| 测试缺少 `CheckRunResult` 类型导入 | 最新类型检查确实 TS2304，导入的类型已由同模块导出 | 已修正并重跑通过；不涉及新停止语义 |
| Python 没有共用身份 fixture | `test_repository_protocol.py` 已加载同一 `repository-key-v1.json`，逐项验证规范化、digest 和拒绝值；最新 Python 118/118 通过 | 不采纳该缺口判断；不能因审查材料未附 Python 测试就认定测试不存在 |
| 非 GitHub 来源链接使用 GitHub 路径 | 对合成 GitLab 来源实际调用 list/detail，分别得到 `/releases/tag/v1` 与 `/pull/7` | 展示缺口已复现；索引及配置字节保全、fetch 零次，未验证任何真实站点 |
| config 在查看后、更新前消失时产生 TypeError | 在临时项目的 update 前精确删除 config，真实 update 返回 null，公共入口报读取 tracking 的 TypeError | 错误提示缺口已复现；没有重建 config、保留追踪索引并释放锁；不是生产并发频率测试 |
| Issue 标签竖线破坏表格 | 合成标签 `ui\|bug` 进入真实记录器，输出未转义 `ui\|bug`，两列行出现四个分隔符而不是三个 | 已复现；该手写表早已存在，不把它伪装成身份升级引入的数据损坏 |
| pending 夹具 finally 的等待没有独立上限 | 未复现挂死；本日实际测试已运行通过，不能据此保证所有调度下无挂起 | 记录为测试健壮性风险；不擅自增加超时政策或改变停止实现 |

三处展示/诊断复现的完整原值及 SHA 保全在
`2026-10-03-schema-review-findings.json`，同名 `.mjs` 是一次性隔离探针。
探针退出码 0 表示按预期复现缺口，不是这些行为测试通过；夹具保留，
没有真实凭据、网络 fallback、真实项目操作或业务源码修改。

GitLab 官方 Releases 与 Merge Requests 文档的页面示例使用 `/-/releases/...`
和 `/-/merge_requests/...`，与当前输出的 GitHub 路径不同；这只支持
“当前不能按 GitHub 规则生成 GitLab 链接”的判断，不证明某个私有部署的实际响应。
参考文档为 `https://docs.gitlab.com/user/project/releases/` 与
`https://docs.gitlab.com/api/merge_requests/`。

主助手建议在本批余项中把非 GitHub 追踪版本/PR 先显示为普通文本，不新增 GitLab
远端能力或推断 PR 实际目标；配置消失时给出明确错误，Issue 表格复用既有转义器。
这是待用户确认的修补范围，尚未实施；不因顾问写“无需新决定”就替用户扩大范围。

真实私有 GitLab 部署、代理行为、慢或大响应体、跨操作系统行为仍有验证缺口。
停止请求不保证终止窗口零写入，也不证明所有脱离的后代进程已经停止。
当前自动验证已经收回并通过。下一步是用户按真实使用流程进行人工验收；若要处理
上面的后续风险，应单独确认范围、先讨论再实施。继续保留真实私有 GitLab、外部仓库
读写、跨平台和宿主加载新构建等验证限制。不提交推送，不完成、取消或归档用户 Todo；
整体 goal 保持 active、未完成。
