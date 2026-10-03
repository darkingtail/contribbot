# schema v3 跨入口身份缺口复核

日期：2026-10-01，Asia/Shanghai。当前状态：用户已确认结构化身份与失败处理方案，
修复已落地并通过定向及 Python 回归；跨语言规范化及整体升级仍未完成。
下方第 1 至 7 节保留本日修复前的调查事实；当前进度见第 8 节。

本轮继续的是[已确认的整体契约](../plans/2026-09-29-project-config-contract.md)，
不缩小为 Python 局部修复，也不以本报告替代 schema v3 整体验收。
工作目录为 `D:/dev/darkingtail/contribbot`，分支 `main`，HEAD `49a0d90`；
对应未提交工作区候选，不是 HEAD 已提交版本。

## 1. 主助手已复现的问题

| 问题 | 实际结果 | 影响与备注 |
| --- | --- | --- |
| 展示字符串反解析丢失身份 | `parse_display(source.display())` 改写 HTTP 协议和安装前缀，digest 不同，断言失败 | Python 初始化仍调用该路径；带安装前缀的 GitLab 项目可能被当作另一项目 |
| 项目发现吞掉结构化错误 | 模拟结构化查询报错后，实际调用序列为 `structured`、`markdown-fallback`，仍返回项目，断言失败 | `tracked_projects()` 捕获所有异常后再次请求 Markdown；没有保留原错误边界 |

第一个探针的原始输入与实际输出：

```json
{
  "source": {
    "platform": "gitlab",
    "instance": "http://code.example.com:8080/gitlab",
    "path": "team/subgroup/app"
  },
  "restored": {
    "platform": "gitlab",
    "instance": "https://code.example.com:8080",
    "path": "gitlab/team/subgroup/app"
  },
  "digest_equal": false
}
```

主助手通过 `uv run --no-sync --project packages/agent python -c` 实际执行两个
内存探针，均以目标断言失败、退出码 1 结束。第二个探针替换 MCP Client 为本地
假对象，没有访问远端、启动巡检或修改项目数据。探针与现有 pytest 回归分开报告。

源码定位：`packages/agent/src/contribbot_agent/repository.py` 的
`display()` / `parse_display()`，`init_context.py` 的
`canonical_repo_from_context()`，以及 `orchestrator.py` 的
`tracked_projects()` / `parse_project_list()`。

## 2. 本轮验证结果及限制

| 命令或检查 | 结果 | 备注 |
| --- | --- | --- |
| `uv run --no-sync --project packages/agent pytest packages/agent/tests/test_init_context.py packages/agent/tests/test_orchestrator.py -q` | 29 passed，退出码 0 | 现有用例未覆盖上述反例 |
| `uv run --no-sync --project packages/agent pytest packages/agent/tests -q` | 54 passed，退出码 0 | 包含上方 29 项，不能相加为 83 项；仅为当前 Python 测试集 |
| 两个定向内存探针 | 各退出码 1，复现目标问题 | 不是语法、依赖安装或环境错误 |
| Claude 材料新鲜度 | 7 份文件 SHA-256 在回复后核对一致 | 只证明审查材料未漂移，不是行为验证 |
| MCP 全量、根回归、类型检查、构建 | 本轮未运行 | 既有全量回归缺少最终报告的限制仍保留 |

Python 已有 RepositoryRef、MCP 参数对象化及新 Knowledge URI 的适配代码。
因此准确结论是“部分适配已实现，但存在身份保真和错误回退缺口”，不是“完全未适配”，
也不是“54 项全绿，所以跨实例已经可用”。

## 3. Claude 第二意见

本轮使用既有原生长期会话，通过精确 `--resume` 继续 round-210，没有另起无历史会话，
也没有把原生 session ID 冒充产品 Consult discussion ID。模型工具禁用；CLI 的
读取与外发不构成操作系统隔离。调用已退出，退出码 0，返回原 session ID 和可用正文。

原始材料、哈希、启动/退出事实和回复保存在
`.catpaw/discussions/phase3-claude/round-210.*`；`session.json` 已登记本轮。
这次是设计咨询，不是独立验收 Proof；Claude 没有运行测试或自行检查工作区。

| 项目 | Claude 意见 | 主助手判断与备注 |
| --- | --- | --- |
| 两条失败链 | 确认展示字符串无法无损还原身份，广泛异常捕获掩盖错误 | 与两个实际探针一致，采纳问题定位 |
| 修复主方向 | 保留人类可读文本，同时输出完整结构化身份；Python 不再反解析展示文本 | 符合已确认的身份保真目标；公开响应格式另行明确 |
| 返回格式与失败行为 | 新增初始化 structuredContent、响应版本，以及是否保留非身份降级路径需要明确 | 不混用配置 schema v3 与工具响应版本；交用户确认 |
| 额外候选风险 | 展示名称作字典键可能碰撞、结构化入口仍收字符串、文本标记干扰、跨语言规范化差异等 | 尚未逐项实际复现；只列为下一轮审计候选，不直接宣称全部成立或已修复 |

主助手不采纳“展示名能表达完整身份”的假设，也不把任何顾问建议直接当作用户批准。
诸如返回格式的版本字段属于接口细节，但本轮涉及公开 MCP 与 Python 的共同约定，
需要一次明确边界；既有五键 config 不因此重新设计。

## 4. 待确认的具体方案

| 场景 | 建议处理 | 代价与备注 |
| --- | --- | --- |
| 初始化后，Python 需要继续操作同一仓库 | `project_init` 保留文字，同时增加结构化结果；完整仓库对象、项目目录、生命周期及追踪状态从该结果读取，采用与现有 `project_list` 一致的响应版本约定 | 不增加 config 字段、不保存 MCP 会话绑定；不再从展示名字计算身份 |
| 服务没有返回合法的结构化结果，或查询本身报错 | 停止当前初始化/发现操作并明确报错，不再次请求 Markdown 猜身份；真正空列表仍正常返回 | 旧服务需要与客户端一起更新，不为它保留自动猜测式兼容 |
| CatPaw 暂时无法建立本次 Work | 本轮暂用既有契约、实施/验证文档记录 schema 工作，保留独立审查与全量测试要求，单独记录 CatPaw 登记缺口 | 这是待用户同意的流程例外；未授权前不手工绕过登记，不改已安装运行时或旧工作目录 |

修复采用以上响应方案后，首先补跨实例/前缀/协议回归，再同步改 MCP 初始化输出和
Python 调用链，接着验证两个语言的目录键一致性。不会为了消除这两个反例而降低
整体目标：GitLab 只读身份验证、来源身份、其他调用入口及全量回归仍在原范围内。

## 5. CatPaw 登记复核

本轮实际执行已安装 CLI 的 `status`、`work start` dry-run 及一次 `--apply`。
预览为 ready；实际落盘退出码 1，在暂存复制旧 `git-batches` 下的 `node_modules`
链接时报告 `EPERM`。不是 contribbot schema 解析器或业务测试报错。

失败后重新读取 status：看板仍 healthy、6 个 active Work，没有新增 `FR-004`；
扫描没有发现此次 `..catpaw.catpaw-stage-*` 暂存目录残留。未手工移动或删除
junction、未修改已安装 CatPaw，也未伪造 Work 登记成功。

## 6. 保留的整体缺口

| 范围 | 当前证据 | 备注 |
| --- | --- | --- |
| GitLab 首次初始化 | 当前 `getOrInitConfig()` 对未初始化 GitLab 仍直接拒绝，提示 identity verification 未配置 | 已确认契约要求只读身份验证；此能力尚未实现，不能用本地模拟配置冒充真实私有实例验证 |
| 超时后迟到副作用及全量回归 | 沿用已记录的失败及无最终报告限制 | 本轮没有重跑，不改写历史结果 |
| 跨包身份与来源 | 本轮复现 Python 两条缺口，其余 Todo/Consult/Runner/追踪路径还需逐项核对 | 一条修复不能覆盖所有入口 |
| 用户验收和交付 | 尚未整体验收，候选未提交 | 没有改变 Todo、活动数据、配置、远端或 Git 提交状态 |

## 7. 16:31 补充：跨语言与报告键探针

自动续跑不构成对第 4 节方案的用户确认。本轮只复核 Claude 已提出的候选问题，
没有新增顾问调用、修改业务代码、重试 CatPaw 登记或改变接口。

用同一组 15 个输入分别调用 TypeScript `normalizeRepositoryRef()` 与 Python
`RepositoryRef.model_validate()`，再比较规范表示、digest 和 Python 输出能否通过
MCP 严格解析。9 项结果一致（5 项接受且 digest 一致，4 项均拒绝），6 项有差异，
对照命令退出码 1。以下是两端规范化器对同一原始输入的表现，不能混同于公开 MCP
直接接受非规范输入；公开工具仍有额外严格校验。

| 输入类别 | TypeScript 规范化器 | Python 模型 | 备注 |
| --- | --- | --- | --- |
| `https://GitHub.com` | 转为 `https://github.com` | 拒绝 | 原契约要求主机大小写规范化；不能据此声称 MCP 直接接受大小写未规范的对象 |
| `https://github.com:443` | 移除默认端口 | 拒绝 | 两个规范化入口接受度不同 |
| `https://bücher.example/gitlab` | 主机转为 `xn--bcher-kva.example` | 拒绝 | 已确认契约包含国际化主机名规范化 |
| 中文安装前缀 | 拒绝 | 接受原始 Unicode 前缀 | Python 结果被 MCP 拒绝；没有证明两端都接受该身份或已经发生数据写入 |
| 含空格安装前缀 | 拒绝 | 接受原始空格 | Python 结果被 MCP 拒绝 |
| `http://0x7f000001/gitlab` | 主机转为 `127.0.0.1` | 保留 `0x7f000001` | 两端均接受但 digest 不同；Python 输出随后被 MCP 非规范身份校验拒绝 |

原始记录在 `.catpaw/discussions/phase3-claude/round-210.identity-probes-utf8.json`，
包含输入、输出、源码 SHA-256、Node `v22.22.0` 与 Python `3.12.12`。
初次 `round-210.identity-probes.json` 使用 Windows 默认 stdin 编码，Unicode
输入发生乱码；该初次结果保留但不作为结论。已用 `python -X utf8` 重跑，
逐项回显确认输入无变化后才取得上表结果。两份源码哈希在有效探针之后核对一致。

另一个隔离探针实际调用 `PatrolAllRunner.run()`，把网络执行替换为本地失败假对象，
不是执行 GitLab 巡检；同时直接调用结构化项目列表解析器：

| 探针 | 实际结果 | 备注 |
| --- | --- | --- |
| 实例 `https://code.example.com/gitlab` + 路径 `team/app`，与实例 `https://code.example.com` + 路径 `gitlab/team/app` | 两个 digest 不同，但展示字符串相同；2 个项目失败后只保留 1 条 `failures` 记录 | 第二条覆盖第一条，确认展示名不能作为唯一记录键 |
| `projects: [{repository: "owner/repo"}]` | 被解析为 GitHub.com 的三字段对象，而不是拒绝 | 确认“结构化入口仍接受简称”的候选风险；没有声称公开 MCP 参数也接受简称 |

该组合探针以目标断言失败、退出码 1 结束。此前 54/54 是 16:24 轮次的现有
Python 测试结果，本轮未重跑；新探针不是正式回归已经补齐的证明。
文本标记干扰等其余 Claude 候选仍未逐项验证，不能将本节结果扩大到全部候选。
下一步仍等第 4 节两类决定，之后统一补测试及修复，不借自动续跑改变已批准契约。

## 8. 用户批准后的实施与验证

用户明确同意“三个字段直接传递；缺失或异常报错，不从展示文字猜身份”，
并要求继续 goal。本轮据此修改了 MCP 初始化结果与 Python 消费链路；
不重复征求同一决定，不改变五键 config，不引入 MCP 项目绑定或旧格式兼容。
CatPaw 登记缺口独立保留，没有重试失败写入或改安装运行时。

| 范围 | 本轮结果 | 备注 |
| --- | --- | --- |
| MCP 初始化响应 | 保留 Markdown，同一次配置读取产生 response schema_version=1、repository、directory、lifecycle.status、tracking.status | 响应版本与 config schema v3 独立 |
| Python 初始化 | 先验证结构化身份、状态及目录，再按精确对象更新 tracking；删除文字反解析 | GitHub 规范大小写可接受，不接受换仓库、换实例或自动归 parent |
| 项目发现 | 验证版本、active filter、digest、状态及重复项；错误不回退 Markdown | 真正空列表正常返回；显式空批次不自动发现 |
| MCP 参数及报告 | None/字符串身份拒绝；失败/跳过以 digest 为键、完整身份展示 | 两个同名展示项目的失败记录均保留 |
| RED | Python 新测试 23 失败/3 通过；MCP 新测试 3 失败 | 实際行为缺失；随后修复 |
| GREEN | Python 当前全套 81/81；MCP 初始化/配置三文件 25/25；根 typecheck 通过 | 不包括全量 MCP、真实 GitLab 或整体验收；不与旧数量重复累加 |
| 复核 | Claude round-211 已续接原会话发起，只提供相关源码和契约，无工具权限 | 尚不能把启动算成可用回复或独立通过 |

首次 Python 定向修复后剩余一个用例错误计算所有 `"failed "` 文本，混入摘要与状态列；
已改成逐条断言不同 digest 和分字段身份。这项测试修正不是产品失败被掩盖。
跨语言规范化差异、GitLab 初始化、来源身份与全量回归仍在原整体范围内。
