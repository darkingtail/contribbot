# GitHub 写入工具 + 全局能力设计

[TOC]

## 背景

现有 27 个工具全部是读取 + 本地 YAML 写入，缺少 GitHub 写入能力。Agent 需要完整的读写闭环才能自主工作。

## 基础层扩展

### ghApi 写入支持

当前 `ghApi` 只支持 GET 请求，需要扩展支持全 HTTP method + body。

**改动文件**：`src/core/clients/github.ts`

```typescript
// ghApi 签名扩展
export async function ghApi<T>(
  path: string,
  params?: Record<string, string | number>,
  extra?: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
    body?: Record<string, unknown>
    args?: string[]
    headers?: Record<string, string>
  },
): Promise<T>
```

gh CLI 后端通过 `--method POST --input -` 传 body，token 后端通过 `fetch({ method, body })` 传 body。

### 新增 Helper 函数

与现有 `get*` / `search*` 对称，新增 `create*` / `update*` 系列：

```typescript
// Issue 写入
export async function createIssue(owner, repo, title, body?, labels?): Promise<GitHubIssue>
export async function closeIssue(owner, repo, issueNumber): Promise<void>

// PR 写入
export async function createPull(owner, repo, title, head, base, body?, draft?): Promise<GitHubPull>
export async function updatePull(owner, repo, prNumber, fields): Promise<GitHubPull>

// 评论（issue 和 PR 共用 API）
export async function createComment(owner, repo, issueNumber, body): Promise<GitHubComment>

// Review 回复
export async function getPullReviewComments(owner, repo, prNumber): Promise<GitHubReviewComment[]>
export async function replyToReviewComment(owner, repo, prNumber, commentId, body): Promise<GitHubComment>

// 用户事件（贡献统计用）
export async function getUserEvents(username, perPage?): Promise<GitHubEvent[]>
```

## 工具设计

### 1. issue_create — 创建 Issue

**Agent 场景**：追踪上游 commit 发现需要同步的问题 → 自主在目标仓库开 issue → 自动关联 upstream daily commit → 自动创建 todo。

| 参数 | 必须 | 说明 |
|------|------|------|
| `title` | 是 | Issue 标题 |
| `body` | 否 | Issue 描述 |
| `labels` | 否 | 标签列表，逗号分隔 |
| `upstream_sha` | 否 | 关联的 upstream daily commit SHA |
| `upstream_repo` | 否 | upstream_sha 对应的上游仓库 |
| `auto_todo` | 否 | 是否自动创建对应的 todo，默认 true |
| `repo` | 否 | 目标仓库 |

**行为**：
1. 调 `createIssue` 创建 issue
2. 如果传了 `upstream_sha` + `upstream_repo`，调 `UpstreamStore.updateDailyCommit` 标记 action=issue, ref=#{issueNumber}
3. 如果 `auto_todo` 为 true，调 `TodoStore.add` 创建 todo，ref=#{issueNumber}
4. 返回 issue 链接 + 关联结果

### 2. issue_close — 关闭 Issue

**Agent 场景**：PR 合并后自主关闭对应 issue。

| 参数 | 必须 | 说明 |
|------|------|------|
| `issue_number` | 是 | Issue 编号 |
| `comment` | 否 | 关闭时附带的评论 |
| `todo_item` | 否 | 关联的 todo（自动标记 done） |
| `repo` | 否 | 目标仓库 |

**行为**：
1. 如果传了 `comment`，先调 `createComment` 添加关闭说明
2. 调 `closeIssue` 关闭 issue（PATCH state=closed）
3. 如果传了 `todo_item`，调 `TodoStore.update` 标记 done
4. 返回关闭确认

### 3. comment_create — 评论（Issue/PR 通用）

**Agent 场景**：补充信息、回复提问、更新进展、沟通讨论。

| 参数 | 必须 | 说明 |
|------|------|------|
| `number` | 是 | Issue 或 PR 编号 |
| `body` | 是 | 评论内容（markdown） |
| `repo` | 否 | 目标仓库 |

**行为**：调 `createComment` → 返回评论链接

### 4. pr_create — 创建 PR

**Agent 场景**：完成开发 → 自主提 PR → 自动关联 todo → 自动生成描述。

| 参数 | 必须 | 说明 |
|------|------|------|
| `title` | 是 | PR 标题 |
| `head` | 是 | 源分支（格式：`user:branch` 或 `branch`） |
| `base` | 否 | 目标分支，默认 repo default branch |
| `body` | 否 | PR 描述 |
| `draft` | 否 | 是否草稿，默认 false |
| `todo_item` | 否 | 关联的 todo（index 或文本），自动设 pr + status=pr_submitted |
| `repo` | 否 | 目标仓库 |

**行为**：
1. 调 `createPull` 创建 PR
2. 如果传了 `todo_item`，调 `TodoStore` 查找匹配的 todo，更新 pr 和 status=pr_submitted
3. 返回 PR 链接 + 关联结果

### 5. pr_update — 更新 PR

**Agent 场景**：根据 review 反馈修改 PR 标题/描述，或者将草稿转正式。

| 参数 | 必须 | 说明 |
|------|------|------|
| `pr_number` | 是 | PR 编号 |
| `title` | 否 | 新标题 |
| `body` | 否 | 新描述 |
| `draft` | 否 | 草稿状态 |
| `state` | 否 | open / closed |
| `repo` | 否 | 目标仓库 |

**行为**：调 `updatePull` → 返回更新确认

### 6. pr_review_reply — 回复 Review Comment

**Agent 场景**：收到 code review → 查看行级评论 → 逐条回复。

| 参数 | 必须 | 说明 |
|------|------|------|
| `pr_number` | 是 | PR 编号 |
| `comment_id` | 是 | Review comment ID |
| `body` | 是 | 回复内容 |
| `repo` | 否 | 目标仓库 |

**前置依赖**：需要新增 `pr_review_comments` 工具（或扩展现有 `pr_summary`）列出所有 review comments 及其 ID。

**行为**：调 `replyToReviewComment` → 返回回复确认

**新增辅助工具 `pr_review_comments`**：

| 参数 | 必须 | 说明 |
|------|------|------|
| `pr_number` | 是 | PR 编号 |
| `repo` | 否 | 目标仓库 |

返回所有 review comments 列表，包含 comment_id、author、body、diff_hunk、path、line。Agent 需要这个来决定回复哪些评论。

### 7. project_list — 全局项目概况

**Agent 场景**：启动时扫描所有项目，判断哪个需要关注。

| 参数 | 无 |
|------|---|

**行为**：
1. 扫描 `~/.contrib/` 下所有 `{owner}/{repo}` 目录
2. 读取每个项目的 `todos.yaml` 统计 open/done
3. 读取每个项目的 `upstream.yaml` 统计 pending/tracked commits
4. 读取文件修改时间作为「最后更新」

**输出示例**：

| 项目 | Todos (open/done) | Upstream (pending/total) | 最后活跃 |
|------|-------------------|--------------------------|----------|
| antdv-next/antdv-next | 3 / 4 | 12 / 30 | 2026-03-03 |
| makeplane/plane | 1 / 0 | — | 2026-03-03 |
| agentscope-ai/CoPaw | 0 / 0 | — | 2026-03-02 |

### 8. contribution_stats — 个人贡献统计

**Agent 场景**：自我评估贡献节奏，发现哪些项目需要更多关注。

| 参数 | 必须 | 说明 |
|------|------|------|
| `days` | 否 | 统计周期天数，默认 7 |
| `author` | 否 | GitHub 用户名，默认当前用户 |
| `repo` | 否 | 目标仓库。传 `all` 则统计所有已配置项目 |

**行为**：
1. 如果 `repo=all`，从 `~/.contrib/` 读取所有项目列表
2. 对每个项目查 GitHub API：
   - PRs created（`search/issues?q=type:pr+author:{user}+repo:{repo}+created:>={since}`）
   - Issues opened
   - PRs reviewed（`search/issues?q=type:pr+reviewed-by:{user}+repo:{repo}`）
   - Commits authored
3. 汇总输出

**输出示例**：

```
## 贡献统计（最近 7 天）

| 指标 | antdv-next/antdv-next | makeplane/plane | 合计 |
|------|----------------------|-----------------|------|
| PRs 创建 | 3 | 1 | 4 |
| Issues 创建 | 2 | 0 | 2 |
| Reviews | 5 | 0 | 5 |
| Commits | 12 | 3 | 15 |
```

## 实现顺序

按依赖关系排序：

1. **基础层**：扩展 `ghApi` 支持 POST/PATCH/DELETE + 新增 helper 函数
2. **comment_create**：最简单的写入工具，用来验证基础层
3. **issue_create** + **issue_close**：Issue 写入闭环
4. **pr_create** + **pr_update**：PR 写入闭环
5. **pr_review_comments** + **pr_review_reply**：Review 交互闭环
6. **project_list**：纯本地，无 API 依赖
7. **contribution_stats**：纯查询，独立实现

## INSTRUCTIONS 更新

在 MCP Server 的 INSTRUCTIONS 中补充 Agent 行为规则：

- 创建 PR 后，如果有对应的 active todo，自动调 `todo_update` 关联
- 创建 issue 后，如果来自 upstream daily，自动调 `upstream_daily_act` 关联
- 关闭 issue 时，如果有对应的 todo，自动标记 done
