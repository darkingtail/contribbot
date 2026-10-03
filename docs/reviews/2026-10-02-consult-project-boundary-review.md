# Consult 项目身份边界：复现与修复

日期：2026-10-02，Asia/Shanghai。
状态：**MCP 入口已修复，定向回归通过；不代表 schema v3 整体验收。**

## 已核实的缺口

此前 `consultStore(repo)` 只解析三字段身份、计算目录并构造 Consult store，
没有加载严格 v3 配置。临时 HOME 中实际运行新增
`consult-project-boundary.test.ts`，4 项中 1 通过、3 失败：

| 场景 | 修复前实际结果 | 备注 |
| --- | --- | --- |
| 合法项目，无 Todo，独立咨询 | 预留成功 | 原有独立咨询能力应保留；没有调用 Provider |
| 未初始化项目 | 仍接受预留并返回 Runner 参数 | 不应通过 Consult 隐式创建项目数据 |
| 已有咨询，config 改为 v2 | 仍返回咨询列表 | 严格配置边界被绕过 |
| config 中的主体与目录 digest 不符 | 仍返回咨询列表 | 不能仅依赖调用参数计算目录后直接读取 |

原始 RED 报告：
`.catpaw/discussions/phase3-claude/2026-10-02-consult-project-boundary-red.json`。
所有数据均为临时夹具；没有访问活动 `.contribbot`、启动 Provider 或修改用户 Todo。

## Claude 意见与采纳边界

沿原会话完成真实、工具禁用的只读咨询，记录前缀为
`.catpaw/discussions/phase3-claude/2026-10-02-consult-project-boundary`。
调用正常结束、输入快照无漂移。顾问依据已接受契约 §3/§5 判断：
这是既有严格项目边界的漏检，不是新增“Consult 必须关联 Todo”的规则。
建议在公共 store 工厂中复用现有 `RepoConfig.load()`，
保持参数解析 → 配置校验 → 构造 store 的顺序。

主助手核对路由后采纳该最小修复，未引入新的配置字段、依赖边、生命周期
规则或降级读取。顾问没有运行测试，也没有审查修改后的最终补丁；
本次意见不能称为最终代码独立验收。

直接构造低层 store 的其他入口已区分：
Todo 投影由已验证项目的 Todo 路由调用；
Runner 仍直接接受 `--directory`，不能反向依赖 MCP。Runner 的项目配置
校验仍须与待用户确认的共享 Core 读取方案一起处理，本轮没有复制解析器
或改 Runner。低层 store 单元测试也不等同于 MCP 入口测试。

## 修改与验证

`consult.ts` 的公共工厂现在先读取严格配置，缺失则报 not initialized；
损坏、非规范身份、digest 不符或路径链接由现有校验拒绝。
prepare/request/status/read/control/decide/purge 均经过该入口。
退役 `consult_start` 只返回替代说明，不读写项目，保留现状。

新增的 20 项边界测试覆盖七条读写路由、未创建目录、坏配置时记录不变、
身份不符、祖先目录链接、无 Todo 独立咨询与退役入口不初始化。
真实 stdio 测试增加坏 config 时返回工具错误且咨询文件字节不变的断言。
既有服务测试夹具现在先创建合法 v3 配置；其说明入口测试改为断言已有
配置和目录完全不变，另有专门的未初始化说明入口测试，未放宽只读要求。

另在配置测试中补齐 18 个合法状态组合及 14 个非法形状，共新增 32 项；
包括三个 parent 状态、三个 tracking 状态、两个 lifecycle 状态，
parent 同时作为 tracking 来源、不同实例同路径来源，以及禁止的 null、
重复来源和未知字段。该文件单独运行 48/48 通过，未修改配置解析行为。

| 验证 | 结果 | 备注 |
| --- | --- | --- |
| 首次 Consult 组合回归 | 79 通过、1 失败 | 失败为统一初始化夹具与旧“数据根不存在”断言冲突，原报告保留 |
| 最终受影响回归 | 14 文件、168/168 通过 | 包括 Consult 核心、并发锁、Todo 读取一致性、入口、stdio、配置及项目生命周期 |
| MCP typecheck | 退出码 0 | 最终夹具修正后再次运行 |
| MCP build | 退出码 0 | 构建不是安装或当前会话 MCP 重载 |
| 手动真实顾问 smoke 脚本 | 已换三字段参数和 v3 临时夹具，语法检查通过 | 本次没有执行真实模型 smoke，不能声称模型链路通过 |

首次组合报告：
`.catpaw/discussions/phase3-claude/2026-10-02-consult-project-boundary-focused.json`。
最终报告：
`.catpaw/discussions/phase3-claude/2026-10-02-consult-project-boundary-regression.json`。
状态矩阵报告：
`.catpaw/discussions/phase3-claude/2026-10-02-config-state-matrix.json`。

没有重跑全量 MCP，也未修改 Windows 超时失败的断言或契约。
Web 的已知 RED、Runner 共享读取、私有 GitLab 初始化与最终同候选独立复核
仍未完成。所有改动留在未提交工作区；未提交、推送、迁移、清空数据或
改变用户 Todo 生命周期。
