# contribbot 协作现状与 Phase 3 讨论

日期：2026-09-16。状态：测试空间已建立；Claude 两轮讨论完成；产品建议待用户决定。未实施新业务功能，未 stage/commit/push。

## 四个长期角色

本记录更新此前 worktree-workflow.md 的初步建议：当前设计留在主协调任务，不再另开 design；增加长期测试任务。旧文档中的“暂未创建”是当时状态，不是现在状态。长期复用的是会话和职责，不是无限堆积改动的永久业务分支。

| 角色 | 任务 | 路径 | 备注 |
|---|---|---|---|
| 协调与设计 | phase-3 | D:/dev/darkingtail/contribbot | main；统一范围、派工和采纳；保留未提交成果 |
| 开发 | contribbot · 开发 | C:/Users/WANGX/.codex/worktrees/3925/contribbot | 新功能；尚未派实现 |
| 修复 | contribbot · 修复 | C:/Users/WANGX/.codex/worktrees/d3fa/contribbot | 复现、最小补丁、回归；尚未派实现 |
| 独立测试 | contribbot · 测试 | C:/Users/WANGX/.codex/worktrees/046f/contribbot | 已只读初始化并待命；默认不改业务代码 |

测试 task ID：01a0a87e-156a-7f62-b6b3-bb80200ea9b8。全部路由保存在 D:/dev/darkingtail/contribbot/.catpaw/discussions/phase3-claude/routes.json。

新测试目录是 detached HEAD=f25650ff36dcab3861d1ebd8bbd7babc34ce9a97，Git status 为空。它不含 main 未提交改动；本次没有验收业务功能。派测必须提供精确候选、基线、命令、数据位置和验收。测试失败返回协调者，由修复任务处理；检查者不暗中改变受检对象。

main 可以复核和自测；高风险验收仍需不同于实现者的独立检查。四个开发协作任务不等于 contribbot 产品已经具备 Agent Team。用户可以留在协调任务提出需求；未配置后台自动派工或永久轮询。

## 本轮 Claude 讨论覆盖

- 已有产品：MCP 原子工具 + Skills；Python 巡检 runtime；只读 Web；四种项目关系与全局视图。
- 已有 Phase 3：单仓巡检、调查、Run/Action、resume、跨仓批次/调度、显式 worktree remediation，以及知识 propose/apply/reject/rollback。
- 未提交候选：本地开发 setup/check/remove、项目归档/恢复跨 MCP/Agent/Web、自测 data:reset、工作空间设计；保留历史验证，不重新开发。
- 当前缺口：init 的 upstream null 未区分未确认与明确无；统一数据根隔离尚未实现；业务效果尚需真实用户案例检验；工作空间需精确候选交接。
- 未来：优先验证仓库级知识是否减少重复解释；Agent Team、跨仓记忆、更多 UI、奖励/悬赏与 payout 暂不扩展。

源码证据入口：packages/agent/src/contribbot_agent/{patrol,backend,models,report,orchestrator}.py；packages/mcp/src/core/tools/core/knowledge-evolution.ts；skills/init/SKILL.md；repo-config-tool.ts。Claude 仅接收本轮提供的源码/文档快照，不直接读取工作区，不运行测试。设计文档中的“已验证”不自动等于本轮验收。

## 两轮往返与主协调者判断

### 第一轮：全貌与价值切片

Claude 建议“用一次 → 记一条 → 下次有用”，反对继续堆框架；提出从真实维护决策出发，而不是先决定要多少 Agent。

### 第二轮：反驳、补证据、收敛

主协调者补充知识实现和分析源码，并纠正：

- Web 已在 HEAD，不是整块未提交；不能用看不到使用数据推断用户从未获得价值。
- upstream 确认语义缺失，不代表代码混淆 fork parent、Git remote、跨栈 upstream。
- 知识去重、应用/拒绝/回滚、knowledge_used 已存在，不重造。
- 两次实时巡检的回答不同可能来自输入变化或模型随机性；不是知识生效的充分证据。
- upstream 确认修复牵涉兼容、入口与测试，不是“只改一个字段”，也不应捆绑知识试用。

Claude 在同一 session 的第二轮明确修正了这些表述。

### 采纳为讨论方向（不是用户已批准的实现）

1. 先让现有能力在一个真实案例上有用：少重复解释仓库约定。
2. 复用已有候选→人工审核→正式知识→下次读取的链路，缺什么才补什么。
3. 先约定验收，再跑案例；结果可以不变，但依据要正确遵守知识。仅有 knowledge_used 自报不够，需要检查具体理由与适用范围。
4. 分清机械接线验证、相同输入的受控检查、真实任务价值。受控检查可用测试夹具直接调用现有 Analyzer，不必先新增产品 CLI。真实案例有效也不能夸大成因果证明。
5. 数据隔离是并行有状态测试的前置，不阻塞现在的只读设计。

### 未直接采纳的第二轮意见

- “main 不验证自己的改动”过强：主协调者仍负责复核；自测不能替代高风险独立检查。
- “修复任务负责全部未提交成果”不采纳：按明确 Work 分工，不因为角色名改变已有成果归属。
- 不能仅从 actions.json 计算误报率：接受/拒绝并非真伪标签，需要用户反馈或核实结果。
- 不为做受控比较强制增加生产命令；先利用测试夹具和已有 Analyzer。
- 没观察到效果时先诊断案例、输入和理由，不机械认为必须加代码。

## 建议路线与尚需用户回答

1. 收尾已有候选：复用适用历史 Evidence，只补缺口。先确定候选交接和隔离数据，不能将新 worktree 的旧 HEAD 当成当前实现。
2. 选择一个真实维护案例，明确一条有证据的仓库知识及其适用范围；用现有链路验证下次确实读到并合理遵守。无变化也如实记录，不为了演示抑制合理告警。
3. 仅在真实案例暴露必要缺口时派发最小修复/开发，由独立测试验收。
4. 多 Agent、自主公共写入、跨仓记忆等后续重新评估，不自动进入实施。

**需要用户的一个具体例子：最近一次，你在哪个仓库向 AI 重新解释了什么约定或背景？它影响了什么决定，是单仓约定还是多个仓库共用？** 不要求用户先定义架构；回答这个例子后继续同一 Claude 会话。

upstream 方案仍是待评估选项：交互 init 询问；非交互显示未确认的覆盖缺口；不擅自补 ant-design，也不必阻断无关维护。此文不是变更批准。

## Claude 持久入口与审计

- CatPaw cc 只读配方；本机无 tmux，按用户要求回退到 claude -p / --resume。
- Session ID：f2d3b361-fd7b-4289-832a-aa10f76a2cd7。
- cwd：D:/dev/darkingtail/contribbot。
- 两轮进程 exit=0，实际返回 session_id 与固定 ID 一致；第二轮实际用了 --resume，不是重新开会话。
- 参数：safe-mode、permission-mode plan、tools 空列表、disallowedTools Edit,Write,NotebookEdit、strict-mcp-config。不使用 no-session-persistence。使用现有 Claude 登录，不读取或修改凭据。
- 原始输入/输出、stderr、命令数组、时间、退出码：D:/dev/darkingtail/contribbot/.catpaw/discussions/phase3-claude/。
- 恢复说明：该目录 README.md。只在当前轮结束后串行续聊；长期是持久上下文，不是常驻进程或自动化。
- 原始讨论含本机路径和源码快照，仅本地保留；后续提交前单独审查，不默认发布全部原件。

## 验证边界

本轮核验：测试 worktree 干净且基线正确；两轮同一 session 实际成功；现有 175 个非看板文件哈希、main HEAD 和 index 保持不变。新增的是本说明和 CatPaw 工作/讨论记录。

历史 Node 35 / MCP 135 / Agent 35 等结果保留，本轮未重跑，不将其当作全部当前候选通过。业务测试、跨平台和浏览器验收仍按原 Work 补齐。未修改真实 ~/.contribbot 或全局开发配置，未提交或推送。
