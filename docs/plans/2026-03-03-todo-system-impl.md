# Todo 系统重新设计 — 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 todo 系统从 checkbox 列表升级为 YAML 结构化存储 + 实现记录文件夹，支持生命周期管理和自动化操作。

**Architecture:** todos.yaml 索引 + todos/ 实现记录 + upstream.yaml 独立管理上游同步。工具层复用现有 GitHub client（`getIssue`/`getIssueComments`/`getPullReviews`），存储层用 `yaml` 包读写 YAML。

**Tech Stack:** TypeScript, yaml (npm), vitest, MCP SDK

**Design doc:** `docs/plans/2026-03-03-todo-system-redesign.md`

---

### Task 1: 添加依赖 + 测试基础设施

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

**Step 1: 安装依赖**

```bash
pnpm add yaml
pnpm add -D vitest
```

**Step 2: 创建 vitest 配置**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
```

**Step 3: 添加 test script 到 package.json**

在 `scripts` 中添加 `"test": "vitest run"`

**Step 4: 验证**

```bash
pnpm test
```

Expected: 0 tests found, exit 0

**Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts
git commit -m "chore: add yaml dependency and vitest test infrastructure"
```

---

### Task 2: Todo 数据层 — 类型定义 + YAML 读写

**Files:**
- Create: `src/core/storage/todo-store.ts`
- Create: `src/core/storage/todo-store.test.ts`

**Step 1: 写失败测试**

```ts
// src/core/storage/todo-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TodoStore } from './todo-store.js'

describe('TodoStore', () => {
  let dir: string
  let store: TodoStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-test-'))
    store = new TodoStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty list when no file exists', () => {
    expect(store.list()).toEqual([])
  })

  it('adds a todo and persists to YAML', () => {
    store.add({ ref: '#281', title: 'Fix docs', type: 'docs' })
    const todos = store.list()
    expect(todos).toHaveLength(1)
    expect(todos[0].ref).toBe('#281')
    expect(todos[0].status).toBe('idea')
    expect(todos[0].difficulty).toBeNull()

    // Verify YAML file content
    const content = readFileSync(join(dir, 'todos.yaml'), 'utf-8')
    expect(content).toContain('ref: "#281"')
  })

  it('adds a todo without ref', () => {
    store.add({ ref: null, title: 'Research WebSocket', type: 'feature' })
    const todos = store.list()
    expect(todos[0].ref).toBeNull()
  })

  it('updates todo status', () => {
    store.add({ ref: '#281', title: 'Fix docs', type: 'docs' })
    store.update(0, { status: 'backlog' })
    expect(store.list()[0].status).toBe('backlog')
  })

  it('updates todo pr', () => {
    store.add({ ref: '#281', title: 'Fix docs', type: 'docs' })
    store.update(0, { pr: 420 })
    expect(store.list()[0].pr).toBe(420)
  })

  it('sorts by ref number ascending, null refs last', () => {
    store.add({ ref: '#313', title: 'Bug fix', type: 'bug' })
    store.add({ ref: null, title: 'Idea', type: 'feature' })
    store.add({ ref: '#159', title: 'Tests', type: 'feature' })
    const sorted = store.listSorted()
    expect(sorted.map(t => t.ref)).toEqual(['#159', '#313', null])
  })

  it('finds todo by index', () => {
    store.add({ ref: '#281', title: 'Fix docs', type: 'docs' })
    store.add({ ref: '#313', title: 'Bug fix', type: 'bug' })
    expect(store.get(1)?.ref).toBe('#313')
  })

  it('finds todo by text match', () => {
    store.add({ ref: '#281', title: 'Fix docs', type: 'docs' })
    expect(store.findByText('docs')?.ref).toBe('#281')
  })
})
```

**Step 2: 运行测试确认失败**

```bash
pnpm test
```

Expected: FAIL — `TodoStore` not found

**Step 3: 实现 TodoStore**

```ts
// src/core/storage/todo-store.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'

export type TodoType = 'bug' | 'feature' | 'docs' | 'chore'
export type TodoStatus = 'idea' | 'backlog' | 'active' | 'pr_submitted' | 'done'
export type TodoDifficulty = 'easy' | 'medium' | 'hard'

export interface TodoItem {
  ref: string | null
  title: string
  type: TodoType
  status: TodoStatus
  difficulty: TodoDifficulty | null
  pr: number | null
  created: string
  updated: string
}

interface TodosFile {
  todos: TodoItem[]
}

export class TodoStore {
  private yamlPath: string

  constructor(private baseDir: string) {
    this.yamlPath = join(baseDir, 'todos.yaml')
  }

  list(): TodoItem[] {
    if (!existsSync(this.yamlPath)) return []
    const content = readFileSync(this.yamlPath, 'utf-8')
    const data = parse(content) as TodosFile | null
    return data?.todos ?? []
  }

  listSorted(): TodoItem[] {
    const todos = this.list()
    return todos.sort((a, b) => {
      const aNum = a.ref ? Number.parseInt(a.ref.replace('#', ''), 10) : Infinity
      const bNum = b.ref ? Number.parseInt(b.ref.replace('#', ''), 10) : Infinity
      return aNum - bNum
    })
  }

  get(index: number): TodoItem | undefined {
    return this.list()[index]
  }

  findByText(text: string): TodoItem | undefined {
    return this.list().find(t => t.title.toLowerCase().includes(text.toLowerCase()))
  }

  add(input: { ref: string | null, title: string, type: TodoType }): TodoItem {
    const today = new Date().toISOString().slice(0, 10)
    const item: TodoItem = {
      ref: input.ref,
      title: input.title,
      type: input.type,
      status: 'idea',
      difficulty: null,
      pr: null,
      created: today,
      updated: today,
    }
    const todos = this.list()
    todos.push(item)
    this.save(todos)
    return item
  }

  update(index: number, fields: Partial<Pick<TodoItem, 'status' | 'difficulty' | 'pr' | 'title' | 'type'>>): TodoItem | undefined {
    const todos = this.list()
    if (index < 0 || index >= todos.length) return undefined
    const today = new Date().toISOString().slice(0, 10)
    Object.assign(todos[index], fields, { updated: today })
    this.save(todos)
    return todos[index]
  }

  private save(todos: TodoItem[]): void {
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    const data: TodosFile = { todos }
    writeFileSync(this.yamlPath, stringify(data), 'utf-8')
  }
}
```

**Step 4: 运行测试确认通过**

```bash
pnpm test
```

Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/core/storage/
git commit -m "feat: add TodoStore with YAML persistence and tests"
```

---

### Task 3: Upstream 数据层 — 类型定义 + YAML 读写

**Files:**
- Create: `src/core/storage/upstream-store.ts`
- Create: `src/core/storage/upstream-store.test.ts`

**Step 1: 写失败测试**

```ts
// src/core/storage/upstream-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { UpstreamStore } from './upstream-store.js'

describe('UpstreamStore', () => {
  let dir: string
  let store: UpstreamStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'upstream-test-'))
    store = new UpstreamStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty when no file exists', () => {
    expect(store.listRepos()).toEqual([])
  })

  it('adds a version with items', () => {
    store.addVersion('ant-design/ant-design', '6.3.1', [
      { title: 'Segmented block', type: 'feature' },
      { title: 'Fix Modal style', type: 'bug' },
    ])
    const repos = store.listRepos()
    expect(repos).toEqual(['ant-design/ant-design'])

    const versions = store.listVersions('ant-design/ant-design')
    expect(versions).toHaveLength(1)
    expect(versions[0].version).toBe('6.3.1')
    expect(versions[0].items).toHaveLength(2)
    expect(versions[0].items[0].status).toBe('active')
  })

  it('updates an item status and pr', () => {
    store.addVersion('ant-design/ant-design', '6.3.1', [
      { title: 'Segmented block', type: 'feature' },
    ])
    store.updateItem('ant-design/ant-design', '6.3.1', 0, { status: 'done', pr: 430 })
    const versions = store.listVersions('ant-design/ant-design')
    expect(versions[0].items[0].status).toBe('done')
    expect(versions[0].items[0].pr).toBe(430)
  })

  it('auto-marks version done when all items done', () => {
    store.addVersion('ant-design/ant-design', '6.3.1', [
      { title: 'Item 1', type: 'feature' },
    ])
    store.updateItem('ant-design/ant-design', '6.3.1', 0, { status: 'done', pr: 430 })
    const versions = store.listVersions('ant-design/ant-design')
    expect(versions[0].status).toBe('done')
  })
})
```

**Step 2: 运行测试确认失败**

```bash
pnpm test
```

Expected: FAIL — `UpstreamStore` not found

**Step 3: 实现 UpstreamStore**

```ts
// src/core/storage/upstream-store.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'

export type UpstreamItemStatus = 'active' | 'pr_submitted' | 'done'

export interface UpstreamItem {
  title: string
  type: 'feature' | 'bug' | 'chore'
  difficulty: 'easy' | 'medium' | 'hard' | null
  status: UpstreamItemStatus
  pr: number | null
}

export interface UpstreamVersion {
  version: string
  status: 'active' | 'done'
  items: UpstreamItem[]
}

// YAML shape: { "ant-design/ant-design": UpstreamVersion[] }
type UpstreamFile = Record<string, UpstreamVersion[]>

export class UpstreamStore {
  private yamlPath: string

  constructor(private baseDir: string) {
    this.yamlPath = join(baseDir, 'upstream.yaml')
  }

  private load(): UpstreamFile {
    if (!existsSync(this.yamlPath)) return {}
    const content = readFileSync(this.yamlPath, 'utf-8')
    return (parse(content) as UpstreamFile) ?? {}
  }

  private save(data: UpstreamFile): void {
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    writeFileSync(this.yamlPath, stringify(data), 'utf-8')
  }

  listRepos(): string[] {
    return Object.keys(this.load())
  }

  listVersions(repo: string): UpstreamVersion[] {
    return this.load()[repo] ?? []
  }

  addVersion(repo: string, version: string, items: Array<{ title: string, type: 'feature' | 'bug' | 'chore' }>): void {
    const data = this.load()
    if (!data[repo]) data[repo] = []
    data[repo].push({
      version,
      status: 'active',
      items: items.map(i => ({
        title: i.title,
        type: i.type,
        difficulty: null,
        status: 'active',
        pr: null,
      })),
    })
    this.save(data)
  }

  updateItem(repo: string, version: string, itemIndex: number, fields: Partial<Pick<UpstreamItem, 'status' | 'difficulty' | 'pr'>>): void {
    const data = this.load()
    const ver = data[repo]?.find(v => v.version === version)
    if (!ver || !ver.items[itemIndex]) return
    Object.assign(ver.items[itemIndex], fields)
    // Auto-mark version done if all items done
    if (ver.items.every(i => i.status === 'done')) {
      ver.status = 'done'
    }
    this.save(data)
  }
}
```

**Step 4: 运行测试确认通过**

```bash
pnpm test
```

Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/core/storage/upstream-store.*
git commit -m "feat: add UpstreamStore with YAML persistence and tests"
```

---

### Task 4: 实现记录文件管理

**Files:**
- Create: `src/core/storage/record-files.ts`
- Create: `src/core/storage/record-files.test.ts`

**Step 1: 写失败测试**

```ts
// src/core/storage/record-files.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecordFiles } from './record-files.js'

describe('RecordFiles', () => {
  let dir: string
  let records: RecordFiles

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'record-test-'))
    records = new RecordFiles(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates issue record file', () => {
    records.createIssueRecord(281, {
      title: 'Fix docs',
      link: 'https://github.com/org/repo/issues/281',
      labels: 'documentation',
      author: 'zhangsan',
      createdAt: '2026-02-15',
      commentsSummary: '- @user1: use env vars\n- consensus: HF_ENDPOINT first',
      body: 'Current README lacks mirror config.',
    })
    const path = join(dir, 'todos', '281.md')
    expect(existsSync(path)).toBe(true)
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('# #281 Fix docs')
    expect(content).toContain('https://github.com/org/repo/issues/281')
    expect(content).toContain('@user1: use env vars')
  })

  it('creates upstream record file with hierarchy', () => {
    records.createUpstreamRecord('ant-design/ant-design', '6.3.1', {
      link: 'https://github.com/ant-design/ant-design/releases/tag/6.3.1',
      publishedAt: '2026-02-28',
      items: ['feat: Segmented block', 'fix: disabled style'],
    })
    const path = join(dir, 'upstream', 'ant-design', 'ant-design', '6.3.1.md')
    expect(existsSync(path)).toBe(true)
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('ant-design/ant-design@6.3.1')
    expect(content).toContain('feat: Segmented block')
  })

  it('creates idea record file with auto-increment ID', () => {
    const path1 = records.createIdeaRecord('Research WebSocket')
    const path2 = records.createIdeaRecord('Try GraphQL subscriptions')
    expect(path1).toContain('idea-1.md')
    expect(path2).toContain('idea-2.md')
  })

  it('reads record file', () => {
    records.createIssueRecord(281, {
      title: 'Fix docs',
      link: 'https://github.com/org/repo/issues/281',
      labels: 'documentation',
      author: 'zhangsan',
      createdAt: '2026-02-15',
      commentsSummary: '',
      body: '',
    })
    const content = records.readRecord('#281')
    expect(content).toContain('# #281 Fix docs')
  })

  it('appends PR feedback to record file', () => {
    records.createIssueRecord(281, {
      title: 'Fix docs',
      link: 'https://github.com/org/repo/issues/281',
      labels: '',
      author: '',
      createdAt: '',
      commentsSummary: '',
      body: '',
    })
    records.appendPRFeedback('#281', 420, '2026-03-02', [
      { user: 'reviewer1', body: 'Add network tip' },
      { user: 'reviewer2', body: 'LGTM' },
    ])
    const content = records.readRecord('#281')
    expect(content).toContain('PR #420')
    expect(content).toContain('Add network tip')
  })
})
```

**Step 2: 运行测试确认失败**

```bash
pnpm test
```

Expected: FAIL — `RecordFiles` not found

**Step 3: 实现 RecordFiles**

```ts
// src/core/storage/record-files.ts
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class RecordFiles {
  constructor(private baseDir: string) {}

  createIssueRecord(issueNumber: number, info: {
    title: string
    link: string
    labels: string
    author: string
    createdAt: string
    commentsSummary: string
    body: string
  }): string {
    const path = join(this.baseDir, 'todos', `${issueNumber}.md`)
    this.ensureDir(path)
    const content = [
      `# #${issueNumber} ${info.title}`,
      '',
      '## Issue 信息',
      `- 链接: ${info.link}`,
      `- 标签: ${info.labels || 'none'}`,
      `- 作者: ${info.author}`,
      `- 创建时间: ${info.createdAt}`,
      '',
      '## 评论总结',
      info.commentsSummary || '<!-- 暂无评论 -->',
      '',
      '## 分析',
      info.body ? info.body : '<!-- 待分析 -->',
      '',
      '## 实现计划',
      '<!-- 待填充 -->',
      '',
      '## PR 反馈',
      '<!-- 自动追加 -->',
      '',
    ].join('\n')
    writeFileSync(path, content, 'utf-8')
    return path
  }

  createUpstreamRecord(repo: string, version: string, info: {
    link: string
    publishedAt: string
    items: string[]
  }): string {
    const [owner, name] = repo.split('/')
    const path = join(this.baseDir, 'upstream', owner, name, `${version}.md`)
    this.ensureDir(path)
    const content = [
      `# ${repo}@${version}`,
      '',
      '## Release 信息',
      `- 链接: ${info.link}`,
      `- 发布时间: ${info.publishedAt}`,
      '',
      '## 同步项',
      ...info.items.map(i => `- ${i}`),
      '',
      '## 实现计划',
      '<!-- 待填充 -->',
      '',
      '## PR 反馈',
      '<!-- 自动追加 -->',
      '',
    ].join('\n')
    writeFileSync(path, content, 'utf-8')
    return path
  }

  createIdeaRecord(title: string): string {
    const todosDir = join(this.baseDir, 'todos')
    if (!existsSync(todosDir)) mkdirSync(todosDir, { recursive: true })
    const existing = readdirSync(todosDir).filter(f => f.startsWith('idea-'))
    const nextId = existing.length + 1
    const path = join(todosDir, `idea-${nextId}.md`)
    const content = [
      `# ${title}`,
      '',
      '## 分析',
      '<!-- 待分析 -->',
      '',
      '## 实现计划',
      '<!-- 待填充 -->',
      '',
      '## PR 反馈',
      '<!-- 自动追加 -->',
      '',
    ].join('\n')
    writeFileSync(path, content, 'utf-8')
    return path
  }

  readRecord(ref: string): string | null {
    const path = this.refToPath(ref)
    if (!path || !existsSync(path)) return null
    return readFileSync(path, 'utf-8')
  }

  appendPRFeedback(ref: string, prNumber: number, date: string, reviews: Array<{ user: string, body: string }>): void {
    const path = this.refToPath(ref)
    if (!path || !existsSync(path)) return
    const feedback = [
      '',
      `### PR #${prNumber} — ${date}`,
      ...reviews.map(r => `- @${r.user}: ${r.body}`),
    ].join('\n')
    // Replace <!-- 自动追加 --> marker or append at end
    const content = readFileSync(path, 'utf-8')
    const marker = '<!-- 自动追加 -->'
    if (content.includes(marker)) {
      writeFileSync(path, content.replace(marker, feedback.trim()), 'utf-8')
    } else {
      appendFileSync(path, `\n${feedback}\n`, 'utf-8')
    }
  }

  private refToPath(ref: string): string | null {
    if (ref.startsWith('#')) {
      const num = ref.slice(1)
      return join(this.baseDir, 'todos', `${num}.md`)
    }
    if (ref.includes('@')) {
      const [repo, version] = ref.split('@')
      const [owner, name] = repo.split('/')
      return join(this.baseDir, 'upstream', owner, name, `${version}.md`)
    }
    return null
  }

  private ensureDir(filePath: string): void {
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}
```

**Step 4: 运行测试确认通过**

```bash
pnpm test
```

Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/core/storage/record-files.*
git commit -m "feat: add RecordFiles for implementation record management"
```

---

### Task 5: 重写 todo 工具 — todo_list + todo_add + todo_done

**Files:**
- Modify: `src/core/tools/todos.ts`（完全重写）

**Step 1: 重写 todos.ts**

用 `TodoStore` 替换原有的 checkbox 解析逻辑。保持函数签名兼容（返回 markdown string），但内部改为 YAML 读写。

关键变更：
- `todoList()` → 读 `todos.yaml`，分组渲染表格（Active / Backlog & Ideas / Done），按 ref 序号升序
- `todoAdd()` → 解析 ref（`#281` 或 null），如果有 issue ref 则调 `getIssue` 拉 labels 自动填充 type，写入 YAML
- `todoDone()` → 通过 `TodoStore.update()` 设置 `status: 'done'`

**Step 2: 运行 `pnpm build` 确认编译通过**

```bash
pnpm build
```

Expected: BUILD SUCCESS

**Step 3: Commit**

```bash
git add src/core/tools/todos.ts
git commit -m "feat: rewrite todo_list/todo_add/todo_done with YAML storage"
```

---

### Task 6: 新增 todo 工具 — todo_activate

**Files:**
- Create: `src/core/tools/todo-activate.ts`

**功能：**
- 将 todo 状态从 idea/backlog 提升为 active
- 调用 `getIssue()` + `getIssueComments()` 拉取 issue 完整信息
- 评估难度（基于 labels + 评论数 + body 长度启发式判断）
- 调用 `RecordFiles.createIssueRecord()` 创建实现记录文件
- 纯想法（ref: null）调用 `RecordFiles.createIdeaRecord()`

**Step 1: 实现 todo_activate.ts**

函数签名：`async function todoActivate(item: string, repo?: string): Promise<string>`

难度评估启发式：
- `good first issue` / `easy` 标签 → easy
- `help wanted` / 无特殊标签 + 评论 < 5 → medium
- `complex` 标签 / 评论 > 10 / body > 2000 字 → hard

**Step 2: 运行 `pnpm build` 确认编译通过**

```bash
pnpm build
```

**Step 3: Commit**

```bash
git add src/core/tools/todo-activate.ts
git commit -m "feat: add todo_activate with auto issue fetch and difficulty assessment"
```

---

### Task 7: 新增 todo 工具 — todo_detail

**Files:**
- Create: `src/core/tools/todo-detail.ts`

**功能：**
- 读取 `todos/{issue}.md` 实现记录
- 如果 todo 关联了 PR，自动调用 `getPullReviews()` 拉取最新 reviews
- 5 分钟缓存（用文件 mtime 判断，避免频繁 API 调用）
- 调用 `RecordFiles.appendPRFeedback()` 追加新的反馈

**Step 1: 实现 todo_detail.ts**

函数签名：`async function todoDetail(item: string, repo?: string): Promise<string>`

缓存逻辑：检查 record 文件 mtime，如果距上次写入 < 5 分钟且已包含该 PR 的反馈段，跳过拉取。

**Step 2: 运行 `pnpm build` 确认编译通过**

```bash
pnpm build
```

**Step 3: Commit**

```bash
git add src/core/tools/todo-detail.ts
git commit -m "feat: add todo_detail with auto PR review refresh"
```

---

### Task 8: 新增 todo 工具 — todo_update

**Files:**
- Create: `src/core/tools/todo-update.ts`

**功能：**
- 通用更新：状态、PR、备注
- 如果设置 `pr`，自动把 status 变为 `pr_submitted`
- 如果设置 `status: done`，等同于 `todo_done`

**Step 1: 实现 todo_update.ts**

函数签名：`async function todoUpdate(item: string, fields: { status?: string, pr?: number, note?: string }, repo?: string): Promise<string>`

**Step 2: 运行 `pnpm build` 确认编译通过**

```bash
pnpm build
```

**Step 3: Commit**

```bash
git add src/core/tools/todo-update.ts
git commit -m "feat: add todo_update for status/PR/note changes"
```

---

### Task 9: Upstream 工具 — upstream_list + upstream_detail + upstream_update

**Files:**
- Create: `src/core/tools/upstream-manage.ts`

**功能：**

`upstreamList(repo?)`:
- 读 `upstream.yaml`，渲染版本级别摘要表格
- 列：Version | Status | Items | Progress

`upstreamDetail(upstreamRepo, version, repo?)`:
- 读 `upstream/{owner}/{repo}/{version}.md`
- 自动刷新关联 PR reviews（同 todo_detail 逻辑）

`upstreamUpdate(upstreamRepo, version, itemIndex, fields, repo?)`:
- 更新同步项状态/PR
- 通过 `UpstreamStore.updateItem()` 持久化

**Step 1: 实现 upstream-manage.ts**

**Step 2: 运行 `pnpm build` 确认编译通过**

```bash
pnpm build
```

**Step 3: Commit**

```bash
git add src/core/tools/upstream-manage.ts
git commit -m "feat: add upstream_list/upstream_detail/upstream_update tools"
```

---

### Task 10: Upstream 每日模式 — upstream_daily + upstream_daily_act

**Files:**
- Create: `src/core/tools/upstream-daily.ts`

**功能：**

`upstreamDaily(upstreamRepo, days?, repo?)`:
- 调用 `getRepoCommits()` 拉取上游 master 近 N 天的 commits
- 按 conventional commits 解析 type（feat/fix/refactor/docs/chore）
- 用 sha 去重：已在 `upstream.yaml` daily.commits 中记录的跳过
- 对新 commits 调用 `searchIssues()` 搜索目标仓库是否已有对应 issue/PR，自动填充 action + ref
- 追加到 `upstream.yaml` 的 `daily.commits`，更新 `last_checked`
- 渲染表格输出

`upstreamDailyAct(upstreamRepo, sha, action, ref?, repo?)`:
- 对某条 commit 标记动作：skip / todo / issue / pr
- 如果 action 是 `todo`，自动调用 `todo_add` 创建一条 todo
- 持久化到 `upstream.yaml`

去重与自动检测逻辑：
1. sha 精确匹配：已记录的 commit 不重复添加
2. commit message 关键词搜索：`searchIssues("${keyword} repo:${targetOwner}/${targetRepo}")` 匹配已有 issue/PR
3. 匹配到 → action: "issue" 或 "pr"，ref: 对应编号

**Step 1: 实现 upstream-daily.ts**

**Step 2: 运行 `pnpm build` 确认编译通过**

```bash
pnpm build
```

**Step 3: Commit**

```bash
git add src/core/tools/upstream-daily.ts
git commit -m "feat: add upstream_daily and upstream_daily_act for commit-level tracking"
```

---

### Task 11: 更新 MCP 注册

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/index.ts`

**Step 1: 更新 server.ts**

- 保留原有 `todo_list` / `todo_add` / `todo_done` 工具名（兼容），但指向新实现
- 新增注册：`todo_activate` / `todo_detail` / `todo_update`
- 新增注册：`upstream_list` / `upstream_detail` / `upstream_update`
- 新增注册：`upstream_daily` / `upstream_daily_act`
- 更新 `todo_list` 和 `todo_add` 的 description 和 schema（新增 `status` / `ref` 参数）
- 更新 MCP instructions 文本，加入新工具说明

**Step 2: 更新 src/index.ts 导出**

添加新工具的导出。

**Step 3: 运行 `pnpm build` 确认编译通过**

```bash
pnpm build
```

**Step 4: Commit**

```bash
git add src/mcp/server.ts src/index.ts
git commit -m "feat: register todo_activate/todo_detail/todo_update and upstream tools in MCP"
```

---

### Task 12: 数据迁移

**Files:**
- Create: `src/core/tools/migrate-todos.ts`

**功能：**
- 解析现有 `todos.md` 的 `- [ ] #281 [Docs] ...` 格式
- 提取 issue 编号、类型标签（`[Bug]`/`[Feature]`/`[Docs]`）、标题
- `[x]` → status: done，`[ ]` → status: idea
- 写入 `todos.yaml`
- 重命名旧文件为 `todos.md.bak`

**Step 1: 实现 migrate-todos.ts**

函数签名：`function migrateTodos(repo?: string): string`

**Step 2: 手动运行迁移验证**

通过 MCP 工具或临时脚本对 `antdv-next/antdv-next` 和 `agentscope-ai/CoPaw` 执行迁移，检查生成的 `todos.yaml` 内容。

**Step 3: Commit**

```bash
git add src/core/tools/migrate-todos.ts
git commit -m "feat: add migration tool for existing todos.md to YAML"
```

---

### Task 13: 更新文档

**Files:**
- Modify: `CLAUDE.md`

**Step 1: 更新工具清单**

在 CLAUDE.md 的工具清单表格中：
- 更新 `todo_list` / `todo_add` / `todo_done` 说明
- 新增 `todo_activate` / `todo_detail` / `todo_update`
- 新增 `upstream_list` / `upstream_detail` / `upstream_update`
- 更新数据存储章节，说明新的 `todos.yaml` / `upstream.yaml` / `todos/` / `upstream/` 结构

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update tool list and storage docs for new todo system"
```
