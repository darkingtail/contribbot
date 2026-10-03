# Web 接入 schema v3：复现与读取边界复核

日期：2026-10-02，Asia/Shanghai。
状态：**用户已明确同意，最小 Core 提取与 Web/Runner 接入已实现；
定向测试、实际浏览器检查与 Claude 静态审查完成；完整 MCP 1255 通过、
2 失败、2 跳过，整体 schema 尚未通过验收。**
本记录服务已确认的 schema v3 整体升级，不是重新提出来源身份范围，
也不改变已确认的五键配置、MCP 无隐式绑定或旧数据不迁移的要求。

## 当前事实与 RED

`packages/web/server.mjs` 仍按 owner/repo 扫描目录，并读取旧的
`role/fork/upstream/status`。严格 v3 项目位于
`projects/v1/<digest>`，旧服务无法发现它们；前端又以可读 repo 字符串
选择项目，没有使用完整身份的稳定键。

隔离探针和新增 `packages/web/schema-v3.test.mjs` 均构造两个
`path: team/ui` 的 GitLab 项目，实例地址不同。测试命令
`node --test packages/web/schema-v3.test.mjs` 退出码 1，失败于预期
2 个项目、实际 0 个；不是语法、依赖或启动错误。
清理阶段同时确认项目文件指纹未变、Web 子进程已结束。
没有读取或修改真实 `.contribbot` 数据。

此测试目前通过上述单独命令运行；现有 Web package 的 `test` 脚本
仍只列 `server.test.mjs`，不能声称根回归已经覆盖新增测试。
实施时应统一测试入口与 v3 夹具；原来期望旧配置被当作 active 的
测试不得成为旧数据兼容的理由。

## 第一轮 Claude 意见与主助手复核

沿既有会话的真实调用记录：
`.catpaw/discussions/phase3-claude/2026-10-02-web-schema-design.manifest.json`。
模型工具禁用，只提供当前源码快照和复现结果；正常退出且快照未漂移。
顾问没有运行测试；以下建议不构成授权、独立验收或整体完成。

Claude 建议在 MCP 包增加独立只读子路径，让 Web 复用当前配置、扫描与
Todo 列表实现；要求不加载 MCP server/SDK、增加包边界检查、显式展示
读取故障。它认为新增 Web → MCP 依赖应由用户确认。

主助手同意复用单份校验和显式故障诊断，但没有直接采用新增依赖。
实际源码表明 Core 已有 `normalizeTodo`、`todoArrayFromDocument`、
`validateTodoIds` 与私有列表读取函数；`TodoStore.list()` 本身只是读取、
解析和校验。因此把共享读取下沉 Core 不必搬整个 TodoStore 或生命周期。
此外，两种方案都会给 Web 增加依赖并涉及共享包构建，不是只有一个方案
有构建成本，也不存在“Core 方案完全不增加依赖边”。

第二轮沿原会话补充这些具体函数，真实记录为
`.catpaw/discussions/phase3-claude/2026-10-02-web-schema-design-followup.manifest.json`；
正常退出、快照无漂移。Claude 明确撤回上述三处比较错误，改为推荐
最小 Core 提取，与既有共享领域逻辑归 Core 的方向一致。

主助手倾向采用修正后的建议，但不把顾问建议写成用户批准。拟议边界：

```text
Web ----------> Core 共享读取 <---------- MCP
                  单份 v3 校验
                  项目扫描
                  只读 Todo 列表
```

只移动/复用现有配置 schema、YAML 解析、只读加载、项目扫描和路径链接检查；
`RepoConfig` 的写入、锁、更新留在原处，读取委托 Core。
Core 已有的 Todo 列表读取函数开放给消费者，不搬整个 TodoStore。
Web 保留现有巡检徽标和报告，不采纳顾问附带的“暂时后置巡检展示”，
因为那会减少现有功能且不是解决目录问题所需。
同时补 Web 的依赖边界检查，限定其共享读取依赖，不加载 MCP server、
Runner 或 Agent Runtime。

顾问提出的 Core 构建入口未知已由主助手静态核实：
`scripts/compile-package.mjs` 调用 `tsc`，
`packages/core/tsconfig.json` 包含 `src/**/*.ts`，
build 配置启用输出，使用 `src` 到 `dist` 的对应目录。
未见“只输出 index.js”的限制；新子路径仍需在 package exports 显式声明、
实际构建后运行测试。这是静态检查，不是已经构建验证了尚未实现的方案。

此前待用户决定的是：是否在本轮为 Web 完成这次小范围共享读取提取；
用户随后明确回复“同意”，已解除此项阻塞。
不是重新确认三字段身份，也不增加五键配置、新包、隐式项目绑定或旧数据迁移。
确认后先保持现有异常语义及根目录/单文件诊断分工，再实现 Web 适配、
替换旧夹具、补默认测试入口和定向回归。

## 修复应保留的验收条件

| 条件 | 验证目标 | 备注 |
| --- | --- | --- |
| 完整身份 | 同路径、不同实例/平台/安装前缀分别显示和选择 | 展示字符串可能相同，不能当作身份键 |
| 配置读取 | 复用严格 v3 校验、目录 digest 核对和链接检查 | 不复制第二套 schema，不读取旧目录作为回退 |
| 项目筛选 | active/archived/all；刷新后保留同一精确身份的选择 | 归档筛选不隐式恢复或改变 Todo |
| 读取错误 | 坏配置、坏 Todo、不可读巡检分别诊断 | unknown 不变成 0，故障不冒充从未执行 |
| 巡检路径 | run_id、报告路径和链接不允许越界 | 只读也不能泄漏项目外文件 |
| 依赖边界 | Web 只调用选定的共享读取入口 | 不启动 MCP 服务、Agent 或后台队列 |
| 数据保全 | 读取前后文件内容及目录结构保持不变 | 不自动创建、转换、归档、迁移或清空 |

根目录错误与单项目错误须沿用现行扫描规则或另外明确决定，不能为了
页面可用就静默吞掉不合法目录。私有 GitLab 凭据来源与 Windows 检查超时
属于既有独立待决事项，本次 Web 讨论不替它们作决定。

## 本轮实施与验证

用户明确回复“同意”后，已提取 `Core/repository/config.ts`、
`Core/repository/projects.ts` 和 `Core/storage/paths.ts`，MCP 读取委托，
写入、锁与更新仍在 `RepoConfig`。严格 schema 与解析器只有一份。
`Core/todo/file-read.ts` 开放现有完整列表读取，`TodoStore.list()` 委托；
单项投影、生命周期和旧有归档读取逻辑没有重写。
共享扫描器的可选 `root` 参数表示 `.contribbot` 数据根本身，不是 HOME。

Web 新增本地 workspace Core 依赖及构建前置，不依赖 MCP/Runner。
API 返回完整身份、digest、parent/tracking/lifecycle 与显式诊断；
前端以 digest 选择、刷新，保留巡检报告、状态筛选与 Todo 全部六态。
读取坏 Todo 的计数与列表为 null，前端显示 unknown/数据不可读；
损坏的巡检元信息不冒充 not_run。巡检报告由安全 run_id 派生，
存储内任意 report 字段不会被当作读取路径，目录链接被拒绝。

Runner 在 composition 统一读取 config，CLI 与 worker 共用入口。
新增测试在修复前真实得到 4 失败、1 通过；修复后均通过。
同步现有 Runner 及 MCP/Runner 并发测试的临时配置夹具，
不靠跳过守卫保留旧测试。没有改 CLI 参数协议或访问真实项目数据。

| 检查 | 本轮结果 | 备注 |
| --- | --- | --- |
| Core | 19/19 通过 | 包含新配置读取、扫描、链接及 Todo 列表测试 |
| Web | 10/10 通过 | 含原 RED 转绿、同路径跨实例、展示碰撞、诊断和巡检路径 |
| Runner | 9 个 CLI、13 个 Vitest 通过 | CLI 后补 source/dist 拒绝非法 config 的验证；无真实模型调用 |
| MCP 受影响范围 | 8 文件、170/170 通过 | 配置写锁、项目扫描、Consult、Todo 读取及投影 |
| 包边界 | 11/11 通过 | 新增 Web 禁止依赖 MCP/Runner/Agent Runtime 和 Core 子路径白名单 |
| 五包类型检查、workspace build | 均通过 | 构建不是安装或激活运行时 |
| Python | 118/118 通过 | 使用项目已有 venv，未安装依赖或运行巡检 |
| 实际浏览器 | 桌面 1440×1000、手机 390×844 通过 | Edge 无头、新上下文；精确选择、刷新、归档筛选、诊断、报告、布局和页面错误检查 |
| 开发脚本与包边界组合 | 67/67 通过 | 含前述 11 项边界，不重复累计；setup/reset 只运行隔离测试，不操作用户配置 |
| Agent Runtime 与 Platform | 19/19 通过 | 现有构建态测试，包含 17 项 runtime 与 2 项 platform |
| MCP/CLI 端到端 smoke | 构建态 28/28、源码 Skill 28/28 通过 | 合成用户决定、临时 Git 仓库、模拟远端响应；不是实际用户验收 |

浏览器使用临时 HOME 与合成 v3 配置。读取前后文件指纹一致，
页面、浏览器与测试服务器已关闭；没有访问用户实际 `.contribbot`。
截图及原始结果位于
`.catpaw/discussions/phase3-claude/2026-10-02-shared-read-browser.json`
和同前缀 PNG。依赖链接使用离线、禁止脚本、冻结 lockfile 的 pnpm 命令，
只接入本地 Core workspace；没有下载包、运行 setup 或切换宿主运行时。

## 补丁审查与主助手采纳

沿原 Claude 会话完成 `2026-10-02-shared-read-implementation`，
正常退出，模型工具禁用，24 份源码快照指纹无漂移。
这次审查针对实现，不再只是先前的设计意见；顾问没有运行测试。
Claude 结论为范围内无阻断项，确认单份 schema、锁内读取、
配置错误分流、巡检路径限制、digest 选择及 Runner 公共守卫。

| Claude 意见 | 主助手判断 | 备注 |
| --- | --- | --- |
| Web 默认 HOME 在作为库调用时可能指向真实目录 | 未采纳为本轮缺陷 | 当前 server 不导出库接口，而是直接监听的独立进程；生产读用户数据根是原有行为，测试均新进程传 HOME/USERPROFILE，指纹已核对 |
| root 参数是数据根而非 HOME，宜说明 | 采纳说明，见上 | 不新增环境变量或配置字段 |
| 链接/权限检查错误统一为 config_invalid | 保持既有语义 | 不放宽安全检查，也不把新增错误码变成本轮阻塞 |
| MCP 固定错误文案与 Web 原始诊断不同 | 保持宿主既有格式 | 本次抽取不改变原 MCP 文案与错误处理顺序 |
| MCP `export *` 可进一步收窄 | 非阻断，未扩大到包根公开导出 | 只读加载本身不能绕过写入锁，外部包导出仍由既有 index 控制 |
| Windows junction 实测证据未列明 | 已核实通过、未跳过 | Core 新链接测试和 Web 巡检 junction 测试均在本机 Windows 实际运行 |
| Web 不含已归档 Todo 的契约可补显式测试 | 已补保留断言 | 当前列表仍只读 todos.yaml，不把归档数据混入统计 |

本轮通过不代表整体 schema v3 完成。完整 MCP 回归见下；
Windows 超时契约、私有 GitLab 首次初始化凭据、整体独立审查和用户验收
仍不能由上述局部结果替代。

后补的“已归档 Todo 不计入 Web 当前列表”断言已随 Web 全部 10 项复跑通过。
它只加强测试，未改变 Claude 已审查的实现代码。

## 完整 MCP 回归

`pnpm --filter contribbot-mcp exec vitest run --reporter=default --reporter=json`
并指定本轮 JSON 输出路径，最终退出码 1：89 文件、1259 项，
**1255 通过、2 失败、2 跳过**。报告为
`.catpaw/discussions/phase3-claude/2026-10-02-shared-read-mcp-tests.json`。
这次包含修正夹具后的 MCP/Runner 并发测试 3/3 和 Consult stdio 守卫。
两项失败均位于 `checks.test.ts`，分别是慢身份查询和慢进程记录发布时
对迟到写入的断言；属于此前已复现的 Windows 超时问题。
本轮没有更改该检查实现或测试要求，也未用局部通过抵消它们。

完整回归、smoke 与顾问进程均已结束，未发现本轮遗留执行进程。
用户实际 `.contribbot` 与运行时未改，全部候选仍未提交。
