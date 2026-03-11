# Code Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all critical/important issues found in code review — security, data safety, type safety, error consistency, code dedup.

**Architecture:** Bottom-up fixes: utils/validation first, then storage layer, then clients, then tools, then server.ts. Each task is independent after Task 1 (validation foundation).

**Tech Stack:** TypeScript, Node.js fs, zod enums, vitest

---

### Task 1: Input validation & path safety (C1)

**Files:**
- Modify: `src/core/utils/config.ts:43-45`
- Modify: `src/core/clients/github.ts:97-102`
- Modify: `src/core/tools/skill-resources.ts:55-63`
- Modify: `src/core/tools/skills.ts:10-12`
- Test: `src/core/utils/config.test.ts` (create)

Add a `validatePathSegment` function that rejects `..`, `/`, `\`, and other unsafe characters. Apply it at the boundaries: `parseRepo`, `getContribDir`, skill path functions.

**Step 1: Write failing tests**

```typescript
// src/core/utils/config.test.ts
import { describe, it, expect } from 'vitest'
import { validatePathSegment, getContribDir } from './config.js'

describe('validatePathSegment', () => {
  it('accepts normal names', () => {
    expect(validatePathSegment('ant-design')).toBe('ant-design')
    expect(validatePathSegment('antdv-next')).toBe('antdv-next')
    expect(validatePathSegment('my.repo')).toBe('my.repo')
  })

  it('rejects path traversal', () => {
    expect(() => validatePathSegment('..')).toThrow()
    expect(() => validatePathSegment('../etc')).toThrow()
    expect(() => validatePathSegment('foo/bar')).toThrow()
    expect(() => validatePathSegment('foo\\bar')).toThrow()
  })

  it('rejects empty or whitespace', () => {
    expect(() => validatePathSegment('')).toThrow()
    expect(() => validatePathSegment('  ')).toThrow()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- src/core/utils/config.test.ts`
Expected: FAIL — `validatePathSegment` does not exist

**Step 3: Implement `validatePathSegment` in config.ts**

```typescript
// Add to src/core/utils/config.ts

const SAFE_SEGMENT = /^[\w][\w.\-]*$/

export function validatePathSegment(segment: string): string {
  const trimmed = segment.trim()
  if (!trimmed || !SAFE_SEGMENT.test(trimmed)) {
    throw new Error(`Invalid path segment: "${segment}"`)
  }
  return trimmed
}

// Update getContribDir:
export function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contribbot', validatePathSegment(owner), validatePathSegment(name))
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- src/core/utils/config.test.ts`
Expected: PASS

**Step 5: Apply validation to parseRepo**

In `src/core/clients/github.ts`, import `validatePathSegment` and apply:

```typescript
import { DEFAULT_REPO_NAME, DEFAULT_REPO_OWNER, validatePathSegment } from '../utils/config.js'

export function parseRepo(repo?: string): { owner: string, name: string } {
  if (!repo) return { owner: DEFAULT_REPO_OWNER, name: DEFAULT_REPO_NAME }
  const parts = repo.split('/')
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { owner: validatePathSegment(parts[0]), name: validatePathSegment(parts[1]) }
  }
  return { owner: DEFAULT_REPO_OWNER, name: validatePathSegment(repo) }
}
```

**Step 6: Apply validation to skill paths**

In `src/core/tools/skills.ts:10-12`:

```typescript
import { getContribDir, validatePathSegment } from '../utils/config.js'

function getSkillPath(owner: string, repo: string, skillName: string): string {
  return join(getSkillsDir(owner, repo), validatePathSegment(skillName), 'SKILL.md')
}
```

In `src/core/tools/skill-resources.ts:55-63`, `readSkill`:

```typescript
import { validatePathSegment } from '../utils/config.js'

export function readSkill(repo: string, skillName: string): string | null {
  const parts = repo.split('/')
  const owner = parts[0] ?? ''
  const name = parts[1] ?? ''
  if (!owner || !name) return null

  validatePathSegment(owner)
  validatePathSegment(name)
  validatePathSegment(skillName)

  const skillPath = join(homedir(), '.contribbot', owner, name, 'skills', skillName, 'SKILL.md')
  if (!existsSync(skillPath)) return null
  return readFileSync(skillPath, 'utf-8')
}
```

**Step 7: Run all tests**

Run: `pnpm test`
Expected: ALL PASS

**Step 8: Commit**

```
fix: add path segment validation to prevent traversal attacks
```

---

### Task 2: API timeouts (C2, C3)

**Files:**
- Modify: `src/core/clients/github.ts:26,52,77,305,324`
- Modify: `src/core/clients/npm-registry.ts:11-14`

Add timeouts to all external calls: `fetch` gets `AbortSignal.timeout(30_000)`, `execFileAsync` gets `{ timeout: 30000 }`, `spawn` gets a manual timer + kill.

**Step 1: Add timeout to `ghApiToken` fetch**

In `github.ts`, update the fetch call at line 77:

```typescript
const res = await fetch(url, { ...fetchOpts, signal: AbortSignal.timeout(30_000) })
```

**Step 2: Add timeout to GraphQL token fetch**

At line 305:

```typescript
const res = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers: { ... },
  body: JSON.stringify({ query, variables }),
  signal: AbortSignal.timeout(30_000),
})
```

**Step 3: Add timeout to `execFileAsync` calls**

At line 52:

```typescript
const { stdout } = await execFileAsync('gh', args, { timeout: 30_000 })
```

At line 324:

```typescript
const { stdout } = await execFileAsync('gh', args, { timeout: 30_000 })
```

**Step 4: Add timeout to `spawn` path**

At lines 24-49, add a timer that kills the child process:

```typescript
if (body) {
  return new Promise<T>((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('gh command timed out after 30s'))
    }, 30_000)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`gh exited with code ${code}: ${stderr}`))
        return
      }
      if (!stdout.trim()) {
        resolve(null as T)
        return
      }
      try {
        resolve(JSON.parse(stdout) as T)
      }
      catch {
        reject(new Error(`Failed to parse gh output: ${stdout}`))
      }
    })
    child.stdin.write(JSON.stringify(body))
    child.stdin.end()
  })
}
```

**Step 5: Add timeout to npm registry**

In `npm-registry.ts`:

```typescript
export async function getPackageInfo(name: string): Promise<NpmPackageInfo> {
  return ofetch<NpmPackageInfo>(`${REGISTRY_URL}/${encodeURIComponent(name)}`, {
    headers: { Accept: 'application/json' },
    timeout: 15_000,
  })
}
```

**Step 6: Add `res.ok` check to GraphQL token path**

At line 313, before parsing JSON:

```typescript
if (!res.ok) {
  const text = await res.text()
  throw new Error(`GitHub GraphQL error ${res.status}: ${text}`)
}
```

**Step 7: Run all tests**

Run: `pnpm test`
Expected: ALL PASS

**Step 8: Commit**

```
fix: add timeouts to all external API calls (fetch, gh CLI, npm)
```

---

### Task 3: Null safety in GitHub client (C6)

**Files:**
- Modify: `src/core/clients/github.ts:37,53,82`
- Modify: `src/core/clients/github.ts:186-188` (getRepoIssues caller)

Replace `null as T` with proper nullable returns and fix callers.

**Step 1: Fix `ghApiCli` null returns**

The `null as T` pattern lies about the return type. Since these are internal functions and the callers that expect arrays will break, add a helper:

```typescript
// At the top of github.ts, after imports:
function emptyOrNull<T>(stdout: string): T {
  // If the caller expects an array and got empty, return [].
  // Otherwise return null and let the caller handle it.
  return (stdout.trim() ? JSON.parse(stdout) : null) as T
}
```

Actually, the safest minimal fix is to document the behavior and guard callers. Replace lines 36-38 and 53 with explicit casts but guard callers:

In `getRepoIssues` (line 186-188):

```typescript
export async function getRepoIssues(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open', perPage = 30): Promise<GitHubIssue[]> {
  const data = await ghApi<GitHubIssue[] | null>(`/repos/${owner}/${repo}/issues`, { state, per_page: perPage })
  return (data ?? []).filter(issue => !issue.pull_request)
}
```

Apply the same `?? []` guard pattern to all array-returning helpers:

```typescript
export async function getRepoPulls(...): Promise<GitHubPull[]> {
  const data = await ghApi<GitHubPull[] | null>(...)
  return data ?? []
}
```

Do the same for: `getRepoCommits`, `getIssueComments`, `getIssueTimeline`, `getPullFiles`, `getPullReviews`, `getPullReviewComments`.

**Step 2: Run tests**

Run: `pnpm test`
Expected: ALL PASS

**Step 3: Commit**

```
fix: guard against null API responses in array-returning helpers
```

---

### Task 4: Safe file writes with write-tmp-rename (C4, I1)

**Files:**
- Modify: `src/core/storage/todo-store.ts:186-190`
- Modify: `src/core/storage/upstream-store.ts:216-218`
- Modify: `src/core/storage/repo-config.ts:32-34`
- Modify: `src/core/storage/todo-store.ts:156-184` (archiveAndDelete)
- Create: `src/core/utils/fs.ts`

Extract a `safeWriteFileSync` utility that writes to `.tmp` then renames.

**Step 1: Create `fs.ts` with `safeWriteFileSync`**

```typescript
// src/core/utils/fs.ts
import { renameSync, writeFileSync } from 'node:fs'

export function safeWriteFileSync(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, filePath)
}
```

**Step 2: Apply to TodoStore.save**

In `todo-store.ts`:

```typescript
import { safeWriteFileSync } from '../utils/fs.js'

private save(todos: TodoItem[]): void {
  if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
  const data: TodosFile = { todos }
  safeWriteFileSync(this.yamlPath, stringify(data))
}
```

**Step 3: Apply to UpstreamStore.save**

In `upstream-store.ts`:

```typescript
import { safeWriteFileSync } from '../utils/fs.js'

private save(data: UpstreamFile): void {
  if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
  safeWriteFileSync(this.yamlPath, stringify(data))
}
```

**Step 4: Apply to RepoConfig.save**

In `repo-config.ts`:

```typescript
import { safeWriteFileSync } from '../utils/fs.js'

save(config: RepoConfigData): void {
  if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
  safeWriteFileSync(this.configPath, stringify(config))
}
```

**Step 5: Fix archiveAndDelete to be safer**

In `todo-store.ts`, change the order: delete from todos first, then write archive. Worst case = lost archive entry (recoverable) instead of duplicate:

```typescript
archiveAndDelete(index: number): ArchivedTodoItem | undefined {
  const todos = this.list()
  const todo = todos[index]
  if (index < 0 || index >= todos.length || !todo) return undefined
  const today = todayDate()

  const archivedItem: ArchivedTodoItem = { ...todo, status: 'done', archived: today }

  // Delete from active first (safer: worst case = lost archive, not duplicate)
  todos.splice(index, 1)
  this.save(todos)

  // Then append to archive
  const archivePath = join(this.baseDir, 'archive.yaml')
  let archived: ArchivedTodoItem[] = []
  if (existsSync(archivePath)) {
    const content = readFileSync(archivePath, 'utf-8')
    const data = parse(content) as { todos: ArchivedTodoItem[] } | null
    archived = data?.todos ?? []
  }
  archived.push(archivedItem)

  if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
  safeWriteFileSync(archivePath, stringify({ todos: archived }))

  return archivedItem
}
```

**Step 6: Export from index.ts**

Add to `src/index.ts`:

```typescript
export { safeWriteFileSync } from './core/utils/fs.js'
```

**Step 7: Run tests**

Run: `pnpm test`
Expected: ALL PASS

**Step 8: Commit**

```
fix: use write-tmp-rename for all YAML persistence to prevent corruption
```

---

### Task 5: Error handling consistency (C7, I7)

**Files:**
- Modify: `src/core/tools/todos.ts:188-189,205-206`
- Modify: `src/core/tools/todo-activate.ts:46-48`
- Modify: `src/core/tools/todo-update.ts:20-22`
- Modify: `src/core/tools/todo-detail.ts:49-51`
- Modify: `src/core/tools/pr-create.ts:39-41`
- Modify: `src/core/tools/upstream-daily.ts:258-260,263`
- Modify: `src/core/tools/upstream-manage.ts:152-154,168,184`

Change all `return "Error: ..."` to `throw new Error(...)` so `wrapHandler` sets `isError: true`.

Also add runtime enum validation where unsafe casts exist.

**Step 1: Fix soft error returns in todos.ts**

```typescript
// todoDelete — line 188-189
if (!resolved) {
  throw new Error(`Todo not found: "${indexOrText}". Use todo_list to see available items.`)
}

// todoDone — line 205-206
if (!resolved) {
  throw new Error(`Todo not found: "${indexOrText}". Use todo_list to see available items.`)
}
```

**Step 2: Fix soft errors in todo-activate.ts, todo-update.ts, todo-detail.ts, pr-create.ts**

Same pattern — replace `return 'Error: ...'` with `throw new Error('...')`.

In `todo-activate.ts:47`:
```typescript
throw new Error(`Todo not found: "${item}". Use todo_list to see available items.`)
```

In `todo-update.ts:21`:
```typescript
throw new Error(`Todo not found: "${item}". Use todo_list to see available items.`)
```

In `todo-detail.ts:50`:
```typescript
throw new Error(`Todo not found: "${item}". Use todo_list to see available items.`)
```

In `pr-create.ts:40`:
```typescript
throw new Error('`head` branch is required. Provide it explicitly or link a todo with a branch.')
```

In `upstream-manage.ts:153`:
```typescript
throw new Error(`Version "${version}" not found for ${upstreamRepo}.`)
```

In `upstream-manage.ts:159`:
```typescript
throw new Error(`Item index ${itemIndex} out of range (1-${ver.items.length}).`)
```

In `upstream-daily.ts:259`:
```typescript
throw new Error(`Commit "${sha}" not found in daily data for ${upOwner}/${upName}.`)
```

**Step 3: Add runtime enum validation helper**

Add to `src/core/enums.ts`:

```typescript
export function validateEnum<T extends string>(values: readonly T[], value: string, label: string): T {
  if (!(values as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${label}: "${value}". Expected one of: ${values.join(', ')}`)
  }
  return value as T
}
```

**Step 4: Apply runtime validation to unsafe casts**

In `upstream-daily.ts:262-263`:

```typescript
import { DAILY_COMMIT_ACTIONS, validateEnum } from '../enums.js'

store.updateDailyCommit(`${upOwner}/${upName}`, commit.sha, {
  action: validateEnum(DAILY_COMMIT_ACTIONS, action, 'action'),
  ref: ref ?? null,
})
```

In `upstream-manage.ts:168`:

```typescript
import { UPSTREAM_ITEM_STATUSES, TODO_DIFFICULTIES, validateEnum } from '../enums.js'

if (fields.status) {
  updateFields.status = validateEnum(UPSTREAM_ITEM_STATUSES, fields.status, 'status')
  changes.push(`status -> ${fields.status}`)
}

if (fields.difficulty) {
  updateFields.difficulty = validateEnum(TODO_DIFFICULTIES, fields.difficulty, 'difficulty')
  changes.push(`difficulty -> ${fields.difficulty}`)
}
```

In `todo-update.ts:48`:

```typescript
import { TODO_STATUSES, validateEnum } from '../enums.js'

if (fields.status) {
  updateFields.status = validateEnum(TODO_STATUSES, fields.status, 'status')
  changes.push(`status -> ${fields.status}`)
}
```

**Step 5: Run tests**

Run: `pnpm test`
Expected: ALL PASS

**Step 6: Commit**

```
fix: throw errors instead of returning error strings, add runtime enum validation
```

---

### Task 6: Deduplicate shared code (I10, I2, I3, I4)

**Files:**
- Modify: `src/core/utils/format.ts` (add shared helpers)
- Modify: `src/core/tools/todos.ts:8-13,29-36` (remove duplicates)
- Modify: `src/core/tools/upstream-manage.ts:7-12` (remove duplicate)
- Modify: `src/core/tools/todo-activate.ts:150` (use shared)
- Modify: `src/core/storage/todo-store.ts:30-37` (export refSortKey)
- Modify: `src/core/tools/skill-resources.ts:11-17` (remove duplicate parseFrontmatter)
- Modify: `src/core/tools/skills.ts:19-27` (remove duplicate parseFrontmatter)
- Create: `src/core/utils/frontmatter.ts`

**Step 1: Extract `parseFrontmatter` to shared module**

```typescript
// src/core/utils/frontmatter.ts
export interface FrontmatterMeta {
  name: string
  description: string
}

export function parseFrontmatter(content: string): FrontmatterMeta {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return { name: '', description: '' }
  const fm = match[1] ?? ''
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ''
  return { name, description }
}
```

Update `skills.ts` and `skill-resources.ts` to import from `../utils/frontmatter.js`, remove their local copies.

**Step 2: Extract `difficultyLabel` to format.ts**

Add to `src/core/utils/format.ts`:

```typescript
import type { TodoDifficulty } from '../enums.js'

export function difficultyEmoji(d: TodoDifficulty | null): string {
  if (d === 'easy') return '🟢'
  if (d === 'medium') return '🟡'
  if (d === 'hard') return '🔴'
  return '—'
}

export function difficultyLabel(d: TodoDifficulty | null): string {
  if (d === 'easy') return '🟢 easy'
  if (d === 'medium') return '🟡 medium'
  if (d === 'hard') return '🔴 hard'
  return '—'
}
```

Update `todos.ts`, `upstream-manage.ts`, and `todo-activate.ts:150` to use these shared versions.

**Step 3: Export `refSortKey` from todo-store.ts**

In `todo-store.ts`, change `function refSortKey` to `export function refSortKey`.

In `todos.ts`, remove the local copy and import:

```typescript
import { TodoStore, refSortKey } from '../storage/todo-store.js'
```

**Step 4: Run tests**

Run: `pnpm test`
Expected: ALL PASS

**Step 5: Commit**

```
refactor: deduplicate parseFrontmatter, difficultyEmoji, refSortKey
```

---

### Task 7: Format utils hardening (S1, S2, S9)

**Files:**
- Modify: `src/core/utils/format.ts:1-3,5-13,15-18`

**Step 1: Fix `todayDate` to use local timezone**

```typescript
export function todayDate(): string {
  const d = new Date()
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
```

**Step 2: Fix `markdownTable` pipe escaping**

```typescript
export function markdownTable(headers: string[], rows: string[][]): string {
  const escape = (s: string) => s.replace(/\|/g, '\\|')
  const separator = headers.map(() => '---')
  const lines = [
    `| ${headers.map(escape).join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.map(row => `| ${row.map(escape).join(' | ')} |`),
  ]
  return lines.join('\n')
}
```

**Step 3: Fix `truncate` for small maxLen**

```typescript
export function truncate(str: string, maxLen: number): string {
  if (maxLen < 4) return str.slice(0, maxLen)
  if (str.length <= maxLen) return str
  return `${str.slice(0, maxLen - 3)}...`
}
```

**Step 4: Run tests**

Run: `pnpm test`
Expected: ALL PASS

**Step 5: Commit**

```
fix: todayDate uses local timezone, markdownTable escapes pipes, truncate handles small maxLen
```

---

### Task 8: Object.assign safety & listSorted (I3, I4, I13)

**Files:**
- Modify: `src/core/storage/todo-store.ts:139,53-56`
- Modify: `src/core/storage/upstream-store.ts:101,157,177`
- Modify: `src/core/storage/repo-config.ts:40`

**Step 1: Replace `Object.assign` with explicit field picking in TodoStore.update**

```typescript
update(
  index: number,
  fields: Partial<Pick<TodoItem, 'status' | 'difficulty' | 'pr' | 'branch' | 'title' | 'type'>>,
): TodoItem | undefined {
  const todos = this.list()
  const todo = todos[index]
  if (index < 0 || index >= todos.length || !todo) return undefined
  const today = todayDate()
  if (fields.status !== undefined) todo.status = fields.status
  if (fields.difficulty !== undefined) todo.difficulty = fields.difficulty
  if (fields.pr !== undefined) todo.pr = fields.pr
  if (fields.branch !== undefined) todo.branch = fields.branch
  if (fields.title !== undefined) todo.title = fields.title
  if (fields.type !== undefined) todo.type = fields.type
  todo.updated = today
  this.save(todos)
  return todo
}
```

**Step 2: Same for UpstreamStore.updateVersionItem**

```typescript
const item = ver.items[itemIndex]
if (itemIndex < 0 || itemIndex >= ver.items.length || !item) return
if (fields.status !== undefined) item.status = fields.status
if (fields.pr !== undefined) item.pr = fields.pr
if (fields.difficulty !== undefined) item.difficulty = fields.difficulty
```

**Step 3: Same for UpstreamStore.updateDailyCommit and batch**

```typescript
// updateDailyCommit
if (fields.action !== undefined) commit.action = fields.action
if (fields.ref !== undefined) commit.ref = fields.ref

// updateDailyCommitBatch — same pattern inside the loop
```

**Step 4: Same for RepoConfig.update**

```typescript
update(fields: Partial<RepoConfigData>): RepoConfigData | null {
  const config = this.load()
  if (!config) return null
  if (fields.role !== undefined) config.role = fields.role
  if (fields.org !== undefined) config.org = fields.org
  if (fields.fork !== undefined) config.fork = fields.fork
  if (fields.upstream !== undefined) config.upstream = fields.upstream
  this.save(config)
  return config
}
```

**Step 5: Fix listSorted to not mutate**

```typescript
listSorted(): TodoItem[] {
  const todos = this.list()
  return [...todos].sort((a, b) => refSortKey(a.ref) - refSortKey(b.ref))
}
```

**Step 6: Run tests**

Run: `pnpm test`
Expected: ALL PASS

**Step 7: Commit**

```
fix: replace Object.assign with explicit field picking, non-mutating sort
```

---

### Task 9: Cleanup dead code & prUpdate undefined fields (S4, S5, I5)

**Files:**
- Modify: `src/core/tools/pr-update.ts:3-19`
- Delete: `src/core/tools/migrate-todos.ts`
- Delete: `src/core/tools/migrate-todos.test.ts`
- Modify: `src/index.ts` (remove skillList/skillRead if only used for MCP resources)

**Step 1: Fix prUpdate to only send defined fields**

```typescript
export async function prUpdate(
  prNumber: number,
  fields: { title?: string; body?: string; state?: string; draft?: boolean },
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const payload: Record<string, unknown> = {}
  if (fields.title !== undefined) payload.title = fields.title
  if (fields.body !== undefined) payload.body = fields.body
  if (fields.state !== undefined) payload.state = fields.state
  if (fields.draft !== undefined) payload.draft = fields.draft

  await updatePull(owner, name, prNumber, payload)

  const changes: string[] = []
  if (fields.title) changes.push(`title -> "${fields.title}"`)
  if (fields.body) changes.push(`body updated`)
  if (fields.state) changes.push(`state -> ${fields.state}`)
  if (fields.draft !== undefined) changes.push(`draft -> ${fields.draft}`)

  return `Updated **${owner}/${name}#${prNumber}**: ${changes.join(', ')}`
}
```

**Step 2: Delete migration files**

```bash
rm src/core/tools/migrate-todos.ts src/core/tools/migrate-todos.test.ts
```

**Step 3: Run tests**

Run: `pnpm test`
Expected: ALL PASS

**Step 4: Commit**

```
fix: prUpdate only sends defined fields, remove dead migration code
```

---

### Task 10: Build & final verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: ALL PASS

**Step 2: Build**

Run: `pnpm build`
Expected: SUCCESS, no type errors

**Step 3: Final commit (if any remaining changes)**

---

## Summary

| Task | Issues Fixed | Scope |
|------|-------------|-------|
| 1 | C1 (path traversal) | config, github, skills |
| 2 | C2, C3 (timeouts), I4 (GraphQL ok check) | github client, npm client |
| 3 | C6 (null as T) | github client |
| 4 | C4 (non-atomic write), I1 (write corruption) | all stores |
| 5 | C7 (unsafe enum cast), I7 (soft errors) | tools layer, enums |
| 6 | I2, I3, I4 duplicates (I10) | utils, tools |
| 7 | S1 (timezone), S2 (pipe escape), S9 (truncate) | format utils |
| 8 | I3 (Object.assign), I13 (in-place sort) | stores |
| 9 | I5 (prUpdate undef), S4/S5 (dead code) | pr-update, cleanup |
| 10 | — | verification |
