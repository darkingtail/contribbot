# Phase 2 修复记录：CI 范围与 fork triage 证据

> 日期：2026-09-05
> 分支：`main`
> 状态：代码修复已完成，尚未提交

## 背景

Phase 2 的两个质量问题会让工作流产生不可靠结论：

1. `pre-submit` 可能把仓库最近一次成功的 CI 当成目标 PR 的 CI。
2. `fork-triage` 主要依赖 commit 摘要，缺少 changed files、patch 和二开分支差异证据，容易在证据不足时误判 cherry-pick 风险。

## 修复一：PR 专属 CI 检查

### 变更

- `actions_status` 新增可选参数 `pr_number`。
- 传入 PR 编号后，先读取 PR 的 head SHA。
- workflow runs 使用该 SHA 查询；同时读取该 SHA 的 check runs。
- 输出明确标注检查范围，避免将仓库最近运行结果冒充目标 PR 结果。
- `skills/pre-submit/SKILL.md` 要求必须传入 `pr_number`，并以目标 PR 的 checks 判断合并准备状态。

### 结果

`pre-submit` 现在基于目标 PR head SHA 的实际运行记录做判断；当 check-runs 暂时不可用时，仍保留 workflow runs，并明确不把缺失证据当成通过。

## 修复二：fork triage 补充证据

### 新增工具

- `commit_detail(repo, ref)`：读取 commit message、作者、统计、changed files 和有长度上限的 patch 摘要。
- `compare_refs(repo, base, head)`：读取二开分支相对默认分支的 ahead/behind 状态和 changed files。

### 工作流变化

`fork-triage` 现在先收集上游 commit 与本地二开分支的文件证据，再判断：

- 是否与二开范围相关；
- 是否存在潜在冲突；
- 是否值得 cherry-pick；
- 是否只能观察等待。

GitHub 未返回 patch，或二开分支名称不明确时，工作流必须标记“观察/证据不足”，不得猜测“无冲突”。

## 受影响文件

- `packages/mcp/src/core/clients/github.ts`
- `packages/mcp/src/core/tools/compat/actions-status.ts`
- `packages/mcp/src/core/tools/compat/repo-investigation.ts`
- `packages/mcp/src/mcp/server.ts`
- `packages/mcp/src/mcp/server.test.ts`
- `packages/mcp/src/core/tools/compat/actions-status.test.ts`
- `packages/mcp/src/core/tools/compat/repo-investigation.test.ts`
- `skills/pre-submit/SKILL.md`
- `skills/fork-triage/SKILL.md`

## 验证

| 阶段 | 命令 | 结果 |
|---|---|---|
| BASELINE | `pnpm test` | 11 个测试文件、107 个测试通过；退出状态 `0` |
| MODIFIED | `pnpm test` | 15 个测试文件、117 个测试通过；退出状态 `0` |
| MODIFIED | `pnpm build` | 构建完成；退出状态 `0` |
| MODIFIED | `git diff --check` | 无空白错误；退出状态 `0` |

## 后续

- 本文档与代码修复一起作为 Phase 2 质量收尾提交。
- Patrol / Phase 3 的未提交改动不应混入本次修复提交。
- 后续可以补充真实 GitHub API fixture，覆盖 PR head SHA、缺失 patch 和跨分支文件重叠场景。
