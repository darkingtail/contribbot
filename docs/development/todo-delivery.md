# Todo 本地交付与 PR 进度

状态：D 批 PR 关联、独立进度、本地交付及显式远端交付核验已实现，
固定最终源码的完整 MCP 回归、构建 smoke 与独立窄范围复审已完成。
后续 C/B/D 与六态最终整合结果见 [当前审计](todo-cbd-audit.md)：
63 文件、902 项通过、1 项 Windows 跳过，构建后 28 场景通过。
下文 D 切片当时结果为 58 文件、744 项通过、1 项 Windows 跳过，构建后 22 场景通过；
后续真实 `gh` 后端四个只读场景及源码 Skill 的 22 场景也已通过；
不代表跨平台、真实宿主用户验收或整个 Todo 已完成。
本文按实施顺序保留历史结果；D 的行为见末节“D 增量：远端交付核验”。
历史 `not_planned` 恢复和旧状态迁移提案已被用户“不用兼容”决定取代，
当前不再支持旧 Todo 状态，不将历史提案当成新的实施或验收要求。
关联目标与待决项见 [生命周期与交付设计](../plans/2026-09-18-todo-lifecycle-delivery-design.md)。

## 当前实现

| 行为 | 结果 | 备注 |
| --- | --- | --- |
| `todo_update(pr)`、关联 Todo 的 `pr_create` | 追加 PR 关联，不自动改变 Todo 主状态 | 显式状态更新仍经过原门禁；不新增终态编辑权限 |
| 多个 PR | 保留 `{repo, number}` 数组，按不区分大小写的仓库及编号去重 | 不把同编号的跨仓库 PR 合并 |
| 旧单值 `pr` | 读时派生关联；新关联时保留原值代表的关系 | 仓库来自显式解析的 canonical repo，不推断 fork；不在读取时迁移 |
| `todo_list` | 各主状态表展示所有关联 PR，不查远端 | 关联不表示必需交付或已经验收 |
| `todo_detail` | 独立展示 draft/open/closed/merged/unknown、观察时间和来源 | 瞬时只读观察，不保存成验收证据；用户文档仍完整保留 |
| 远端不可用、无权限或响应编号错误 | 显示 unknown | 不展示原始错误，不把失败当作 PR 已关闭 |
| 查询时 Todo 变化 | 根据稳定 ID 重读；新增关联显示尚未观察 | 不用旧列表编号把另一个 Todo 的状态拼进结果 |
| 远端读取数量 | 一次最多 20 个，最多 4 个并发 | 其余显示未读取；不推断结果，不自动产生后续网络任务 |
| managed 文档投影 | 展示完整仓库关联清单，并单列兼容 `pr` 镜像 | 镜像可能重复表内项，不猜仓库、不多算 PR；不写入远端进度缓存 |
| Web API | 保留多 PR 原始字段与独立 Todo 状态 | 本批未增加 Web 远端进度界面或浏览器验收 |

可选 `pull_requests` 使用严格结构校验，拒绝未知字段、非正安全整数编号和
不合法的仓库标识；不把不合法新字段静默丢掉再写回。
无此字段的历史数据不补默认值，旧计划摘要也不受此批影响。

`pr` 继续作为最近一次同项目关联的兼容值，不作为完成证明。
数组与旧值不一致时保留两边的关系并去重，读时来源于 scalar 的行明确标注 legacy。
此行为不是旧写入器兼容保证，不允许据此在同一数据目录混跑新旧运行时。

## 恢复保护

PR 请求仍遵循已有 `pending -> received -> linked` 远端日志。
关联写入在原 Todo 锁内完成；已关联请求重放只读，不能覆盖较新关联或改变主状态。
请求停止后到达的原远端结果可以入账，但不意味着新请求得到授权。
`todo_update(pr)` 不能替代原 `pr_create` 请求的恢复，也不能清除 pending 日志。

旧 `not_planned` 的中断收尾重试保留原始元数据：
若重试只携带相同的旧 PR 编号，不为它补写数组后再尝试归档。
该回归在本轮测试中实际发现并修复，原恢复门禁未放宽。

## 设计讨论

Claude round-108 成功延续既有长期会话；本轮是设计第二意见，不是源码验收。
主助手采纳严格校验、独立观察、并发限制、错误隔离与稳定身份复核。
未采纳“数组存在时忽略不在数组中的 scalar”建议，避免丢失旧关联。
也未采纳“旧写入器必然删除数组”的未验证断言。
round-109 针对文档遗漏继续咨询，采用中性的兼容镜像提示，
避免仅按编号去重而隐藏其他仓库的同号 PR。

这些关联没有 required/optional、目标分支或验收结论，不会隐式加入完成门禁。
来源 Issue/PR、参考 PR 与必需交付仍是不同含义；没有 PR 的 Todo 仍可存在。

## 验证记录

| 检查 | 当前结果 | 备注 |
| --- | --- | --- |
| 初始关联 RED | 19 项，6 通过、13 失败 | 两项终态编辑测试超出原接口范围，改为断言拒绝且不写入；其余捕获旧自动状态/单值/编号行为 |
| 首次关联 GREEN | 19 项通过 | 覆盖新旧 PR 保留、去重、显式状态、迟到及重放 |
| 扩展定向回归 | 149 项中 148 通过、1 失败 | 失败为上述旧停止/归档恢复回归，不改写成全绿 |
| 修复后窄范围复测 | 31 项通过 | 完成/归档生命周期与 PR 关联 |
| 展示与严格结构校验 | 15 项通过 | 已包含在扩展回归的通过项；没有单独证明这 15 项的修改前 RED |
| 文档兼容关联 RED/GREEN | 修改前 3 失败、5 通过；修改后 8 通过 | 独立审查 P2：scalar-only 关联漏显 |
| 文档修补后定向回归 | 30 项通过 | 新兼容投影、既有投影恢复、PR 进度 |
| 文档修补前完整 MCP | 52 文件，634 通过、1 Windows 跳过，335.98 秒 | 已实际完成；不冒充最终修补后的全量结果 |
| Web API | 1 项通过 | 临时目录启动真实 HTTP 服务，验证多 PR 字段不丢失；不是浏览器视觉验收 |
| TypeScript、构建 | 通过 | 构建不等于安装/启用运行时 |
| 独立窄范围复审 | 无剩余发现，18 个实际渲染内存探针通过 | 不替代全量/磁盘/宿主验收；主助手已复现并修复 P2 |
| 最终全量 MCP | 53 文件，642 通过、1 Windows 跳过，337.61 秒 | 固定最终源码重跑；跳过的是未暂存可执行位变化 |
| 最终构建后 CLI/MCP | 19 个场景通过 | 包括跨进程重启后多 PR 保留且不改变生命周期；无真实 GitHub 请求 |

本轮最终命令：

```text
pnpm --filter contribbot-mcp exec vitest run --maxWorkers=4
pnpm --filter contribbot-mcp exec tsc --noEmit
pnpm --filter contribbot-mcp build
node packages/mcp/scripts/execution-smoke.mjs
node --test packages/web/server.test.mjs
git diff --check
```

所有测试使用隔离临时数据和 GitHub doubles；构建后关联 smoke 不进行网络请求。
不涉及真实 GitHub PR、用户 `.contribbot` 数据迁移、跨平台实际验收或用户产品验收。

独立审查 actor 为 `01a0b580-f4bb-7b91-85db-a441210544b5`，采用
`no-write requested + audited`，不是强制文件系统只读隔离。
受检源文件的前后 SHA256 已核对；主助手修改的恢复与投影补丁单独复审。
最终渲染器 SHA256：
`c3875d7e0de406e0051efded28ffd3e96d17f2d0c4d74e0c303d483753477c59`。

当前固定源码快照（不是 Git commit）：
`packages/mcp/src` 与 `packages/mcp/scripts` 共 147 个文件，
SHA256 `2dc5fff95e8ca5507a7a99c4951d8977abebe0e89eece5a357055075e3efa543`，
观测时间 `2026-09-18T18:49:34.623Z`。
算法为按正斜杠相对路径排序，将每个 `path + NUL + sha256(fileBytes)`
以 LF 连接后再求 SHA256；不包含生成的 dist、文档、Skills 或 Web 文件。

普通 contribbot 自跟踪 Todo 已更新进度和证据，不自动完成或归档。
CatPaw 看板仍有此前的 5 项校验错误，未绕过其校验写入 Work。
未提交、推送、重启正在使用的 MCP、安装运行时或迁移真实数据。

## 剩余范围

本表为 PR 关联切片结束时的阶段快照；本地及远端增量的后续实现见下文，
不能将历史“尚未实现”当作最新状态。

| 范围 | 下一步 | 备注 |
| --- | --- | --- |
| 显式交付约定 | 本地 workspace/file 增量见下文；继续远端终点 | 复用现有 acceptance，不增设第二个测试通过真源 |
| 交付观察与当前候选的关系 | 区分历史远端事实和当前验收适用性 | 不能抹去旧 merge，也不能用它证明新代码已交付 |
| 远端完成证据 | 2026-09-19 用户已确认：报告先记为待核实，查询确认后才满足交付条件 | 产品决定已明确，远端端点与证据机制仍未实现；不是自动完成授权 |
| B 边界 | 保留 prepared Issue 取消、未知远端结果的未决门禁 | 不将它们暗中改成取消成功 |
| 自动完成与枚举迁移 | 本批不启用、不移除旧值 | D 全体验证后再讨论迁移；不自动取消或归档 |

## D 增量：本地交付声明

在上述关联切片之后，继续实现本地交付与现有验收的连接。
Claude round-110/111 均成功延续原会话；主助手取舍记录在
`.catpaw/discussions/phase3-claude/round-111.coordinator.md`。
以下不是远端交付模型的完成声明，旧枚举与真实数据不迁移。

计划增加可选 `deliverables` 数组，不为历史计划填默认值，不从关联 PR 推断要求。
每项包含 `id / description / required / acceptance_ids / target`，
连同目标、范围、验收与覆盖声明一起参与摘要，用户看到具体要求后确认精确版本。
改变交付要求必须形成新计划，而不是编辑历史或用完成备注悄悄缩小目标。

| 目标/行为 | 实际契约 | 备注 |
| --- | --- | --- |
| `workspace` | 可定位的当前候选，引用至少一项必需验收 | 不要求新增文件或相对 baseline 存在差异；实际可接受性由验收判断 |
| 必需 `file` | 计划范围内的精确相对文件路径；至少一项必需 manual/review | 现场候选须含非删除的常规文件，存在不等于内容通过 |
| 可选交付 | 展示文件与关联验收事实，但不增加完成门禁 | 被引用准则若本身 required，仍按既有规则要求通过 |
| 可选验收引用 | 缺失、失败或回执无效如实展示 | 不把 optional 变成 required；回执无效不展示 passed |
| 同名文件被忽略/删除 | 不视为当前候选中的交付文件 | 可以交付受捕获文件或重新确认计划；不自动改 gitignore/暂存/提交 |
| 未传现场清单 | 明确 `not_observed`，不伪称文件不存在或已经交付 | 清单与候选身份不匹配则直接报错 |
| `context/resume` 与文档 | 只显示 `delivery_requirements` 和声明 | 不捕获文件，不输出假定的现场通过状态 |
| 本地 `inspect` | 分别显示端点 `present/missing/not_observed` 与关联验收 | 复用现有候选、计划、attempt、epoch 及原始回执核查 |
| 完成收尾 | prepare、prepared 重试及 finalize 重新捕获候选并核验 | 收尾报告保留具体清单、交付观察和原验收回执 |
| 已完成重试 | 返回原结束事实，不重跑、不改历史 | 完成后删除文件不会把历史 done 自动改回 active |

必需端点未达成时，`delivery:<id>` 对 `verified` 和 `with_gaps` 都是硬前置；
不能将它塞进 `acknowledged_gaps` 豁免。已存在的产物若缺少验收证据，
仍按既有规则保留 `acceptance:<id>` 等验证缺口，由用户明确决定是否受限完成。
`stopped` 不要求产物或验收通过，但原进程、操作、控制与远端对账门禁继续有效。
这区分了“根本没有交付约定产物”和“产物存在但验证不完整”。

本地门禁复用 `verifyReadiness`；`workflowReadiness` 仍只计算存储状态中的验收覆盖，
不能单独作为文件已经交付的证明。文件清单来自实际本地调用者已捕获的快照，
不是从报告自由文本、历史 PR 状态或猜测的 artifact 路径取得。
源码未开放远端 target，提交此类声明会被严格 schema 拒绝。

### 本轮验证

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| 最初定向 RED | 23 项中 16 失败、7 通过 | 主要失败为旧 schema 不支持 deliverables；不冒充旧版可接受声明却跳过门禁 |
| 首次实现回归 | 60 项中 59 通过、1 失败 | 失败是新增夹具第二次 yield 未列出已有操作；修正夹具，不放宽安全规则 |
| 修正及扩展后的交付回归 | 25 项全部通过 | 覆盖缺失、删除、忽略、可选、陈旧报告、暂停恢复、收尾重试、旧计划 |
| TypeScript、构建 | 通过 | 源码构建不等于运行时已安装或连接已刷新 |
| Web API 回归 | 1 项通过 | 非浏览器视觉验收 |
| 构建后 CLI/MCP | 20 个场景通过 | 新增跨进程重启后声明保留、缺文件拒绝及补齐后重新验收完成 |
| 独立窄范围复审 | 无可操作发现，内存探针通过 | 回执校验器与 I/O 使用替身；不是磁盘/跨平台或远端验收 |
| 全量 MCP | 54 文件通过，668 项通过、1 项 Windows 跳过，344.04 秒 | 固定本轮最终源码；跳过的是未暂存可执行位变化 |

新增 Issue 联动用例验证缺少必需交付时，在公开评论或关闭前拒绝，
包括用户把 `delivery:<id>` 放进 acknowledged_gaps 的情况。
这不消除既有异步边界：远端动作开始后发生本地变动，必须保留远端事实，
本地最后收尾拒绝并走原恢复路径，不能把“预检通过”当永久新鲜度保证。

独立检查 actor 仍为 `01a0b580-f4bb-7b91-85db-a441210544b5`，没有参与本切片实现。
采用 `no-write requested + audited`，不是沙箱强制只读。主助手核对
contracts/workflow/verification/closure/local/control/todo-projection 七个实现文件的
前后 SHA256，均保持一致。已运行的磁盘测试与构建 smoke 由主助手单独负责，
不把独立内存探针说成真实文件系统验证。

本切片受检源码快照（不是 Git commit）：`packages/mcp/src` 与
`packages/mcp/scripts` 共 148 个文件，SHA256
`9ea14af93d7eae9c5ec688fe642480f6814caa5f8361c4dbc2562110172fb5c5`，
观测时间 `2026-09-18T19:22:13.077Z`；算法与上文相同。
未修改正在使用的 MCP 配置、安装运行时、迁移真实任务数据或提交推送。
已将本轮进度写回原自跟踪 Todo，不自动完成或归档；CatPaw 原看板错误没有绕过。

本轮实际运行命令：

```text
pnpm --filter contribbot-mcp exec vitest run src/core/execution/deliverables.test.ts --maxWorkers=1
pnpm --filter contribbot-mcp exec vitest run --maxWorkers=4
pnpm --filter contribbot-mcp exec tsc --noEmit
pnpm --filter contribbot-mcp build
node packages/mcp/scripts/execution-smoke.mjs
node --test packages/web/server.test.mjs
git -c core.safecrlf=false diff --check
```

文档相对链接检查通过。所有执行测试使用临时数据与隔离 Git 仓库；
线上 GitHub、macOS/Linux 及真实宿主对话仍未实测，脚本输入不冒充用户产品验收。

该快照之后的本地 commit 增量见下一节。剩余 D 范围仍包括 push、提交/合并 PR 等明确终点及其对象身份、
现场/报告证据适用性。仅有用户/宿主的合并报告是否可满足远端终点仍待确认；
本轮不暗中选择规则。B 的 prepared Issue 取消与不可恢复未知远端结果仍保留门禁。

## D 增量：本地 Commit 交付

Claude round-112/113 已延续原长期会话讨论，具体取舍见
`.catpaw/discussions/phase3-claude/round-113.coordinator.md`。
这部分实现只观察本地 Git，不创建 commit、不推送、不读取远端。
新目标仍引用既有 acceptance；提交事实和内容验收是两件事。

```json
{
  "id": "source-commit",
  "description": "约定源码和暂存区已对应当前本地提交",
  "required": true,
  "acceptance_ids": ["source-review"],
  "target": { "kind": "commit", "scope": ["src"] }
}
```

| 行为 | 契约 | 备注 |
| --- | --- | --- |
| 声明范围 | 非空、不重复的字面路径数组，必须位于计划范围内 | 不是 glob，不接受未来 SHA；确认前展示范围 |
| 提交对象 | 既有 candidate 中的 HEAD 和实际本地树身份 | 不另取可能移动的 HEAD；不要求必须产生新 commit |
| 对应关系 | 对比树、候选文件集合、index OID/模式和实际读取的字节 | 不能只用 status；检测 assume-unchanged 隐藏的修改 |
| 范围内未完成工作 | 未跟踪、未提交删除、暂存/未暂存差异均不满足 | 即使工作区还原到 HEAD，暂存区差异也不能忽略 |
| 范围外变更 | 可以保留，不要求整个仓库干净 | 验收仍绑定完整候选；新 commit 使原候选检查失效 |
| 已提交删除 | 可以满足 | 不要求范围必须还含文件；不是目录存在性测试 |
| 原始字节对应 | 先按实际对象格式计算 Git blob OID | SHA-1/SHA-256；已经精确相同不再执行转换 |
| 内置转换 | 使用当前 Git、有效属性及 builtin 配置，在独占临时仓库中计算 OID | 记录 Git 版本和配置；不声称提交内一定保留工作区原始 CRLF/编码 |
| 自定义过滤器 | 字节不同时标记 `not_observed`，绝不执行 clean/process | 可重新确认另一种人工/审阅交付约定；不是自动豁免 commit 要求 |
| Git 读取 | 所有候选及交付读取禁用 lazy fetch、replace、fsmonitor；剥离环境 GIT 重定向，禁止全部传输协议 | 旧 Git 不支持安全参数、对象缺失、stderr 报错或超限时保留未核验；退出码 0 不足以证明读取完整 |
| 当前性 | 比较前后原始属性来源摘要、有效属性/配置，并重新捕获完整候选 | 候选变化使整个检查报错，即使 commit 只是可选项 |
| 结束 | 沿用既有必需端点与原始验收门禁 | `with_gaps` 不能豁免未满足的必需 commit；安全停止不要求提交成功 |

临时转换仓库使用独立 HOME/XDG、空模板、禁用全局/系统配置和系统属性，
不复制源仓库配置、索引或可执行过滤器。输入为已经核对摘要的候选文件内容，
保留相对路径与原始属性文件，再交给 Git 解析；清理前验证绝对临时目录。转换或编码失败是未核验，
不把失败结果当作通过。Git 自身的转换行为可能随版本变化；提交后改变属性也可能
导致非精确字节路径无法核验，不能把这项限制说成原提交丢失。

被忽略且未跟踪的文件不在候选内，不纳入交付证明；符号链接、submodule、
非 UTF-8 路径及超限对象仍按现有或新增读取限制拒绝。观察不会证明远端已发布、
PR 已提交/合并，也不会自动完成 Todo。

属性文件不从 `check-attr` 的显示字符串重建：`text` 与 `text=set` 可以显示相同，
但转换含义不同。工具有界读取 system/global/info 与相关目录的原始属性文件，
缺少工作区属性文件时读取捕获的 index blob；保留宏、字面值、BOM 与路径匹配。
Git 官方随安装文档说明的优先级与索引回退，已用于核对这一路径；实际行为仍由 Git 执行。
单个属性文件最多 1 MiB、总共最多 8 MiB；相关属性文件含 skip-worktree 或
assume-unchanged 时保留未核验，不更改这些标记。普通源码文件的 assume-unchanged
仍通过实际字节检查，不用于隐藏变更。

源读取按既有规则剥离继承的 `GIT_*`，不是重放任意调用者环境。
转换副本禁用系统属性，然后使用已经观察的原始属性数据；配置过滤器只读键名，
不读取/执行过滤命令。保留词形式的过滤器名称也不能绕过自定义转换限制。

### 验证进度

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| 初始 RED | 17 项，16 失败、1 通过 | 不支持 commit target 导致预期失败 |
| 首轮 GREEN | 17 项全部通过，81.675 秒 | 真实临时 Git；CRLF、UTF-16LE、SHA-256、自定义过滤器均在本机执行 |
| 首轮类型检查、构建、Web API | 通过 | 不代表后续安全修补已验证 |
| 扩展定向回归 | 50 项中 49 通过、1 夹具失败 | 空 Git 模板没有 `.git/info`；修正夹具后单项通过 |
| 安全修补前全量 | 55 文件，693 通过、1 Windows 跳过，461.77 秒 | 固定原 150 个源码/脚本文件；不含随后新增安全复现文件 |
| 安全修补前构建 smoke | 21 个 CLI/MCP 场景通过 | 新增真实本地提交、提交前报告失效、跨进程恢复与 MCP 完成 |
| 独立审查 | 发现两项问题，主助手均已真实复现 | 不是通过结论；另沿相同原因复现 builtin 属性歧义 |
| 新增安全回归 RED | 4 项全部失败 | 两种保留词 driver、literal text=set、缺对象稀疏索引 |
| 安全修补定向 | 25 项 commit 用例通过；随后 15 项安全回归通过 | 包含真实 no-fetch、全局宏/BOM、info/目录属性、索引回退、忽略文件和特殊索引标记 |
| 修补后类型检查、构建、Web API | 通过 | 中途 readSync 类型签名失败已修正；不覆盖运行时安装 |
| 安全修补后构建 smoke | 21 个场景通过 | 新构建 CLI 与 MCP 的真实跨进程验证；非线上 GitHub |
| 安全修补后独立复审 | 无新增可操作发现，九个实现文件前后摘要一致 | 实际源码的内存探针使用 Git/文件系统替身，不冒充真实 Git 验收 |
| 安全修补后全量 | 56 文件通过，708 项通过、1 项 Windows 跳过，409.30 秒 | 固定最终源码；跳过的是未暂存可执行位变化，不代表跨平台验收 |

独立 actor 为 `01a0b580-f4bb-7b91-85db-a441210544b5`，检查方式为
`no-write requested + audited`，受检文件前后摘要一致。审查最初使用内存替身，
主助手随后通过真实临时仓库复现：保留词过滤器名称可被误认成属性状态；
`text=set` 字符串可被误认成 Boolean `text`；旧候选读取器在稀疏索引缺失树时
调用了夹具远端助手，甚至未报错返回。助手只在临时目录写标记，没有连接真实远端。
这些复现保留为修补前失败证据，不能改写为首次全绿。

安全修补前 150 文件快照为
`efac3ba15ba0c20feba9e13dc6f17c8bc7dba744f07c437e277298131001317f`；
新增安全复现与后续修改不属于该快照。

Claude round-114/115 的取舍记录在
`.catpaw/discussions/phase3-claude/round-115.coordinator.md`。
未采纳一概拒绝属性宏、编码或 partial clone 的建议；支持范围由实际可安全读取
并复现的事实决定。实际跨文件宏控制用例不支持“宏只在单文件内生效”的假设。
Git 在测试的无效编码情况下会写转换错误却仍返回 OID 和状态 0，因此新读取器
不把这个结果当作完整成功。所有失败、夹具纠错与修补前结果保留，未改写历史。

复审采用同一独立 actor，但没有参与修补实现。主助手采纳其审查结果，
实际磁盘与 Git 用例由主助手另行执行。三份安全修补实现摘要为：

| 文件 | SHA256 | 备注 |
| --- | --- | --- |
| `commit-delivery.ts` | `3056db4150332fc869b16a70b5d02c4d7835c46aa7eb370dc38cd85d11e4a844` | 原始属性副本、过滤器歧义保护、最终候选复核 |
| `git-attributes.ts` | `1a4130bbc94608f0d2fc244b242ebd0b2d866f7460bf335d6c3c91835d695fa4` | 有界读取与索引回退；属性内容只保留摘要 |
| `candidate.ts` | `ff76e8084dea8ac413ed56f5fb581281e19322f0d3651250bad38753dbb69ef2` | 所有候选读取禁止隐式传输，拒绝不完整输出 |

最终固定源码快照：`packages/mcp/src` 与 `packages/mcp/scripts` 共 152 文件，
SHA256 `f0640bfcd45c0ef19b369069d7af4b76593eccb6e6b497e9aa9fa22608d4a69b`；
算法沿用上文，记录的是工作区文件内容，不是 Git commit。
实际最终命令：

```text
pnpm --filter contribbot-mcp exec vitest run --maxWorkers=4
pnpm --filter contribbot-mcp typecheck
pnpm --filter contribbot-mcp build
node packages/mcp/scripts/execution-smoke.mjs
node --test packages/web/server.test.mjs
git -c core.safecrlf=false diff --check
```

三份相关 Markdown 的 10 个相对文件链接存在性检查通过，不宣称解析了标题锚点。
真实用户会话、线上 GitHub、macOS/Linux 仍未实测；独立内存探针不替代这些验收。

本轮没有迁移真实 `.contribbot`、修改用户 Git/MCP 配置、启用运行时或提交推送。
远端证据的待决规则和 B 的未决远端结果保护没有改变，完整 goal 仍未结束。

## 后续确认：远端报告与核实

2026-09-19，用户明确选择：“先记录‘据报告已合并，待核实’，查询确认后才满足交付条件”。
该决定取代上文实现期间“远端报告规则待用户确认”的当前状态；历史测试和咨询记录不改写。

用户或 Agent 提供的报告应保留来源，不能单独满足必需的远端交付。
查询不可用时保留待核实，不推断未合并，也不认定已经满足交付要求。
查询确认交付事实之后，仍须满足原有计划、验收、安全收尾和任务完成条件；
不因此启用自动完成、取消或归档。

当前代码仍只有本地 workspace/file/commit 交付端点；本次落盘的是产品决定，
不是远端端点已实现或验证通过的声明。下一步继续核对远端对象身份、报告与查询
结果的独立记录，以及其对当前候选和完成检查的适用性。

按此决定继续咨询原 Claude 长期会话的 round-118 返回 API 400，
没有取得新接口设计意见；记录见
`.catpaw/discussions/phase3-claude/round-118.coordinator.md`。
当前不再等待用户选择上述报告规则，而是需要恢复设计咨询后继续实施。
本轮只更新设计和任务记录，不新增业务代码、运行时部署或功能验证结论。

后续恢复排查：同参数短请求成功，原会话加单次自动压缩窗口仍返回 400；
批处理及当前安全配置下的交互终端均未成功执行 `/compact`。
旧会话失败原因尚未确定，不把“大上下文”当作已证实根因。
探测进程均已退出，临时调用器改动已撤除；没有取得新的设计意见。
详见 `.catpaw/discussions/phase3-claude/round-120.coordinator.md`。
若需用完整交接材料建立后继长期会话，应先取得用户确认，不静默更换原会话。

## D 增量：远端交付核验

2026-09-19，用户同意保留旧讨论并启用后继长期会话。
round-121/122 已成功咨询 `0e4058f9-0d2b-423c-838b-eaa1bc6e13b2`，
旧记录保留；实现取舍见对应 coordinator 文档。
本节更新当前实现边界，不把上面的历史验证改成新代码的通过记录。

| 范围 | 实现 | 备注 |
| --- | --- | --- |
| 远端分支 | `remote_ref` 显式 repo、refs/heads 分支和 scope | 观察当前分支提交内容；不 push，不查“曾上传”后就永久通过 |
| PR | `remote_pull` 显式 repo、number、base、submitted/merged、allow_draft、scope | 不从关联/参考 PR 推导必需项 |
| 当前内容对应 | 复用本地 commit 核验，再比较 scoped Git blob、mode 与完整文件集合 | 支持提交后的删除；不以本地 HEAD 等于 merge SHA 判断 squash/rebase |
| 查询来源 | 工具自行读取 GitHub；内部 batch 不能从 JSON/报告构造 | 没有新增宿主可伪造的 source=github_read 写入入口 |
| 证据 | 不可变 artifact 记录计划、attempt、epoch、revision、manifest、目标、观察及脱敏响应 | 报告仍在普通证据/笔记保留“待核实”；不冒充查询 |
| 新鲜度 | inspect、prepare、finalize 各自查询；读树前后检查远端身份 | 不宣称跨 API 原子性或持续监控 |
| 并发 | 查询不持有 Todo 存储锁；返回后复核状态/候选，写入使用核验版本 | 新暂停/取消/计划不能被晚到结果覆盖 |
| 旧入口 | 同步本地验证保留；异步 CLI/MCP 完成入口编排远端观察 | 已完成重放不重新验证历史；旧计划摘要不变 |
| 限制 | 每次最多 20 个远端目标，并发 4；截断/缺权限/不支持条目为 not_observed | required 无法观察仍拒绝完成；optional 不增加门禁 |

不采用 Claude 建议的 15 分钟缓存通过窗口，也不采用“prepared 后复用旧报告”的
放宽建议。采纳其 fork head 仓库、index/blob 模式、身份复核及原门禁复用建议。
现有 commit 核验已支持 Git 内置换行转换，无需另造工作区字节到远端的比较算法。
暂不移除旧枚举，不迁移真实数据，不启用通用自动完成策略。

GitHub API 语义依据：本轮读取官方 `github/rest-api-description` 的
`api.github.com.json`，核对 pull 的 `merge_commit_sha` 在 merge/squash/rebase
后的含义、Git tree 的 `truncated` 和 Git ref 路径格式；没有把 PR 未合并时的
测试 merge commit 当成交付。API 文档核对不是线上仓库验收。

### 验证记录

以下先保留实施中的历史结果，最终固定源码结果见本节末尾。
最初 6 个新增测试全部 RED：既有 schema 拒绝远端目标。
加入首批实现后这 6 项 GREEN，类型检查通过。
扩展的身份、内容、草稿、删除、并发、恢复测试及构建后的 CLI/MCP 场景正在验证；
独立检查已派发，尚不能将它们记为通过。

后续定向结果：33 项远端测试及原 closure/deliverables/Issue/control 合计 116 项通过。
独立检查采用 `no-write requested + audited`，没有写入受检实现文件。
检查发现的两项问题均保留真实 RED/GREEN 记录：

| 问题 | 复现与修补 | 备注 |
| --- | --- | --- |
| 本地漂移被当成远端未知 | `remote-delivery.test.ts` 注入 commit observer 已检测到的漂移，旧实现竟返回 ready；修补后直接拒绝、零远端调用 | 测试实际 local/collector/readiness 路径，漂移信号本身用替身 |
| 写回执失败时并发未结束 | `remote-delivery-limits.test.ts` 让一个发布失败、其余读取等待；旧 collector 提前返回，后续任务继续分配 | 修补后停止分配并等待已发出读取结束再拒绝；依赖均为内存替身 |

两次修补的定向 GREEN 已实际运行；查询数上限用例同时通过。
构建后 22 场景已在第二项修补前两次通过（分别覆盖初始实现及漂移修补），
不能把这些旧构建结果记作第二项修补后验证。
一次完整 MCP 回归期间实施了第二项修补，该次不作为固定最终源码证据。
最终源码回归、最终构建 smoke 与独立复审结果须另行追加。

### 最终固定源码验证

2026-09-19，第二项修补后冻结源码再验证，结果如下。历史失败不改写为通过。

| 检查 | 最终结果 | 备注 |
| --- | --- | --- |
| 完整 MCP 回归 | 58 文件通过，744 项通过、1 项跳过，671.42 秒 | Windows 未暂存可执行位用例跳过；不是跨平台验证 |
| 新增远端用例 | 34 项远端核验、2 项 collector 边界用例通过 | 包含在全量结果中，不重复计数；GitHub 使用替身 |
| 构建后 CLI/MCP | 22 个场景通过 | 新场景以 fetch 替身核验远端内容、不可用查询、最终重查及已完成重放 |
| TypeScript、构建、Web API | 均通过，Web API 1 项 | 构建不等于安装运行时，HTTP 测试不是浏览器验收 |
| 原报告并发回归 | 连续 5 次定向通过，随后完整回归通过 | 保留唯一胜者、不可变意图及冲突重放拒绝等断言 |
| 独立最终复审 | 受检范围无剩余可操作发现 | 实际 collector 的内存探针；十个受检实现文件前后摘要一致 |

早先那次非固定源码的完整回归实际为 741 通过、1 失败、1 Windows 跳过。
失败是报告并发用例期待固定错误文案，实际得到另一条合法的不可变发布冲突。
只将该文案断言改为检查明确拒绝结果；仍要求单一胜者、一个操作和检查、
精确胜出意图、冲突重放拒绝、状态未被覆盖及正确 readiness。
没有修改报告实现或放宽数据完整性门禁。

最终源码指纹覆盖 `packages/mcp/src` 与 `packages/mcp/scripts` 共 156 个文件：
`e82e0efb6eb2a0377ecf0221a3ac6fa685f0c2c9d1f6ccf6058fb3c79b7d3b63`。
冻结时刻为 `2026-09-19T02:26:53.995Z`，算法沿用上文；它是工作区内容指纹，
不是 Git commit。冻结后没有修改受检源码和脚本；文档、Skills、Web 不属于该指纹。

独立 actor 仍为 `01a0b580-f4bb-7b91-85db-a441210544b5`，采用
`no-write requested + audited`，不是强制只读沙箱。主助手采纳两项实际缺陷修补及
修补后窄范围复审；没有把内存替身检查说成真实 GitHub 或磁盘验收。
原始发现与取舍见 `.catpaw/discussions/phase3-claude/round-122.implementation-review.md`。

本次最终命令：

```text
pnpm --filter contribbot-mcp exec vitest run --maxWorkers=4
pnpm --filter contribbot-mcp typecheck
pnpm --filter contribbot-mcp build
node packages/mcp/scripts/execution-smoke.mjs
node --test packages/web/server.test.mjs
git -c core.safecrlf=false diff --check
```

下一步是隔离测试数据下的真实宿主与 GitHub 只读核验，不把模拟响应视作线上通过；
远端写入、运行时切换及真实数据迁移需要各自明确授权。
线上 GitHub、`gh` 后端、macOS/Linux 与用户产品验收均未验证。
B 的 prepared Issue 取消与不可恢复未知远端结果仍保留门禁，不由 D 自动解决。
本轮未提交推送、安装或重启运行时、迁移真实数据，也未完成或归档 Todo。

### 真实只读接口与源码 Skill 验证

2026-09-19 继续检查同一固定源码，没有修改业务代码。源码 Skill 入口实际运行
`node packages/mcp/scripts/execution-smoke.mjs --source-skill`，22 个场景全部通过。
安装夹具、Skill 链接、MCP 配置及任务数据均在临时目录，未更新正在使用的运行时。
脚本内的宿主、确认与验收仍是明确标注的测试输入，不冒充用户产品验收。

另用已有公开仓库对象、真实 `gh` 后端和构建后的 CLI 做只读联网验证。
从 GitHub 获取明确文件的真实 blob，并校验内容 OID；隔离 Git 仓库只提交这些文件，
本地 HEAD 与远端提交刻意不同，核验基于内容对应而非提交 SHA 相等。
每次检查后断言 Todo 仍 active；仅测试脚本的显式本地完成请求才允许 done，
并验证不自动归档、精确重试可恢复。没有调用 GitHub 写入接口。

| 场景 | 结果 | 备注 |
| --- | --- | --- |
| `darkingtail/contribbot-test` 的 `refs/heads/main` | `README.md` 对应，端点 present；本地显式完成及重放通过 | 改成本地已提交的不匹配内容后为 missing，`with_gaps` 不能豁免；还原并重新验收后可完成 |
| `darkingtail/contribbot-test#15` | submitted 端点 present；显式本地完成及重放通过 | 只核对 `v.txt`，不代表该 PR 的整体质量验收 |
| `darkingtail/contribbot-test#10` | 已关闭但未合并，merged 端点 missing；拒绝完成 | 即使传入缺口确认仍拒绝，不自动改变 Todo |
| `antdv-next/antdv-next#906` | merged 端点 present；显式本地完成及重放通过 | 仅以 `README.md` 为交付范围；真实合并提交 `a3c8991833dff948c7157720fe3b9a447d1bbe0b`，不是本项目交付 PR |

实际运行时间为 `2026-09-19T02:59:27Z` 至 `03:00:35Z`；均已退出，临时数据已删除。
原始 JSON、目标/提交身份及一次性检查脚本保存在
`.catpaw/discussions/phase3-claude/round-123.live-readback.*`。
最终四份结果分别为 `branch-final`、`submitted-final`、`closed-final`、
`merged-final`，是四次各自独立的运行，不宣称一次全程无失败。

保留失败历史：初次检查 not_observed；第二次准备夹具时真实 GitHub 返回 EOF；
后续脚本漏列已有报告操作而被 yield 门禁拒绝，修正的是测试操作清单；
随后完成预检又因必需端点无法核实而拒绝。产品源码及门禁未修改。
最终检查对只读 EOF 或 not_observed 最多重复三次，每次保留失败观察，
不增加产品自动重试策略、不重放公开写入。已合并场景第一次本地完成预检
仍为 not_observed，后续新核验通过才完成测试 Todo。
最初未完成的 `repeat-2` 结果中行级 `outcome=passed` 只代表 inspect 已通过，
整份结果为 failed；脚本后来将未完成场景明确改成 `inspection-passed`。

这消除了“完全没有真实 GitHub/gh 后端验证”的旧缺口，但验证范围仅是上述明确文件、
现存公开对象及本地 CLI 流程。真实 Token/fetch 后端、私有仓库权限变化、删除的 PR head、
macOS/Linux、原生宿主长对话与用户产品验收仍未覆盖。
原 744 项回归属于同一未改动源码，不因新增一次性验证脚本而重标测试数量。
没有完成或归档实际跟踪 Todo，未启用迁移或自动完成。
