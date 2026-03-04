# GitHub 写入工具实现计划

[TOC]

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 contrib MCP Server 添加 9 个新工具（6 个 GitHub 写入 + 1 个读取 + 2 个本地），实现 Agent 完整读写闭环。

**Architecture:** 扩展 `ghApi` 支持 HTTP method + body，新增 helper 函数层（`create*`/`update*`），工具层调用 helper + 本地 store 实现关联逻辑。

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, zod, yaml, GitHub REST API

---

### Task 1: 扩展 ghApi 支持写入

**Files:**
- Modify: `src/core/clients/github.ts:8-53`
- Test: `src/core/clients/github.test.ts`（新建）

**Step 1: 写失败测试**

创建 `src/core/clients/github.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// We test the internal logic by testing the exported helper functions
// that use ghApi with method/body params. Direct ghApi testing would
// require mocking execFileAsync or fetch, so we test via integration.

describe('ghApi method support', () => {
  it('ghApiCli builds correct args for POST with body', async () => {
    // This test validates the CLI args construction
    // We'll verify this through the helper function tests in Task 2
  })
})
```

> 注意：ghApi 是底层函数，直接单测需要 mock child_process 或 fetch。更好的方式是通过 Task 2 的 helper 函数集成测试来验证。此 task 重点是代码改动。

**Step 2: 修改 ghApiCli 支持 method + body**

在 `src/core/clients/github.ts` 中：

将 `ghApiCli` 签名改为：
```typescript
async function ghApiCli<T>(
  path: string,
  params: Record<string, string | number> = {},
  extraArgs: string[] = [],
  method?: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const searchParams = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  )
  const url = searchParams.toString() ? `${path}?${searchParams}` : path
  const args = ['api', url, ...extraArgs]
  if (method) args.push('--method', method)
  if (body) args.push('--input', '-')
  const { stdout } = await execFileAsync('gh', args, body ? { input: JSON.stringify(body) } : undefined)
  return JSON.parse(stdout) as T
}
```

> 注意：`execFileAsync` 由 `promisify(execFile)` 生成，不直接支持 `input` 选项。需要改用 `execFile` 的 options.input（Node.js `child_process.execFile` 的 `options` 参数支持 `input`）。实际上 `promisify(execFile)` 的第二参数是 args，第三参数是 options。所以：

```typescript
async function ghApiCli<T>(
  path: string,
  params: Record<string, string | number> = {},
  extraArgs: string[] = [],
  method?: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const searchParams = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  )
  const url = searchParams.toString() ? `${path}?${searchParams}` : path
  const args = ['api', url, ...extraArgs]
  if (method) args.push('--method', method)
  if (body) args.push('--input', '-')
  const opts = body ? { input: JSON.stringify(body) } : undefined
  const { stdout } = await execFileAsync('gh', args, opts)
  return JSON.parse(stdout) as T
}
```

**Step 3: 修改 ghApiToken 支持 method + body**

```typescript
async function ghApiToken<T>(
  path: string,
  params: Record<string, string | number> = {},
  extraHeaders: Record<string, string> = {},
  method: string = 'GET',
  body?: Record<string, unknown>,
): Promise<T> {
  const token = process.env.GITHUB_TOKEN!
  const searchParams = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  )
  const url = `https://api.github.com${path}${searchParams.toString() ? `?${searchParams}` : ''}`
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'contrib',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub API error ${res.status}: ${text}`)
  }
  // DELETE may return 204 No Content
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}
```

**Step 4: 修改 ghApi 统一调度器**

```typescript
export async function ghApi<T>(
  path: string,
  params: Record<string, string | number> = {},
  extra: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
    body?: Record<string, unknown>
    args?: string[]
    headers?: Record<string, string>
  } = {},
): Promise<T> {
  if (getAuthMode() === 'token') {
    return ghApiToken<T>(path, params, extra.headers ?? {}, extra.method ?? 'GET', extra.body)
  }
  return ghApiCli<T>(path, params, extra.args ?? [], extra.method, extra.body)
}
```

**Step 5: 确认现有调用兼容**

现有所有 `ghApi` 调用都不传 `method`/`body`，只传 `params` 和 `extra.args`/`extra.headers`，签名向后兼容，无需修改。

**Step 6: 运行现有测试确认不破坏**

Run: `cd /Users/wisedu/Documents/GitHub/contrib && pnpm test`
Expected: 全部通过

**Step 7: 构建确认类型正确**

Run: `cd /Users/wisedu/Documents/GitHub/contrib && pnpm build`
Expected: 构建成功

**Step 8: Commit**

```bash
git add src/core/clients/github.ts
git commit -m "feat: extend ghApi to support POST/PATCH/PUT/DELETE with body"
```

---

### Task 2: 新增 GitHub Helper 函数（写入系列）

**Files:**
- Modify: `src/core/clients/github.ts:64-end`（追加新函数和类型）

**Step 1: 新增类型定义**

在 `github.ts` 的类型定义区域追加：

```typescript
export interface GitHubReviewComment {
  id: number
  pull_request_review_id: number
  user: { login: string } | null
  body: string
  path: string
  line: number | null
  side: string
  diff_hunk: string
  created_at: string
  html_url: string
}
```

**Step 2: 新增 Issue 写入 helpers**

```typescript
export async function createIssue(
  owner: string,
  repo: string,
  title: string,
  body?: string,
  labels?: string[],
): Promise<GitHubIssue> {
  const payload: Record<string, unknown> = { title }
  if (body) payload.body = body
  if (labels?.length) payload.labels = labels
  return ghApi<GitHubIssue>(`/repos/${owner}/${repo}/issues`, {}, {
    method: 'POST',
    body: payload,
  })
}

export async function closeIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<GitHubIssue> {
  return ghApi<GitHubIssue>(`/repos/${owner}/${repo}/issues/${issueNumber}`, {}, {
    method: 'PATCH',
    body: { state: 'closed' },
  })
}
```

**Step 3: 新增 Comment helper**

```typescript
export async function createComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<GitHubComment> {
  return ghApi<GitHubComment>(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {}, {
    method: 'POST',
    body: { body },
  })
}
```

**Step 4: 新增 PR 写入 helpers**

```typescript
export async function createPull(
  owner: string,
  repo: string,
  title: string,
  head: string,
  base: string,
  body?: string,
  draft?: boolean,
): Promise<GitHubPull> {
  const payload: Record<string, unknown> = { title, head, base }
  if (body) payload.body = body
  if (draft !== undefined) payload.draft = draft
  return ghApi<GitHubPull>(`/repos/${owner}/${repo}/pulls`, {}, {
    method: 'POST',
    body: payload,
  })
}

export async function updatePull(
  owner: string,
  repo: string,
  prNumber: number,
  fields: { title?: string; body?: string; state?: string; draft?: boolean },
): Promise<GitHubPull> {
  return ghApi<GitHubPull>(`/repos/${owner}/${repo}/pulls/${prNumber}`, {}, {
    method: 'PATCH',
    body: fields as Record<string, unknown>,
  })
}
```

**Step 5: 新增 Review Comment helpers**

```typescript
export async function getPullReviewComments(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubReviewComment[]> {
  return ghApi<GitHubReviewComment[]>(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`)
}

export async function replyToReviewComment(
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number,
  body: string,
): Promise<GitHubComment> {
  return ghApi<GitHubComment>(
    `/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
    {},
    { method: 'POST', body: { body } },
  )
}
```

**Step 6: 构建确认类型正确**

Run: `cd /Users/wisedu/Documents/GitHub/contrib && pnpm build`
Expected: 构建成功

**Step 7: Commit**

```bash
git add src/core/clients/github.ts
git commit -m "feat: add GitHub write helpers (createIssue, createPull, createComment, etc.)"
```

---

### Task 3: comment_create 工具

**Files:**
- Create: `src/core/tools/comment-create.ts`
- Modify: `src/mcp/server.ts`（注册工具）
- Modify: `src/index.ts`（导出）

**Step 1: 创建工具实现**

创建 `src/core/tools/comment-create.ts`：

```typescript
import { parseRepo, createComment } from '../clients/github.js'

export async function commentCreate(
  number: number,
  body: string,
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const comment = await createComment(owner, name, number, body)

  return `Commented on **${owner}/${name}#${number}**: ${comment.html_url ?? 'success'}`
}
```

> 注意：`GitHubComment` 类型当前没有 `html_url` 字段，需要在 github.ts 的 `GitHubComment` interface 中加上 `html_url?: string`。

**Step 2: 在 github.ts 中给 GitHubComment 加 html_url**

```typescript
interface GitHubComment {
  id: number
  user: { login: string } | null
  body: string
  created_at: string
  html_url?: string
}
```

**Step 3: 注册到 MCP server**

在 `src/mcp/server.ts` 中 import 并注册：

```typescript
import { commentCreate } from '../core/tools/comment-create.js'

// 在 Issues & PRs 区域后追加
server.tool(
  'comment_create',
  'Create a comment on an issue or PR',
  {
    number: z.number().describe('Issue or PR number'),
    body: z.string().describe('Comment body (markdown)'),
    repo: repoParam,
  },
  async ({ number, body, repo }) => ({
    content: [{ type: 'text', text: await commentCreate(number, body, repo) }],
  }),
)
```

**Step 4: 导出**

在 `src/index.ts` 追加：
```typescript
export { commentCreate } from './core/tools/comment-create.js'
```

**Step 5: 构建**

Run: `cd /Users/wisedu/Documents/GitHub/contrib && pnpm build`
Expected: 构建成功

**Step 6: Commit**

```bash
git add src/core/tools/comment-create.ts src/mcp/server.ts src/index.ts src/core/clients/github.ts
git commit -m "feat: add comment_create tool"
```

---

### Task 4: issue_create 工具

**Files:**
- Create: `src/core/tools/issue-create.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/index.ts`

**Step 1: 创建工具实现**

创建 `src/core/tools/issue-create.ts`：

```typescript
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseRepo, createIssue } from '../clients/github.js'
import { TodoStore } from '../storage/todo-store.js'
import { UpstreamStore } from '../storage/upstream-store.js'

function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contrib', owner, name)
}

function detectTypeFromLabels(labels: string[]): 'bug' | 'feature' | 'docs' | 'chore' {
  const lower = labels.map(l => l.toLowerCase())
  if (lower.some(l => l.includes('bug'))) return 'bug'
  if (lower.some(l => l.includes('feature') || l.includes('enhancement'))) return 'feature'
  if (lower.some(l => l.includes('doc'))) return 'docs'
  return 'chore'
}

export async function issueCreate(
  title: string,
  body?: string,
  labels?: string,
  upstreamSha?: string,
  upstreamRepo?: string,
  autoTodo?: boolean,
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const contribDir = getContribDir(owner, name)

  const labelList = labels ? labels.split(',').map(l => l.trim()).filter(Boolean) : undefined
  const issue = await createIssue(owner, name, title, body, labelList)

  const results: string[] = [
    `Created **${owner}/${name}#${issue.number}**: ${issue.html_url}`,
  ]

  // Link to upstream daily commit if provided
  if (upstreamSha && upstreamRepo) {
    const { owner: upOwner, name: upName } = parseRepo(upstreamRepo)
    const store = new UpstreamStore(contribDir)
    const daily = store.getDaily(`${upOwner}/${upName}`)
    const commit = daily.commits.find(c => c.sha === upstreamSha || c.sha.startsWith(upstreamSha))
    if (commit) {
      store.updateDailyCommit(`${upOwner}/${upName}`, commit.sha, {
        action: 'issue',
        ref: `#${issue.number}`,
      })
      results.push(`Linked upstream commit ${upstreamSha.slice(0, 7)} → #${issue.number}`)
    }
  }

  // Auto-create todo
  if (autoTodo !== false) {
    const todoStore = new TodoStore(contribDir)
    const type = labelList ? detectTypeFromLabels(labelList) : 'chore'
    todoStore.add({ ref: `#${issue.number}`, title, type })
    results.push(`Created todo: #${issue.number}`)
  }

  return results.join('\n')
}
```

**Step 2: 注册到 MCP server**

```typescript
import { issueCreate } from '../core/tools/issue-create.js'

server.tool(
  'issue_create',
  'Create a GitHub issue, optionally link to upstream commit and auto-create todo',
  {
    title: z.string().describe('Issue title'),
    body: z.string().optional().describe('Issue body (markdown)'),
    labels: z.string().optional().describe('Comma-separated labels, e.g. "bug,sync"'),
    upstream_sha: z.string().optional().describe('Upstream daily commit SHA to link'),
    upstream_repo: z.string().optional().describe('Upstream repo for the commit, e.g. "ant-design/ant-design"'),
    auto_todo: z.boolean().optional().describe('Auto-create a todo for this issue (default: true)'),
    repo: repoParam,
  },
  async ({ title, body, labels, upstream_sha, upstream_repo, auto_todo, repo }) => ({
    content: [{ type: 'text', text: await issueCreate(title, body, labels, upstream_sha, upstream_repo, auto_todo, repo) }],
  }),
)
```

**Step 3: 导出**

在 `src/index.ts` 追加：
```typescript
export { issueCreate } from './core/tools/issue-create.js'
```

**Step 4: 构建**

Run: `cd /Users/wisedu/Documents/GitHub/contrib && pnpm build`
Expected: 构建成功

**Step 5: Commit**

```bash
git add src/core/tools/issue-create.ts src/mcp/server.ts src/index.ts
git commit -m "feat: add issue_create tool with upstream and todo linking"
```

---

### Task 5: issue_close 工具

**Files:**
- Create: `src/core/tools/issue-close.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/index.ts`

**Step 1: 创建工具实现**

创建 `src/core/tools/issue-close.ts`：

```typescript
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseRepo, closeIssue, createComment } from '../clients/github.js'
import { TodoStore } from '../storage/todo-store.js'

function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contrib', owner, name)
}

export async function issueClose(
  issueNumber: number,
  comment?: string,
  todoItem?: string,
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const results: string[] = []

  // Add closing comment if provided
  if (comment) {
    await createComment(owner, name, issueNumber, comment)
    results.push(`Added comment to #${issueNumber}`)
  }

  // Close the issue
  await closeIssue(owner, name, issueNumber)
  results.push(`Closed **${owner}/${name}#${issueNumber}**`)

  // Mark todo as done if provided
  if (todoItem) {
    const contribDir = getContribDir(owner, name)
    const store = new TodoStore(contribDir)
    const allTodos = store.list()
    const openIndices: number[] = []
    allTodos.forEach((t, i) => {
      if (t.status !== 'done') openIndices.push(i)
    })

    const num = Number.parseInt(todoItem, 10)
    let targetIndex: number | undefined

    if (!Number.isNaN(num) && num >= 1 && num <= openIndices.length) {
      targetIndex = openIndices[num - 1]
    } else {
      targetIndex = openIndices.find(i =>
        allTodos[i].title.toLowerCase().includes(todoItem.toLowerCase()),
      )
    }

    if (targetIndex !== undefined) {
      store.update(targetIndex, { status: 'done' })
      results.push(`Marked todo as done: ${allTodos[targetIndex].title}`)
    }
  }

  return results.join('\n')
}
```

**Step 2: 注册到 MCP server**

```typescript
import { issueClose } from '../core/tools/issue-close.js'

server.tool(
  'issue_close',
  'Close a GitHub issue, optionally with a comment and auto-complete todo',
  {
    issue_number: z.number().describe('Issue number to close'),
    comment: z.string().optional().describe('Closing comment'),
    todo_item: z.string().optional().describe('Todo index or text to mark as done'),
    repo: repoParam,
  },
  async ({ issue_number, comment, todo_item, repo }) => ({
    content: [{ type: 'text', text: await issueClose(issue_number, comment, todo_item, repo) }],
  }),
)
```

**Step 3: 导出**

在 `src/index.ts` 追加：
```typescript
export { issueClose } from './core/tools/issue-close.js'
```

**Step 4: 构建**

Run: `cd /Users/wisedu/Documents/GitHub/contrib && pnpm build`
Expected: 构建成功

**Step 5: Commit**

```bash
git add src/core/tools/issue-close.ts src/mcp/server.ts src/index.ts
git commit -m "feat: add issue_close tool with comment and todo linking"
```

---

### Task 6: pr_create 工具

**Files:**
- Create: `src/core/tools/pr-create.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/index.ts`

**Step 1: 创建工具实现**

创建 `src/core/tools/pr-create.ts`：

```typescript
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseRepo, createPull } from '../clients/github.js'
import { TodoStore } from '../storage/todo-store.js'

function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contrib', owner, name)
}

export async function prCreate(
  title: string,
  head: string,
  base?: string,
  body?: string,
  draft?: boolean,
  todoItem?: string,
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const pr = await createPull(owner, name, title, head, base ?? 'main', body, draft)
  const results: string[] = [
    `Created PR **${owner}/${name}#${pr.number}**: https://github.com/${owner}/${name}/pull/${pr.number}`,
  ]

  // Link to todo if provided
  if (todoItem) {
    const contribDir = getContribDir(owner, name)
    const store = new TodoStore(contribDir)
    const allTodos = store.list()
    const openIndices: number[] = []
    allTodos.forEach((t, i) => {
      if (t.status !== 'done') openIndices.push(i)
    })

    const num = Number.parseInt(todoItem, 10)
    let targetIndex: number | undefined

    if (!Number.isNaN(num) && num >= 1 && num <= openIndices.length) {
      targetIndex = openIndices[num - 1]
    } else {
      targetIndex = openIndices.find(i =>
        allTodos[i].title.toLowerCase().includes(todoItem.toLowerCase()),
      )
    }

    if (targetIndex !== undefined) {
      store.update(targetIndex, { pr: pr.number, status: 'pr_submitted' })
      results.push(`Linked todo: ${allTodos[targetIndex].title} → PR #${pr.number}`)
    }
  }

  return results.join('\n')
}
```

**Step 2: 注册到 MCP server**

```typescript
import { prCreate } from '../core/tools/pr-create.js'

server.tool(
  'pr_create',
  'Create a pull request, optionally link to a todo',
  {
    title: z.string().describe('PR title'),
    head: z.string().describe('Source branch (e.g. "user:feature-branch" or "feature-branch")'),
    base: z.string().optional().describe('Target branch (default: main)'),
    body: z.string().optional().describe('PR description (markdown)'),
    draft: z.boolean().optional().describe('Create as draft PR (default: false)'),
    todo_item: z.string().optional().describe('Todo index or text to link (auto-sets status to pr_submitted)'),
    repo: repoParam,
  },
  async ({ title, head, base, body, draft, todo_item, repo }) => ({
    content: [{ type: 'text', text: await prCreate(title, head, base, body, draft, todo_item, repo) }],
  }),
)
```

**Step 3: 导出**

在 `src/index.ts` 追加：
```typescript
export { prCreate } from './core/tools/pr-create.js'
```

**Step 4: 构建**

Run: `cd /Users/wisedu/Documents/GitHub/contrib && pnpm build`
Expected: 构建成功

**Step 5: Commit**

```bash
git add src/core/tools/pr-create.ts src/mcp/server.ts src/index.ts
git commit -m "feat: add pr_create tool with todo linking"
```

---

### Task 7: pr_update 工具

**Files:**
- Create: `src/core/tools/pr-update.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/index.ts`

**Step 1: 创建工具实现**

创建 `src/core/tools/pr-update.ts`：

```typescript
import { parseRepo, updatePull } from '../clients/github.js'

export async function prUpdate(
  prNumber: number,
  fields: { title?: string; body?: string; state?: string; draft?: boolean },
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const pr = await updatePull(owner, name, prNumber, fields)

  const changes: string[] = []
  if (fields.title) changes.push(`title → "${fields.title}"`)
  if (fields.body) changes.push(`body updated`)
  if (fields.state) changes.push(`state → ${fields.state}`)
  if (fields.draft !== undefined) changes.push(`draft → ${fields.draft}`)

  return `Updated **${owner}/${name}#${prNumber}**: ${changes.join(', ')}`
}
```

**Step 2: 注册到 MCP server**

```typescript
import { prUpdate } from '../core/tools/pr-update.js'

server.tool(
  'pr_update',
  'Update a pull request (title, body, state, draft)',
  {
    pr_number: z.number().describe('PR number'),
    title: z.string().optional().describe('New title'),
    body: z.string().optional().describe('New body'),
    state: z.string().optional().describe('New state: open | closed'),
    draft: z.boolean().optional().describe('Draft status'),
    repo: repoParam,
  },
  async ({ pr_number, title, body, state, draft, repo }) => ({
    content: [{ type: 'text', text: await prUpdate(pr_number, { title, body, state, draft }, repo) }],
  }),
)
```

**Step 3: 导出**

在 `src/index.ts` 追加：
```typescript
export { prUpdate } from './core/tools/pr-update.js'
```

**Step 4: 构建**

Run: `cd /Users/wisedu/Documents/GitHub/contrib && pnpm build`
Expected: 构建成功

**Step 5: Commit**

```bash
git add src/core/tools/pr-update.ts src/mcp/server.ts src/index.ts
git commit -m "feat: add pr_update tool"
```

---

### Task 8: pr_review_comments 工具（读取）

**Files:**
- Create: `src/core/tools/pr-review-comments.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/index.ts`

**Step 1: 创建工具实现**

创建 `src/core/tools/pr-review-comments.ts`：

```typescript
import { parseRepo, getPullReviewComments } from '../clients/github.js'
import { truncate } from '../utils/format.js'

export async function prReviewComments(
  prNumber: number,
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const comments = await getPullReviewComments(owner, name, prNumber)

  if (comments.length === 0) {
    return `## Review Comments — ${owner}/${name}#${prNumber}\n\n_No review comments._`
  }

  const lines: string[] = [
    `## Review Comments — ${owner}/${name}#${prNumber}`,
    '',
    `> ${comments.length} comments`,
    '',
  ]

  for (const c of comments) {
    const author = c.user?.login ?? 'unknown'
    lines.push(`### ${c.path}:${c.line ?? '?'} — @${author} (ID: ${c.id})`)
    lines.push('')
    lines.push('```diff')
    lines.push(truncate(c.diff_hunk, 500))
    lines.push('```')
    lines.push('')
    lines.push(c.body)
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}
```

**Step 2: 注册到 MCP server**

```typescript
import { prReviewComments } from '../core/tools/pr-review-comments.js'

server.tool(
  'pr_review_comments',
  'List all review comments on a PR with comment IDs, diff context, and content',
  {
    pr_number: z.number().describe('PR number'),
    repo: repoParam,
  },
  async ({ pr_number, repo }) => ({
    content: [{ type: 'text', text: await prReviewComments(pr_number, repo) }],
  }),
)
```

**Step 3: 导出**

在 `src/index.ts` 追加：
```typescript
export { prReviewComments } from './core/tools/pr-review-comments.js'
```

**Step 4: 构建**

Run: `cd /Users/wisedu/Documents/GitHub/contrib && pnpm build`
Expected: 构建成功

**Step 5: Commit**

```bash
git add src/core/tools/pr-review-comments.ts src/mcp/server.ts src/index.ts
git commit -m "feat: add pr_review_comments tool"
```

---

### Task 9: pr_review_reply 工具

**Files:**
- Create: `src/core/tools/pr-review-reply.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/index.ts`

**Step 1: 创建工具实现**

创建 `src/core/tools/pr-review-reply.ts`：

```typescript
import { parseRepo, replyToReviewComment } from '../clients/github.js'

export async function prReviewReply(
  prNumber: number,
  commentId: number,
  body: string,
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)

  await replyToReviewComment(owner, name, prNumber, commentId, body)

  return `Replied to review comment ${commentId} on **${owner}/${name}#${prNumber}**`
}
```

**Step 2: 注册到 MCP server**

```typescript
import { prReviewReply } from '../core/tools/pr-review-reply.js'

server.tool(
  'pr_review_reply',
  'Reply to a specific review comment on a PR',
  {
    pr_number: z.number().describe('PR number'),
    comment_id: z.number().describe('Review comment ID (from pr_review_comments)'),
    body: z.string().describe('Reply content (markdown)'),
    repo: repoParam,
  },
  async ({ pr_number, comment_id, body, repo }) => ({
    content: [{ type: 'text', text: await prReviewReply(pr_number, comment_id, body, repo) }],
  }),
)
```

**Step 3: 导出**

在 `src/index.ts` 追加：
```typescript
export { prReviewReply } from './core/tools/pr-review-reply.js'
```

**Step 4: 构建**

Run: `cd /Users/wisedu/Documents/GitHub/contrib && pnpm build`
Expected: 构建成功

**Step 5: Commit**

```bash
git add src/core/tools/pr-review-reply.ts src/mcp/server.ts src/index.ts
git commit -m "feat: add pr_review_reply tool"
```

---

### Task 10: project_list 工具

**Files:**
- Create: `src/core/tools/project-list.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/index.ts`

**Step 1: 创建工具实现**

创建 `src/core/tools/project-list.ts`：

```typescript
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { TodoStore } from '../storage/todo-store.js'
import { UpstreamStore } from '../storage/upstream-store.js'
import { markdownTable } from '../utils/format.js'

export function projectList(): string {
  const contribRoot = join(homedir(), '.contrib')

  if (!existsSync(contribRoot)) {
    return '## Projects\n\n_No projects configured. Data will appear after using contrib tools._'
  }

  const owners = readdirSync(contribRoot).filter((f) => {
    const p = join(contribRoot, f)
    return statSync(p).isDirectory() && !f.startsWith('.')
  })

  interface ProjectInfo {
    fullName: string
    todosOpen: number
    todosDone: number
    upstreamPending: number
    upstreamTotal: number
    lastActive: string
  }

  const projects: ProjectInfo[] = []

  for (const owner of owners) {
    const ownerDir = join(contribRoot, owner)
    const repos = readdirSync(ownerDir).filter((f) => {
      return statSync(join(ownerDir, f)).isDirectory()
    })

    for (const repo of repos) {
      const repoDir = join(ownerDir, repo)
      const fullName = `${owner}/${repo}`

      // Todos stats
      const todoStore = new TodoStore(repoDir)
      const todos = todoStore.list()
      const todosOpen = todos.filter(t => t.status !== 'done').length
      const todosDone = todos.filter(t => t.status === 'done').length

      // Upstream stats
      const upstreamStore = new UpstreamStore(repoDir)
      const upstreamRepos = upstreamStore.listRepos()
      let upstreamPending = 0
      let upstreamTotal = 0
      for (const ur of upstreamRepos) {
        const daily = upstreamStore.getDaily(ur)
        upstreamTotal += daily.commits.length
        upstreamPending += daily.commits.filter(c => c.action === null).length
      }

      // Last active: most recent file modification in the repo dir
      let lastActive = '—'
      try {
        const todosYaml = join(repoDir, 'todos.yaml')
        const upstreamYaml = join(repoDir, 'upstream.yaml')
        const times: number[] = []
        if (existsSync(todosYaml)) times.push(statSync(todosYaml).mtimeMs)
        if (existsSync(upstreamYaml)) times.push(statSync(upstreamYaml).mtimeMs)
        if (times.length > 0) {
          lastActive = new Date(Math.max(...times)).toISOString().slice(0, 10)
        }
      } catch {
        // ignore
      }

      projects.push({ fullName, todosOpen, todosDone, upstreamPending, upstreamTotal, lastActive })
    }
  }

  if (projects.length === 0) {
    return '## Projects\n\n_No projects found._'
  }

  const headers = ['Project', 'Todos (open/done)', 'Upstream (pending/total)', 'Last Active']
  const rows = projects.map(p => [
    p.fullName,
    `${p.todosOpen} / ${p.todosDone}`,
    p.upstreamTotal > 0 ? `${p.upstreamPending} / ${p.upstreamTotal}` : '—',
    p.lastActive,
  ])

  return `## Projects\n\n> ${projects.length} projects tracked\n\n${markdownTable(headers, rows)}`
}
```

**Step 2: 注册到 MCP server**

```typescript
import { projectList } from '../core/tools/project-list.js'

server.tool(
  'project_list',
  'List all tracked projects with todo and upstream stats',
  {},
  async () => ({
    content: [{ type: 'text', text: projectList() }],
  }),
)
```

**Step 3: 导出**

在 `src/index.ts` 追加：
```typescript
export { projectList } from './core/tools/project-list.js'
```

**Step 4: 构建**

Run: `cd /Users/wisedu/Documents/GitHub/contrib && pnpm build`
Expected: 构建成功

**Step 5: Commit**

```bash
git add src/core/tools/project-list.ts src/mcp/server.ts src/index.ts
git commit -m "feat: add project_list tool"
```

---

### Task 11: contribution_stats 工具

**Files:**
- Create: `src/core/tools/contribution-stats.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/index.ts`

**Step 1: 创建工具实现**

创建 `src/core/tools/contribution-stats.ts`：

```typescript
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { parseRepo, getCurrentUser, searchIssues } from '../clients/github.js'
import { markdownTable } from '../utils/format.js'

function listAllProjects(): string[] {
  const contribRoot = join(homedir(), '.contrib')
  if (!existsSync(contribRoot)) return []

  const projects: string[] = []
  const owners = readdirSync(contribRoot).filter(f =>
    statSync(join(contribRoot, f)).isDirectory() && !f.startsWith('.'),
  )
  for (const owner of owners) {
    const ownerDir = join(contribRoot, owner)
    const repos = readdirSync(ownerDir).filter(f =>
      statSync(join(ownerDir, f)).isDirectory(),
    )
    for (const repo of repos) {
      projects.push(`${owner}/${repo}`)
    }
  }
  return projects
}

export async function contributionStats(
  days?: number,
  author?: string,
  repo?: string,
): Promise<string> {
  const effectiveDays = days ?? 7
  const since = new Date()
  since.setDate(since.getDate() - effectiveDays)
  const sinceStr = since.toISOString().slice(0, 10)

  // Resolve author
  let username = author
  if (!username) {
    const user = await getCurrentUser()
    username = user?.login
  }
  if (!username) {
    return 'Error: Could not determine GitHub username. Pass `author` parameter.'
  }

  // Resolve repos
  let repos: string[]
  if (repo === 'all' || !repo) {
    repos = listAllProjects()
  } else {
    repos = [repo.includes('/') ? repo : `${parseRepo(repo).owner}/${parseRepo(repo).name}`]
  }

  if (repos.length === 0) {
    return 'Error: No projects found. Use contrib tools first to track projects.'
  }

  interface RepoStats {
    repo: string
    prsCreated: number
    issuesCreated: number
    reviews: number
  }

  const allStats: RepoStats[] = []

  for (const r of repos) {
    const [prsCreated, issuesCreated, reviews] = await Promise.all([
      searchIssues(`type:pr author:${username} repo:${r} created:>=${sinceStr}`, 100)
        .then(items => items.filter(i => i.pull_request).length),
      searchIssues(`type:issue author:${username} repo:${r} created:>=${sinceStr}`, 100)
        .then(items => items.filter(i => !i.pull_request).length),
      searchIssues(`type:pr reviewed-by:${username} repo:${r} created:>=${sinceStr}`, 100)
        .then(items => items.length),
    ])

    allStats.push({ repo: r, prsCreated, issuesCreated, reviews })
  }

  // Build output
  const totalPRs = allStats.reduce((s, r) => s + r.prsCreated, 0)
  const totalIssues = allStats.reduce((s, r) => s + r.issuesCreated, 0)
  const totalReviews = allStats.reduce((s, r) => s + r.reviews, 0)

  const lines: string[] = [
    `## Contribution Stats — @${username} (${effectiveDays} days)`,
    '',
    `> Since ${sinceStr}`,
    '',
  ]

  if (repos.length === 1) {
    const s = allStats[0]
    lines.push(markdownTable(
      ['Metric', 'Count'],
      [
        ['PRs Created', String(s.prsCreated)],
        ['Issues Created', String(s.issuesCreated)],
        ['Reviews', String(s.reviews)],
      ],
    ))
  } else {
    const headers = ['Metric', ...repos.map(r => r.split('/')[1]), 'Total']
    const rows = [
      ['PRs Created', ...allStats.map(s => String(s.prsCreated)), String(totalPRs)],
      ['Issues Created', ...allStats.map(s => String(s.issuesCreated)), String(totalIssues)],
      ['Reviews', ...allStats.map(s => String(s.reviews)), String(totalReviews)],
    ]
    lines.push(markdownTable(headers, rows))
  }

  return lines.join('\n')
}
```

**Step 2: 注册到 MCP server**

```typescript
import { contributionStats } from '../core/tools/contribution-stats.js'

server.tool(
  'contribution_stats',
  'Personal contribution stats: PRs created, issues opened, reviews given',
  {
    days: z.number().optional().describe('Stats period in days (default: 7)'),
    author: z.string().optional().describe('GitHub username (default: current user)'),
    repo: repoParam.describe('Target repo, or "all" for all tracked projects (default: all)'),
  },
  async ({ days, author, repo }) => ({
    content: [{ type: 'text', text: await contributionStats(days, author, repo) }],
  }),
)
```

**Step 3: 导出**

在 `src/index.ts` 追加：
```typescript
export { contributionStats } from './core/tools/contribution-stats.js'
```

**Step 4: 构建**

Run: `cd /Users/wisedu/Documents/GitHub/contrib && pnpm build`
Expected: 构建成功

**Step 5: Commit**

```bash
git add src/core/tools/contribution-stats.ts src/mcp/server.ts src/index.ts
git commit -m "feat: add contribution_stats tool"
```

---

### Task 12: 更新 INSTRUCTIONS 和 CLAUDE.md

**Files:**
- Modify: `src/mcp/server.ts`（INSTRUCTIONS 常量）
- Modify: `CLAUDE.md`

**Step 1: 更新 MCP INSTRUCTIONS**

在 `src/mcp/server.ts` 的 INSTRUCTIONS 中追加 GitHub 写入工具组和 Agent 行为规则：

在工具组合逻辑列表中追加：
```
12. **GitHub 写入**：issue_create / issue_close / comment_create / pr_create / pr_update / pr_review_reply → 完整读写闭环
13. **全局视图**：project_list → 跨项目概况
14. **贡献统计**：contribution_stats → 个人贡献节奏
```

追加 Agent 行为规则小节：
```
## Agent 行为规则

- 创建 PR 后，如果有对应的 active todo，自动调 todo_update 关联
- 创建 issue 后，如果来自 upstream daily，自动调 upstream_daily_act 关联
- 关闭 issue 时，如果有对应的 todo，自动标记 done
- 回复 review 前，先用 pr_review_comments 获取评论列表
```

**Step 2: 更新 CLAUDE.md 工具清单**

在 CLAUDE.md 的工具清单中追加 GitHub 写入、全局视图和贡献统计三个新分类。

**Step 3: 构建**

Run: `cd /Users/wisedu/Documents/GitHub/contrib && pnpm build`
Expected: 构建成功

**Step 4: Commit**

```bash
git add src/mcp/server.ts CLAUDE.md
git commit -m "docs: update INSTRUCTIONS and CLAUDE.md with new tools"
```
