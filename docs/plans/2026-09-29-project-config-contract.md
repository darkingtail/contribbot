# Project config.yaml schema v3 契约（跨实例）

日期：2026-09-29，Asia/Shanghai。
状态：**用户已接受 schema v3；本轮约定的实施与本地验证范围已收尾。
验证依据、限制与范围外事项见 [2026-10-05 进度](../progress/2026-10-05.md)。**
用户再次明确纯自用：本轮不做历史数据迁移、旧格式兼容读取、字段转换、
旧目录搬迁或数据合并；不自动清空现有数据，本次尚未执行备份。

本文替代 [9 月 28 日的 GitHub-only 字段草案](2026-09-28-project-config-schema.md)
作为本轮已接受的总配置契约；旧草案保留讨论历史，不应混合两份示例实施。
已确认的原则是：根 `repository` 管理主体、一级 `parent` 表示直接 fork 来源；
贡献的具体来源和目标在任务/交付操作中明确，持续追踪意图、项目生命周期和
实时权限与仓库关系分开。用户要求先定总配置，
再分别处理前面发现任务、中间 Todo/Consult、后面交付与沉淀；MCP 包结构暂不重拆。
本契约的版本号、仓库引用、目录键、字段细节和初始化边界已作为
schema v3 被接受并在本轮候选实现；平台能力与真实环境验证有上述范围限制。当前 `platform`
仅允许 `github`、`gitlab`；此前讨论的 Gitee 不在本版允许值中，
若要纳入须另行明确范围和适配要求。

## 1. 完整示例

示例值均为**虚构**，不能当作已查明的仓库关系或真实核实时间。
管理自己的 GitHub fork，不因它的 parent 在别处就把 Todo 存到 parent 项目：

```yaml
schema_version: 3
repository:
  platform: github
  instance: https://github.com
  path: darkingtail/antdv-next
lifecycle:
  status: active
parent:
  status: confirmed
  repository:
    platform: github
    instance: https://github.com
    path: antdv-next/antdv-next
  relation_verified_at: "2026-01-01T00:00:00Z"
tracking:
  status: configured
  sources:
    - platform: github
      instance: https://github.com
      path: antdv-next/antdv-next
    - platform: github
      instance: https://github.com
      path: ant-design/ant-design
```

GitLab 自托管私有仓库的最小示例。`instance` 可带安装路径前缀；
`path` 只写该实例内的组/子组/项目，不把前缀再写入 `path`：

```yaml
schema_version: 3
repository:
  platform: gitlab
  instance: https://code.example.com/gitlab
  path: team/subgroup/internal-ui
lifecycle:
  status: active
parent:
  status: unknown
tracking:
  status: pending
```

## 2. 字段和形状

恰好五个顶层键，均必填；内部对象严格拒绝未知键。表中 `RepositoryRef`
是完整的三字段对象，不是 `owner/repo` 字符串。

| 字段 | 类型及允许值 | 出现条件 | 备注 |
| --- | --- | --- | --- |
| `schema_version` | 整数 `3` | 必填 | 不是并发 revision；旧工作区已有另一种 v2 候选，不能复用版本号 |
| `repository` | `RepositoryRef` | 必填 | 管理主体；普通更新不能改变 |
| `repository.platform` | `github` / `gitlab` | 必填 | 标识服务种类，不等于当前已有该平台全部工具 |
| `repository.instance` | 规范化的 Web 实例根 URL | 必填 | 包含协议、主机、可选端口和安装路径前缀，不是 API 或仓库 URL |
| `repository.path` | 实例内仓库完整路径 | 必填 | GitHub 为 `owner/repo`；GitLab 为 `group[/subgroup...]/project` |
| `lifecycle` | 对象 | 必填 | contribbot 项目状态，不是远端仓库或 Todo 状态 |
| `lifecycle.status` | `active` / `archived` | 必填 | 归档不删除数据、不改变 Todo |
| `lifecycle.archived_at` | 带时区时间 | 仅 `archived` 必填 | `active` 时禁止出现 |
| `parent` | 对象 | 必填 | 主体直接 fork 来源的事实快照，不表示追踪意图 |
| `parent.status` | `unknown` / `none` / `confirmed` | 必填 | 未知、已确认不存在、已确认存在 |
| `parent.repository` | `RepositoryRef` | 仅 `confirmed` 必填 | `unknown`、`none` 时禁止出现 |
| `parent.relation_verified_at` | 带时区时间 | `none` / `confirmed` 必填 | 上次成功核实关系，不是代码同步时间 |
| `tracking` | 对象 | 必填 | 用户持续关注的来源选择，不因有 parent 自动添加 |
| `tracking.status` | `pending` / `none` / `configured` | 必填 | 未决定与明确不追踪严格区分 |
| `tracking.sources` | 非空 `RepositoryRef` 数组 | 仅 `configured` 必填 | 每项直接写 `platform`、`instance`、`path`；不同平台/实例的仓库可同时列出，`pending`、`none` 时禁止出现 |

禁止字段必须**省略**，不能以 `null`、空对象或空数组代替。
本契约没有允许以 `null` 表示业务状态的字段。
时间采用 RFC 3339 且验证真实日历值，如 `"2026-01-01T00:00:00Z"`；
读取不能以系统时钟补缺失时间。解析应拒绝 YAML 重复键、合并键、
自定义 tag 和与以上形状不符的值，不能悄悄丢掉未知字段。

### RepositoryRef 的输入与同一性

1. `platform` 必须是上表二值。`instance` 是完整的 Web 服务根地址；
   `https://github.com`、`https://gitlab.com` 是公开实例的明确写法。
   自托管实例可用独立主机、端口和路径前缀，如
   `https://code.example.com:8443/gitlab`。同一个域名上的两个不同前缀
   是不同实例。`http` 可以表示确实使用 HTTP 的内网实例，但不因配置
   接受 HTTP 就批准凭据或企业材料经不安全连接传输。实例地址须由
   用户或可信宿主明确选择并核实；不能从一条未经核实的搜索结果或
   外部仓库 URL 自动接受主机并附带凭据发请求。重定向到另一主机
   或协议时不转发凭据；主机信任与认证不靠此文件里的字符串授予。
2. URL 解析后规范化协议和主机大小写、国际化主机名、默认端口以及末尾
   `/`，保留路径前缀的大小写。拒绝用户名/密码、query、fragment、
   重复斜杠、`.`/`..` 段、反斜杠、控制字符和带歧义编码的前缀
   （首版拒绝前缀内 `%`）。不能把仓库页面地址或 `/api/v4` 当作
   `instance`；不能从本机 `git remote` 的 SSH 主机默默猜一个实例。
3. `path` 使用所选平台返回的规范仓库路径；GitHub 恰好两段，GitLab
   至少两段且允许子组。每段非空，不是 `.`、`..`，不能含反斜杠、
   控制字符、`%`、URL query/fragment 或编码后的路径分隔符；不接受
   `.git` 后缀、完整 URL、分支或本地路径。具体合法仓库名还须由
   对应平台验证。保持平台返回的路径大小写，不对 GitLab 路径做
   未经证实的统一小写处理；别名、重命名和跨实例镜像不自动视为同一项目。
4. 项目创建前经对应平台只读查询取得规范路径。查询失败、无权限、
   同一路径指向多个候选或响应缺少可用身份时，不创建新项目，
   也不把失败当作无 parent。已存在的配置可以离线按**精确身份**
   继续本地 Todo 工作；依赖远端事实的操作仍需重新核实。
5. 比较主体、parent 和追踪来源时，先构造规范元组
   `(platform, instance, path)`；创建时采用平台返回的规范路径，
   不以字符串同名推断 fork 网络。读取已存配置时不自动重新规范化
   路径或搬目录；若远端出现重命名/大小写变化，暂停受影响动作，
   提示另行确认身份迁移。v1 不承诺自动识别服务别名或 GitLab 路径
   大小写规则；新建前还要检查本地是否已有相同规范元组。解析时
   规范化 `instance` 后如与持久值不同，拒绝并提示显式修正；
   写入时只保存规范表示，避免同一个 URL 算出两个目录键。

工具的项目身份必须显式给出。通用 MCP 仓库范围工具的 `repo` 只接受
完整三字段 `RepositoryRef` 对象，不接受 `owner/repo` 简写或仓库 URL。
宿主可以沿用对话中已确认的项目，但每次调用仍须传入完整对象；
MCP 不维护隐式项目绑定，也不因 `parent` 改变管理主体。用户自然语言中的
简称、仓库名或链接仅是待核实的线索，不是工具输入。

### 状态矩阵

| 分组状态 | 必填附加字段 | 禁止字段或关键条件 | 备注 |
| --- | --- | --- | --- |
| `lifecycle.active` | 无 | `archived_at` | 显式归档和恢复才改变生命周期 |
| `lifecycle.archived` | `archived_at` | 未定义字段 | 默认列表/巡检排除；init 不自动恢复 |
| `parent.unknown` | 无 | `repository`、`relation_verified_at` | 成功读取仓库不等于已能看清 fork 关系 |
| `parent.none` | `relation_verified_at` | `repository` | 只有权威响应**明确否定** fork 才写入 |
| `parent.confirmed` | `repository`、`relation_verified_at` | 自引用 | 保存直接来源，不是 fork 网络的根 |
| `tracking.pending` | 无 | `sources` | 未询问、拒绝回答或查询失败都不能伪造决定 |
| `tracking.none` | 无 | `sources` | 用户明确决定不持续追踪 |
| `tracking.configured` | 非空 `sources` | 自追踪、重复来源 | 允许同时选择 parent 和其他来源 |

`parent.none` 的负面证据需由平台适配器按 API 契约实现。例如 GitHub
成功查询后明确 `fork: false` 才可写；GitLab 私有来源可能使
`forked_from_project` 不可见，HTTP 200 但字段缺失或不可见不能算否定。
若平台不能提供可靠否定信号，保留 `unknown`，不能自行从 `null`、
404 或权限不足推断 `none`。失败也不覆盖旧的 `confirmed`/`none`
或其成功核实时间；查询失败在本次结果中另行报告。

`parent.repository` 不能等于主体；各 `tracking.sources` 互不重复且
不能等于主体。parent 可以同时是 tracking source；跨平台/跨实例引用
不在 schema 层通用禁止，但 parent 的**实际 fork 关系**必须由对应平台证明，
不能将导入、镜像或同名项目伪装成 fork。关系不可核实时保持
`parent.unknown`；一次已存快照不是写权限。
同仓库分支开发、从自己的 fork 向组织仓库提 PR，或从被管理的 fork 向 parent
提 PR，都是具体任务/交付的选择；不得从 `repository` 或 `parent` 默默推断
本次代码来源、PR head/base 或直接提交权限。操作时明确端点并核实权限；
历史 PR 来源最多作为建议，不作为自动选择的配置默认值。
多来源 tracking 只表示保存关注选择，不自动并行巡检或启动 Agent。

## 3. 存储定位和读取边界

建议新项目数据放在：

```text
~/.contribbot/projects/v1/<sha256>/
  config.yaml
  todos.yaml
  todos/
  knowledge/
  sync/
  ...
```

`<sha256>` 为下列 UTF-8 字节的 SHA-256 小写十六进制：

```text
JSON.stringify(["repository-key-v1", platform, normalized_instance, canonical_path])
```

数组元素依上述顺序写入，紧凑 JSON，无换行；`repository-key-v1`
是**目录键规则版本**，与 `schema_version: 3` 各自独立。
hash 只为跨平台文件系统定位，不是密钥或授权。不能只凭目录名反推仓库：
每次读取 `config.yaml`，严格验证其 `repository` 计算出的键与目录相符；
若不同、损坏、重复或遇到符号链接/越界目录，报错并阻止相关写入。
`project_list` 扫描这个版本目录并显示配置里的可读仓库身份，
不能忽略损坏配置而宣称项目不存在。不同实例相同 `path` 不共享
Todo、Consult、Knowledge、追踪或同步数据。

旧 `~/.contribbot/{owner}/{repo}/` 及其数据不自动读取成 v3、
复制、清空或搬迁。对 GitHub.com 项目若发现同名旧目录，
报告“旧格式/位置尚未处理”，不一边写新目录一边将旧任务隐藏。
用户可之后另行决定备份、重新开始或显式处理；本次设计本身不操作
活动数据。用户改变主体、实例 URL、规范路径或远端重命名属于
**身份迁移**，普通 `repo_config` 更新禁止；不要以改 digest 的方式
自动搬数据。更新配置使用基于读取快照的冲突检测、跨进程短锁、
原子替换和失败保全；锁持有期间不查询网络或等待用户输入。

### 追踪来源身份（2026-10-02 确认纳入）

用户已确认本轮一起修改来源参数、存储键、归档及记录路径。项目主体与
追踪来源分别传入完整三字段对象，不能把 `tracking.sources` 降为 `path`
后用于读写定位；同路径、不同平台或实例的来源必须分开。

| 位置 | 本轮契约 | 备注 |
| --- | --- | --- |
| MCP `upstream_repo` | 完整 `RepositoryRef` 对象，拒绝字符串简写 | 包括 Issue 创建后的来源关联；参数名暂不重命名 |
| `upstream.yaml` | `schema_version: 1` 和 `sources`；键为来源 `repositoryDigest`，值含完整 `repository`、`versions`、`daily` | 文件格式版本独立于 config v3；读取核对键与身份 |
| `upstream.archive.yaml` | 相同的格式版本和来源键；值含完整 `repository`、`commits` | 归档身份不匹配时拒绝，不先删活动记录 |
| `upstream/<source-digest>/<version>.md` | 来源 digest 隔离记录路径，版本名通过文件名安全检查 | 本次只改变现有路径定位和读取，不增加 Markdown 正文身份协议或创建器 |

不自动迁移、转换或清空旧来源索引、归档与 Markdown 文件。
旧索引读取明确报错且不覆盖；旧 Markdown 路径不作为新记录的回退。
GitHub.com 以外的远端抓取继续明确拒绝。完整来源身份可以表示、存储并
区分私有实例，不等于实现了该实例的认证、抓取或 Issue/MR 操作。

## 4. 初始化、更新和配置外事实

| 动作 | 输入、结果与失败边界 | 备注 |
| --- | --- | --- |
| `repo_config` 查看 | 显式项目身份；不存在则 `not_initialized`，不创建任何目录 | 查看不刷新 parent 或永久权限 |
| `project_init` | 显式主体；只读验证平台规范身份；首次创建最小配置（`active/unknown/pending`），已有合法项目只读取 | 不改父项目归属；归档不恢复；不建知识、Todo 或启动巡检 |
| `parent_refresh` | 显式三字段主体；成功且有可见可靠证据时更新 `parent` 和本组时间 | 不初始化或同步；证据不足为 unavailable，保留旧快照；请求失败为错误 |
| 用户配置更新 | 明确的追踪集合或生命周期决定，比较期望快照 | 冲突失败，不把旧用户决定套到较新数据上 |
| 权限与动作 | 针对主体、parent、任务实际工作仓库及 PR 端点分别实时核实 | 可读不等于可写；配置和既往查询不是授权凭证 |

解析版本不是迁移器：非 v3、缺字段、未知键、错误组合与重复 YAML 键
一律报具体路径，不补字段、不写回、不降级读取。首次创建时
`parent.unknown` 可与已验证的仓库身份并存：只能确定管理主体，
不代表能看到其私有 fork 来源。已归档项目可以经用户明确要求维护
配置，但不因此自动恢复或开始任务。

2026-10-02 用户确认独立 `parent_refresh(repo)` 入口，复用现有关系刷新函数；
当前只支持 GitHub.com。响应结构为
`{schema_version: 1, repository, status: refreshed/unavailable, parent}`，
附 Markdown。`unavailable` 不是新核实结果，不能把旧快照和旧时间当作
本轮证据；异常使用普通 MCP 错误结果，不吞错、不覆盖配置或自动重试。
不改变 tracking、生命周期或 Todo，也不在 init/view/sync 时自动调用。
不增加配置字段或原因枚举，不把本入口批准扩展为私有 GitLab 凭据授权。

`last_successful_sync_at` 从配置外的、按源/目标/分支/远端或本地范围区分
的成功同步流水导出；拟议文件名仍是 `sync/parent-sync.yaml`，
其记录格式另行设计，本契约不预先写一个空流水文件。
追踪游标、处理历史、Todo/Consult 计划与决定、PR head/base、
分支/worktree、Knowledge 内容与审阅、token、role/org、权限快照、
外发许可、`mode` 和自动巡检规则都**不在** `config.yaml`。
企业知识读取和外部模型传输必须另行授权与实施访问控制；
本 schema 表达私有仓库，不等于 GitLab 全量 API、认证或安全隔离已实现。

## 5. 实施边界和验收

实施时先实现完整配置与身份入口：严格解析、项目数据目录、`repo`
参数解析、`resolveRepo` 全部调用方取消 fork→parent 重定向、
只读身份验证适配器、init/view/update 分离和本地配置更新保护。
需审计 Todo/Consult/Runner、project_list、Knowledge、追踪及交付工具
调用的同一项目身份，不能只改 YAML 却留下两套活动目录或默认 parent。
GitLab 的只读身份验证是初始化其私有仓库的必要依赖；
GitLab 的 Issue/MR/同步/巡检及企业认证和知识访问另行实施，
未支持的动作必须清楚拒绝，绝不能落到 GitHub 适配器。

测试至少覆盖：六类已知关系组合以及 `unknown/pending`；两平台、
两个实例同路径、子组、端口、安装前缀、大小写/非法 URL 与目录键冲突；
GitLab 隐藏 parent、GitHub 明确非 fork、网络失败保留旧事实；
本地 R/F 各有项目不串 Todo/Consult；只读不初始化、重复 init 不重置、
归档不恢复、并发修改不覆盖、坏配置不被跳过、旧目录不被隐藏为新空项目。
还需现有单测、类型检查、构建与受影响的全量回归。
模拟平台响应不能替代真实私有实例的权限、安全与跨平台验证；
需要外部写入时另外征求授权，不以本契约批准远端动作。

### 5.1 共享读取归属（2026-10-02 已确认）

用户在两轮 Claude 讨论后明确同意最小 Core 提取。配置 schema、严格 YAML
解析、只读加载、项目扫描与路径链接检查保留一份实现，位于 Core；
Web、MCP、Runner 复用，不让 Web/Runner 依赖 MCP，也不新增包。
MCP `RepoConfig` 的写入、锁和更新仍在原处，读取委托 Core；
更新在锁内重新读取，保留现有并发与失败语义。
完整 Todo 列表复用 Core 已有解析校验，不迁移整个 TodoStore 或重写生命周期。

批量扫描报告单项目配置问题并保留健康项目；根目录结构非法或项目目录
为链接时仍失败，不悄悄变成空列表。Web 保留巡检报告和状态，
读取失败明确显示 unknown/诊断。Runner 在访问咨询记录前使用同一配置
守卫，不改变其本地目录参数协议。详细结果与限制见
[共享读取复核](../reviews/2026-10-02-web-schema-review.md)。

### 5.2 延期：Python Agent CLI 的完整仓库输入（2026-10-04）

MCP 和配置已经使用完整 `{ platform, instance, path }` 身份。Python Agent 的
`patrol` 及带位置参数的 `patrol-all` 仍以 `owner/repo` 或公共仓库 URL 作为便捷输入，
并在调用 MCP 前转换为完整身份；它们目前不能明确表达任意自托管实例。

用户决定本轮不扩展该 CLI。它不是 schema v3 的完成条件，也不阻塞实际 MCP 验收、
整体升级收尾或后续 Agent Team。未来需要支持自托管仓库的 Agent CLI 时，另行设计
面向人的完整身份输入，并评估显式三字段参数、结构化 JSON、Windows shell 使用体验、
批量输入及按完整身份去重。`--repo-json` 只是 Claude 提出的候选方案，不是已确认契约。
未来实现不得降低 MCP 的严格对象输入要求，也不得从展示文字反推仓库身份。

## 6. 顾问与已确认范围

本轮延续原 Claude 长期会话完成两次只读设计复核；随后就
`contribution.working_fork` 的必要性增加一次聚焦讨论。
Claude 起初倾向沿用 v2 和可读目录，接受冲突与文件系统反例后改推
v3 和 digest；明确提醒 GitLab 的 fork 来源可能不可见。
主助手接受新版本号、版本化目录键和保守的负面证据条件，
但**不采纳**“相同 basename/host、大小写和前缀天然无需测试”的说法：
规范化、冲突检测和实际文件系统仍要测试。顾问未自行读源码、
连接真实平台或运行产品测试；这些建议不是验收或用户决定。
聚焦讨论中，Claude 建议删除总配置的 `contribution`，因为管理自身 fork
与管理组织仓库时的 PR 来源方向不同，一个必填可空的默认字段不能描述两者。
主助手采纳删除建议，但仅接受“最近一次 PR 来源”作为提示，
不允许它代替本次具体端点的确认。用户已明确决定删除该分组；
这是本契约已确认的删改，不代表批准剩余 schema 或实施。

| 契约取舍 | schema v3 决定 | 代价与备注 |
| --- | --- | --- |
| 版本与身份 | `schema_version: 3`、三字段 RepositoryRef | 旧 v2 明确拒绝；所有项目调用方需同步更改 |
| 存储位置 | `projects/v1/<digest>`，按 config 核对身份 | `ls` 不直观看出仓库；换来实例/层级与文件系统隔离 |
| 初始化与调用 | 新项目须验证规范身份；仓库工具只接受完整对象 | 离线或无权访问私有仓库时不能新建；旧入口需要适配 |
| 五个顶层键 | 删除 `contribution`；多来源 tracking、`relation_verified_at` 纳入 v3 | 贡献的来源/目标留在具体任务与交付操作；多来源配置不意味着自动执行 |

用户于 2026-09-29 接受当前 schema v3。接受契约不等于旧项目
数据迁移、企业实例鉴权、GitLab 全套远端操作或 Gitee 接入已获实施授权，
也不代表现有代码和测试已经符合本契约。

## 资料与局限

| 来源 | 本文采用的事实 | 备注 |
| --- | --- | --- |
| [GitHub 仓库 API](https://docs.github.com/en/rest/repos/repos#get-a-repository) | 响应含 `fork` 与直接 `parent` | 不保证任意权限下均能读取完整响应 |
| [GitLab Projects API](https://docs.gitlab.com/api/projects/) | 使用 `path_with_namespace`；私有 upstream 时 `forked_from_project` 可能不可见 | 不从字段缺失推出 `none` |
| [GitLab 相对路径部署](https://docs.gitlab.com/install/relative_url/) | 自托管实例可部署在 URL 子路径下 | 不证明当前 contribbot GitLab API 可用 |
| 2026-09-29 设计时的本地 `repo-config.ts`、`resolve-repo.ts`、`config.ts`、`project-init.ts`、`project-list.ts` | 当时使用 v2 和 `owner/repo` 目录，可能自动归 parent | 历史设计基线，不描述 2026-10-02 工作区实现；最新验证见进度入口 |

以上 URL 规范化和目录设计是**我们的候选契约**，不是平台文档直接规定。
