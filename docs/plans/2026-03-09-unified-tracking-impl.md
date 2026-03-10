# 统一追踪 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让现有 upstream 追踪工具同时支持 fork source 追踪，消除 antdv-next 硬编码，实现三种模式自动识别。

**Architecture:** 不改数据结构（upstream.yaml / config.yaml），扩展工具层。核心变化：(1) 去除 DEFAULT_REPO / UPSTREAM 硬编码常量 (2) `upstream_daily` 支持对 fork source 拉 commits (3) 工具展示根据 config 推断关系类型。

**Tech Stack:** TypeScript, YAML (yaml package), GitHub API (gh CLI)

---

### Task 1: 去除 antdv-next 硬编码常量

**Files:**
- Modify: `src/core/utils/config.ts` — 删除 `DEFAULT_REPO_OWNER`、`DEFAULT_REPO_NAME`、`UPSTREAM_OWNER`、`UPSTREAM_NAME`、`getAntdvPackagePath`、`getComponentsDir`
- Modify: `src/core/tools/upstream-sync-check.ts` — 移除 fallback 到硬编码常量
- Modify: `src/core/clients/github.ts` — `parseRepo` 的默认值处理
- Modify: `src/mcp/server.ts` — repoParam 的 describe 去掉 antdv-next 默认值提示

**Step 1: 查看 `parseRepo` 当前实现**

Run: `grep -n "parseRepo" src/core/clients/github.ts | head -10`

确认 parseRepo 如何使用 DEFAULT_REPO 常量。

**Step 2: 修改 `src/core/utils/config.ts`**

删除以下导出：
- `DEFAULT_REPO_OWNER`
- `DEFAULT_REPO_NAME`
- `UPSTREAM_OWNER`
- `UPSTREAM_NAME`
- `getAntdvPackagePath`
- `getComponentsDir`

保留：`getGitHubToken`、`getProjectRoot`、`validatePathSegment`、`getContribDir`

**Step 3: 修改 `parseRepo` 默认值**

`parseRepo` 不再有默认 repo。如果调用时 repo 参数为空，抛出明确错误："repo is required. Pass owner/name."

**Step 4: 修改 `upstream-sync-check.ts`**

将 `UPSTREAM_OWNER` / `UPSTREAM_NAME` / `DEFAULT_REPO_OWNER` / `DEFAULT_REPO_NAME` 的 fallback 改为要求参数必传。`upstream_repo` 和 `target_repo` 改为 required 参数。

**Step 5: 修改 `src/mcp/server.ts`**

- repoParam 的 describe 改为 `'GitHub repo "owner/name"'`（去掉默认值提示）
- `upstream_sync_check` 的 `upstream_repo` 和 `target_repo` 参数从 optional 改为 required

**Step 6: 修复所有编译错误**

Run: `pnpm build 2>&1`
Expected: 编译通过

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove antdv-next hardcoded defaults"
```

---

### Task 2: config 增加模式推断工具函数

**Files:**
- Modify: `src/core/storage/repo-config.ts` — 增加 `inferMode` 工具函数
- Create: `src/core/storage/repo-config.test.ts`

**Step 1: 写测试**

```typescript
// src/core/storage/repo-config.test.ts
import { describe, it, expect } from 'vitest'
import { inferMode } from './repo-config.js'

describe('inferMode', () => {
  it('returns "own" when no fork and no upstream', () => {
    expect(inferMode({ role: 'admin', org: null, fork: null, upstream: null })).toBe('own')
  })

  it('returns "fork" when fork exists but no upstream', () => {
    expect(inferMode({ role: 'write', org: null, fork: 'darkingtail/plane', upstream: null })).toBe('fork')
  })

  it('returns "fork+upstream" when both exist', () => {
    expect(inferMode({
      role: 'write', org: 'antdv-next',
      fork: 'darkingtail/antdv-next', upstream: 'ant-design/ant-design',
    })).toBe('fork+upstream')
  })

  it('returns "upstream" when upstream exists but no fork', () => {
    expect(inferMode({ role: 'admin', org: null, fork: null, upstream: 'some/repo' })).toBe('upstream')
  })
})
```

**Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/core/storage/repo-config.test.ts`
Expected: FAIL — inferMode 不存在

**Step 3: 实现 `inferMode`**

在 `src/core/storage/repo-config.ts` 中添加：

```typescript
export type ProjectMode = 'own' | 'fork' | 'upstream' | 'fork+upstream'

export function inferMode(config: RepoConfigData): ProjectMode {
  const hasFork = config.fork !== null
  const hasUpstream = config.upstream !== null
  if (hasFork && hasUpstream) return 'fork+upstream'
  if (hasFork) return 'fork'
  if (hasUpstream) return 'upstream'
  return 'own'
}
```

**Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/core/storage/repo-config.test.ts`
Expected: PASS

**Step 5: 导出 inferMode**

在 `src/index.ts` 中添加 `inferMode` 和 `ProjectMode` 的导出。

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add inferMode utility for project mode detection"
```

---

### Task 3: `upstream_daily` 支持 fork source 追踪

**Files:**
- Modify: `src/core/tools/upstream-daily.ts`
- Modify: `src/core/clients/github.ts` — 可能需要新增获取 fork parent 的函数

**Step 1: 理解当前流程**

`upstream_daily` 接收 `upstreamRepo` 参数（显式传入），用来：
1. 拉取 releases 确定 anchor
2. compare anchor..HEAD 获取 commits
3. 在目标 repo 中搜索关联 issue/PR

对 fork source 追踪，流程一样：
- `upstreamRepo` = fork source（如 `makeplane/plane`）
- anchor = fork source 的某个 release tag
- compare anchor..HEAD on fork source
- 搜索关联 issue/PR in 目标 repo

**结论：`upstream_daily` 不需要改代码逻辑。** 它已经支持任意 `upstreamRepo`。用户只需传 fork source 的 repo 名即可。

**Step 2: 验证**

手动模拟：如果调用 `upstream_daily(upstream_repo="makeplane/plane", repo="darkingtail/plane")`，现有代码会：
1. 在 `~/.contribbot/darkingtail/plane/upstream.yaml` 中创建 `makeplane/plane` key
2. 拉取 makeplane/plane 的 releases
3. compare releases 获取 commits
4. 在 darkingtail/plane 中搜索关联

完全正确，无需改动。

**Step 3: 更新 tool description**

在 `src/mcp/server.ts` 中更新 `upstream_daily` 的 description：

```
'Fetch commits from an upstream repo (fork source or external upstream) since last tracked version. First run: shows releases to pick baseline.'
```

**Step 4: 同样更新 `upstream_daily_act` 和 `upstream_daily_skip_noise` 的 description**

确保描述不暗示只能用于跨栈场景。

**Step 5: Commit**

```bash
git add -A
git commit -m "docs: update upstream tool descriptions for fork+upstream clarity"
```

---

### Task 4: `upstream_sync_check` 支持 fork source

**Files:**
- Modify: `src/core/tools/upstream-sync-check.ts`

**Step 1: 确认现状**

`upstream_sync_check` 接收 `upstream_repo` 和 `target_repo`，已经支持任意仓库对。Task 1 中已去除默认值。

同 Task 3，**不需要改核心逻辑**。只需确保参数 required 且 description 清晰。

**Step 2: 更新 description**

```
'Compare upstream release changelog (fork source or external upstream) with target repo sync status.'
```

**Step 3: Commit（可与 Task 3 合并）**

---

### Task 5: `sync_fork` 增强 — 支持指定 source

**Files:**
- Modify: `src/core/tools/sync-fork.ts`

**Step 1: 确认现状**

`sync_fork` 从 config.fork 读取 fork repo，用 `gh repo sync` 同步。

当前只同步 main（或指定 branch）。对 plane 场景足够：
- `sync_fork(repo="darkingtail/plane")` → 同步 main
- `sync_fork(repo="darkingtail/plane", branch="feature/dev")` → ⚠️ 这不对，feature/dev 不应该从上游同步

**Step 2: 无需改动**

`sync_fork` 只负责 main 对齐 upstream main，这是正确的。feature/dev 的选择性 cherry-pick 是手动 git 操作，不是 sync_fork 的职责。

---

### Task 6: INSTRUCTIONS 更新

**Files:**
- Modify: `src/mcp/server.ts` — INSTRUCTIONS 字符串

**Step 1: 更新工具组合逻辑**

在 INSTRUCTIONS 中补充：
- 说明三种项目模式（own / fork / fork+upstream）
- 说明 `upstream_daily` 既可用于跨栈追踪也可用于 fork source 追踪
- 添加 Agent 行为规则：首次进入项目时用 `repo_config` 查看模式，决定可用工作流

**Step 2: 更新注意事项**

- 移除"大多数工具的 repo 参数默认 antdv-next/antdv-next"
- 改为"repo 参数必传，格式 owner/name"

**Step 3: Commit**

```bash
git add -A
git commit -m "docs: update MCP instructions for multi-mode support"
```

---

### Task 7: CLAUDE.md 和 ROADMAP.md 同步更新

**Files:**
- Modify: `CLAUDE.md` — 更新工具清单，移除 antdv-next 专属引用
- Modify: `ROADMAP.md` — 更新 Phase 1 已完成内容

**Step 1: CLAUDE.md**

- 移除 `vc_dependency_status` 行（已在本次删除）✅
- 移除 `component_test_coverage` 行（已在本次删除）✅
- 更新工具数量：37 → 35
- 添加三种模式说明
- 更新全局 MCP 配置示例（移除 macOS 路径，改为通用描述）

**Step 2: ROADMAP.md**

- Phase 1 Tools 数量更新
- 添加"统一追踪：fork / upstream 共用 upstream.yaml"到已完成列表

**Step 3: Commit**

```bash
git add -A
git commit -m "docs: sync CLAUDE.md and ROADMAP.md with unified tracking"
```

---

### Task 8: daily-sync Prompt 更新

**Files:**
- Modify: `src/mcp/server.ts` — daily-sync prompt

**Step 1: 更新 Prompt 逻辑**

当前 daily-sync 假设 fork + upstream 都存在。需要根据模式调整工作流：

- **own**: 无 daily-sync 需要
- **fork**: sync_fork → upstream_daily(fork source) → skip noise → triage
- **fork+upstream**: sync_fork → upstream_daily(fork source) + upstream_daily(upstream) → skip noise → triage

Prompt 文本改为先说明"根据项目模式执行"，列出不同模式的步骤。

**Step 2: Commit**

```bash
git add -A
git commit -m "feat: update daily-sync prompt for multi-mode workflows"
```

---

## 总结

| Task | 类型 | 说明 |
|------|------|------|
| 1 | refactor | 去除 antdv-next 硬编码 |
| 2 | feat | inferMode 工具函数 + 测试 |
| 3 | docs | upstream_daily description 更新（逻辑无需改） |
| 4 | docs | upstream_sync_check description 更新（逻辑无需改） |
| 5 | — | sync_fork 无需改动 |
| 6 | docs | INSTRUCTIONS 更新 |
| 7 | docs | CLAUDE.md + ROADMAP.md 同步 |
| 8 | feat | daily-sync Prompt 多模式支持 |

关键发现：**upstream_daily 和 upstream_sync_check 的核心逻辑已经是通用的**，只是描述文案和默认值绑死了 antdv-next。主要工作是去硬编码 + 更新文档。
