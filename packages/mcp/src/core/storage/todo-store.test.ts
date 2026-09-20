import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stringify } from 'yaml'
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

  function completeAndArchive(index: number) {
    store.completeTodo(index, 'done', 'Fixture completed before explicit archival.')
    return store.archiveAndDelete(index)
  }

  it('returns empty list when no file exists', () => {
    expect(store.list()).toEqual([])
  })

  it('adds a todo and persists to YAML', () => {
    const added = store.add({ ref: '#281', title: 'Fix docs', type: 'docs' })
    const todos = store.list()
    expect(todos).toHaveLength(1)
    expect(added.id).toMatch(/^t-/)
    expect(todos[0]!.id).toBe(added.id)
    expect(todos[0]!.executions).toEqual([])
    expect(todos[0]!.ref).toBe('#281')
    expect(todos[0]!.status).toBe('idea')
    expect(todos[0]!.difficulty).toBeNull()

    // Verify YAML file content
    const content = readFileSync(join(dir, 'todos.yaml'), 'utf-8')
    expect(content).toContain('ref: "#281"')
  })

  it('adds a todo without ref', () => {
    store.add({ ref: null, title: 'Research WebSocket', type: 'feature' })
    const todos = store.list()
    expect(todos[0]!.ref).toBeNull()
  })

  it('rejects archiving an open execution before completion', () => {
    store.add({ ref: 'open-work', title: 'Open work', type: 'feature' })
    store.activateExecution(0)

    expect(() => store.archiveAndDelete(0)).toThrow('open execution')
    expect(store.list()).toHaveLength(1)
    expect(store.listArchived()).toEqual([])
  })

  it('rejects duplicate active refs at the storage boundary', () => {
    const first = store.add({ ref: 'shared-ref', title: 'First owner', type: 'feature' })

    expect(() => store.add({ ref: 'SHARED-REF', title: 'Second owner', type: 'bug' }))
      .toThrow('Todo ref already exists')
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]!.id).toBe(first.id)
  })

  it('rejects refs that are unsafe as todo record filenames', () => {
    expect(() => store.add({ ref: '../escape', title: 'Escape', type: 'bug' })).toThrow('Invalid todo ref')
    expect(() => store.add({ ref: './42', title: 'Alias', type: 'bug' })).toThrow('Invalid todo ref')
    expect(() => store.add({ ref: '42', title: 'Numeric alias', type: 'bug' })).toThrow('Invalid todo ref')
    expect(store.list()).toEqual([])
  })

  it('updates todo status', () => {
    store.add({ ref: '#281', title: 'Fix docs', type: 'docs' })
    store.update(0, { status: 'backlog' })
    expect(store.list()[0]!.status).toBe('backlog')
  })

  it('updates todo pr', () => {
    store.add({ ref: '#281', title: 'Fix docs', type: 'docs' })
    store.update(0, { pr: 420 })
    expect(store.list()[0]!.pr).toBe(420)
  })

  it('sorts by ref number ascending, null refs last', () => {
    store.add({ ref: '#313', title: 'Bug fix', type: 'bug' })
    store.add({ ref: null, title: 'Idea', type: 'feature' })
    store.add({ ref: '#159', title: 'Tests', type: 'feature' })
    const sorted = store.listSorted()
    expect(sorted.map(t => t.ref)).toEqual(['#159', '#313', null])
  })

  it('sorts slug refs after issue refs but before null refs', () => {
    store.add({ ref: '#313', title: 'Bug fix', type: 'bug' })
    store.add({ ref: null, title: 'Idea', type: 'feature' })
    store.add({ ref: 'playground', title: 'Playground', type: 'chore' })
    store.add({ ref: '#159', title: 'Tests', type: 'feature' })
    const sorted = store.listSorted()
    expect(sorted.map(t => t.ref)).toEqual(['#159', '#313', 'playground', null])
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

  // --- resolveItem ---

  it('resolves item by 1-based index among open todos', () => {
    store.add({ ref: '#1', title: 'First', type: 'bug' })
    store.add({ ref: '#2', title: 'Second', type: 'feature' })
    store.update(0, { status: 'done' })

    const resolved = store.resolveItem('1')
    expect(resolved).toBeDefined()
    expect(resolved!.item.ref).toBe('#2')
    expect(resolved!.storeIndex).toBe(1)
  })

  it('resolves item by text substring', () => {
    store.add({ ref: '#1', title: 'Fix the button', type: 'bug' })
    store.add({ ref: '#2', title: 'Add modal', type: 'feature' })

    const resolved = store.resolveItem('modal')
    expect(resolved).toBeDefined()
    expect(resolved!.item.ref).toBe('#2')
  })

  it('resolves an open todo by exact custom ref', () => {
    store.add({ ref: 'phase3-catpaw-workflow', title: 'Design the Phase 3 workflow', type: 'chore' })

    expect(store.resolveItem('phase3-catpaw-workflow')?.item.ref).toBe('phase3-catpaw-workflow')
    expect(store.resolveItem(' PHASE3-CATPAW-WORKFLOW ')?.item.ref).toBe('phase3-catpaw-workflow')
  })

  it('prefers an exact ref over a title keyword match', () => {
    store.add({ ref: 'other-task', title: 'Investigate phase3-catpaw-workflow', type: 'chore' })
    store.add({ ref: 'phase3-catpaw-workflow', title: 'Design workflow', type: 'chore' })

    expect(store.resolveItem('phase3-catpaw-workflow')?.item.ref).toBe('phase3-catpaw-workflow')
  })

  it('resolves explicit issue refs and falls back from an invalid index to a numeric issue ref', () => {
    store.add({ ref: '#281', title: 'Fix docs', type: 'docs' })

    expect(store.resolveItem('#281')?.item.ref).toBe('#281')
    expect(store.resolveItem('281')?.item.ref).toBe('#281')
  })

  it('does not parse a partially numeric query as an index', () => {
    store.add({ ref: 'first-task', title: 'First', type: 'bug' })

    expect(store.resolveItem('1abc')).toBeUndefined()
  })

  it('uses display order for numeric indexes instead of YAML insertion order', () => {
    store.add({ ref: 'backlog-task', title: 'Backlog', type: 'chore' })
    store.update(0, { status: 'backlog' })
    store.add({ ref: 'active-task', title: 'Active', type: 'feature' })
    store.update(1, { status: 'active' })

    expect(store.resolveItem('1')?.item.ref).toBe('active-task')
    expect(store.resolveItem('2')?.item.ref).toBe('backlog-task')
  })

  it('returns undefined when no match', () => {
    store.add({ ref: '#1', title: 'First', type: 'bug' })
    expect(store.resolveItem('nonexistent')).toBeUndefined()
  })

  // --- archiveAndDelete ---

  it('archives and deletes a todo', () => {
    store.add({ ref: '#1', title: 'To archive', type: 'bug' })
    store.add({ ref: '#2', title: 'To keep', type: 'feature' })

    const archived = completeAndArchive(0)
    expect(archived).toBeDefined()
    expect(archived!.title).toBe('To archive')
    expect(archived!.status).toBe('done')
    expect(archived!.archived).toBeDefined()

    // Check remaining todos
    const remaining = store.list()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.ref).toBe('#2')

    // Check archive file exists
    expect(existsSync(join(dir, 'todos.archive.yaml'))).toBe(true)
  })

  it('keeps the active todo when archive write fails', () => {
    store.add({ ref: '#1', title: 'Do not lose', type: 'bug' })
    store.completeTodo(0, 'done', 'Ready to archive.')
    mkdirSync(join(dir, 'todos.archive.yaml.tmp'))

    expect(() => store.archiveAndDelete(0)).toThrow()

    const remaining = store.list()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.ref).toBe('#1')
  })

  it('retries safely when archive write succeeds but active removal fails', () => {
    store.add({ ref: '#1', title: 'Retry archive', type: 'bug' })
    store.activateExecution(0)
    store.completeTodo(0, 'done', 'Complete.')
    mkdirSync(join(dir, 'todos.yaml.tmp'))

    expect(() => store.archiveAndDelete(0)).toThrow()
    expect(store.list()).toHaveLength(1)
    expect(store.listArchived()).toHaveLength(1)

    rmSync(join(dir, 'todos.yaml.tmp'), { recursive: true, force: true })
    expect(store.archiveAndDelete(0)).toBeDefined()
    expect(store.list()).toHaveLength(0)
    expect(store.listArchived()).toHaveLength(1)
  })

  it('rejects an archive retry when the active aggregate changed after a partial failure', () => {
    store.add({ ref: '#1', title: 'Conflicting retry', type: 'bug' })
    store.activateExecution(0)
    store.completeTodo(0, 'done', 'Complete.')
    mkdirSync(join(dir, 'todos.yaml.tmp'))
    expect(() => store.archiveAndDelete(0)).toThrow()
    rmSync(join(dir, 'todos.yaml.tmp'), { recursive: true, force: true })

    const changed = store.list()[0]!
    changed.title = 'Changed after the partial archive.'
    writeFileSync(join(dir, 'todos.yaml'), stringify({ todos: [changed] }))

    expect(() => store.archiveAndDelete(0)).toThrow('different content')
    expect(store.list()).toHaveLength(1)
    expect(store.listArchived()).toHaveLength(1)
  })

  it('persists a legacy todo id before archive writes so retries keep one identity', () => {
    writeFileSync(join(dir, 'todos.yaml'), `todos:
  - ref: legacy-archive
    title: Legacy archive
    type: chore
    status: done
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2026-01-01"
    updated: "2026-01-01"
`)
    mkdirSync(join(dir, 'todos.archive.yaml.tmp'))

    expect(() => store.archiveAndDelete(0)).toThrow()
    const persistedId = store.list()[0]!.id
    expect(persistedId).toMatch(/^t-/)

    rmSync(join(dir, 'todos.archive.yaml.tmp'), { recursive: true, force: true })
    mkdirSync(join(dir, 'todos.yaml.tmp'))
    expect(() => store.archiveAndDelete(0)).toThrow()
    expect(store.listArchived()).toHaveLength(1)
    expect(store.listArchived()[0]!.id).toBe(persistedId)

    rmSync(join(dir, 'todos.yaml.tmp'), { recursive: true, force: true })
    store.archiveAndDelete(0)
    expect(store.listArchived()).toHaveLength(1)
    expect(store.listArchived()[0]!.id).toBe(persistedId)
  })

  it('does not create an archive when the initial legacy id persistence fails', () => {
    writeFileSync(join(dir, 'todos.yaml'), `todos:
  - ref: legacy-id-failure
    title: Legacy id failure
    type: chore
    status: done
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2026-01-01"
    updated: "2026-01-01"
`)
    mkdirSync(join(dir, 'todos.yaml.tmp'))

    expect(() => store.archiveAndDelete(0)).toThrow()
    expect(store.list()[0]!.id).toBeUndefined()
    expect(existsSync(join(dir, 'todos.archive.yaml'))).toBe(false)

    rmSync(join(dir, 'todos.yaml.tmp'), { recursive: true, force: true })
    const archived = store.archiveAndDelete(0)
    expect(archived?.id).toMatch(/^t-/)
    expect(store.listArchived()).toHaveLength(1)
  })

  it('returns undefined for invalid index', () => {
    expect(store.archiveAndDelete(5)).toBeUndefined()
  })

  // --- claimed_items ---

  it('initializes claimed_items as null', () => {
    store.add({ ref: '#1', title: 'Task', type: 'bug' })
    expect(store.list()[0]!.claimed_items).toBeNull()
  })

  it('updates claimed_items', () => {
    store.add({ ref: '#1', title: 'Task', type: 'bug' })
    store.update(0, { claimed_items: ['Fix CSS', 'Update tests'] })
    const todo = store.list()[0]!
    expect(todo.claimed_items).toEqual(['Fix CSS', 'Update tests'])
  })

  it('normalizes missing claimed_items to null for backward compat', () => {
    // Simulate an old YAML file without claimed_items
    const { writeFileSync } = require('node:fs')
    writeFileSync(join(dir, 'todos.yaml'), `todos:
  - ref: "#1"
    title: Old todo
    type: bug
    status: idea
    difficulty: null
    pr: null
    branch: null
    created: "2026-01-01"
    updated: "2026-01-01"
`)
    const todos = store.list()
    expect(todos[0]!.claimed_items).toBeNull()
    expect(todos[0]!.id).toBeUndefined()
    expect(todos[0]!.executions).toEqual([])
  })

  // --- executions ---

  it('creates one execution and resumes it idempotently', () => {
    store.add({ ref: 'phase3', title: 'Build Phase 3', type: 'feature' })

    const first = store.activateExecution(0)
    const second = store.activateExecution(0)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.execution.id).toBe(first.execution.id)
    expect(second.item.id).toMatch(/^t-/)
    expect(store.list()[0]!.executions).toHaveLength(1)
    expect(store.list()[0]!.executions[0]).toMatchObject({
      goal: 'Build Phase 3',
      phase: 'understand',
      blocked_on: null,
      closed_at: null,
      outcome: null,
    })
  })

  it('lazily assigns an id to a legacy todo on first activation', () => {
    writeFileSync(join(dir, 'todos.yaml'), `todos:
  - ref: legacy
    title: Legacy todo
    type: chore
    status: backlog
    difficulty: null
    pr: null
    branch: null
    created: "2026-01-01"
    updated: "2026-01-01"
`)

    expect(store.list()[0]!.id).toBeUndefined()
    const activated = store.activateExecution(0)
    expect(activated.item.id).toMatch(/^t-/)
    expect(store.list()[0]!.id).toBe(activated.item.id)
  })

  it('lazily assigns an id when a legacy todo already has an open execution', () => {
    writeFileSync(join(dir, 'todos.yaml'), `todos:
  - ref: legacy
    title: Legacy todo
    type: chore
    status: active
    difficulty: medium
    pr: null
    branch: feat/legacy
    created: "2026-01-01"
    updated: "2026-01-01"
    executions:
      - id: te-legacy
        goal: Continue legacy work
        phase: execute
        next: Resume implementation
        blocked_on: null
        evidence: []
        opened_at: "2026-01-01T08:00:00.000Z"
        closed_at: null
        outcome: null
        outcome_note: ""
`)

    const activated = store.activateExecution(0)
    expect(activated.created).toBe(false)
    expect(activated.item.id).toMatch(/^t-/)
    expect(store.list()[0]!.id).toBe(activated.item.id)
  })

  it('updates progress and appends validated evidence', () => {
    store.add({ ref: 'phase3', title: 'Build Phase 3', type: 'feature' })
    store.activateExecution(0)

    const execution = store.progressExecution(0, {
      phase: 'execute',
      next: 'Implement the storage aggregate.',
      blocked_on: null,
      evidence: [{
        source: 'revision',
        locator: 'git:HEAD',
        observed_at: '2026-09-16T08:00:00.000Z',
        digest: 'TodoExecution tests are red.',
        revision: 'abc123',
        note: 'RED baseline',
      }],
    })

    expect(execution).toMatchObject({
      phase: 'execute',
      next: 'Implement the storage aggregate.',
      blocked_on: null,
    })
    expect(execution.evidence).toHaveLength(1)
    expect(execution.evidence[0]!.revision).toBe('abc123')
  })

  it('rejects evidence that requires but omits a revision', () => {
    store.add({ ref: 'phase3', title: 'Build Phase 3', type: 'feature' })
    store.activateExecution(0)

    expect(() => store.progressExecution(0, {
      evidence: [{
        source: 'test',
        locator: 'pnpm test',
        observed_at: '2026-09-16T08:00:00.000Z',
        digest: 'Tests passed.',
      }],
    })).toThrow('revision')
  })

  it('rejects persisted todos with more than one open execution', () => {
    writeFileSync(join(dir, 'todos.yaml'), `todos:
  - id: t-invalid
    ref: invalid
    title: Invalid todo
    type: bug
    status: active
    difficulty: medium
    pr: null
    branch: fix/invalid
    claimed_items: null
    created: "2026-09-16"
    updated: "2026-09-16"
    executions:
      - id: te-one
        goal: First
        phase: execute
        next: Continue first
        blocked_on: null
        evidence: []
        opened_at: "2026-09-16T08:00:00.000Z"
        closed_at: null
        outcome: null
        outcome_note: ""
      - id: te-two
        goal: Second
        phase: execute
        next: Continue second
        blocked_on: null
        evidence: []
        opened_at: "2026-09-16T09:00:00.000Z"
        closed_at: null
        outcome: null
        outcome_note: ""
`)

    expect(() => store.list()).toThrow('more than one open execution')
  })

  it('preserves the separately completed execution when archiving', () => {
    store.add({ ref: 'phase3', title: 'Build Phase 3', type: 'feature' })
    store.activateExecution(0)

    const completed = store.completeTodo(0, 'done', 'MVP complete.')
    const archived = store.archiveAndDelete(0)

    expect(archived?.executions).toEqual(completed?.executions)
    expect(archived?.executions).toHaveLength(1)
    expect(archived?.executions[0]).toMatchObject({
      phase: 'finish',
      outcome: 'done',
      outcome_note: 'MVP complete.',
    })
    expect(archived?.executions[0]!.closed_at).toBeTruthy()
    expect(store.listArchived()[0]!.executions[0]!.id).toBe(archived?.executions[0]!.id)
  })

  it('still archives a todo that never had an execution', () => {
    store.add({ ref: 'small-doc', title: 'Small documentation fix', type: 'docs' })
    store.completeTodo(0, 'done', 'Completed directly.')
    expect(store.archiveAndDelete(0)?.executions).toEqual([])
  })

  it('protects execution history from accidental deletion', () => {
    store.add({ ref: 'phase3', title: 'Build Phase 3', type: 'feature' })
    store.activateExecution(0)

    expect(() => store.delete(0)).toThrow('execution history')
    expect(store.delete(0, { force: true })?.ref).toBe('phase3')
  })

  it.each([
    ['executions', `todos:
  - ref: malformed
    title: Malformed executions
    type: bug
    status: active
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2026-09-16"
    updated: "2026-09-16"
    executions:
      unexpected: mapping
`],
    ['evidence', `todos:
  - id: t-malformed
    ref: malformed
    title: Malformed evidence
    type: bug
    status: active
    difficulty: medium
    pr: null
    branch: null
    claimed_items: null
    created: "2026-09-16"
    updated: "2026-09-16"
    executions:
      - id: te-malformed
        goal: Preserve malformed data
        phase: execute
        next: Repair manually
        blocked_on: null
        evidence:
          unexpected: mapping
        opened_at: "2026-09-16T08:00:00.000Z"
        closed_at: null
        outcome: null
        outcome_note: ""
`],
    ['top-level todos', `todos: null
`],
  ])('rejects malformed present %s without rewriting bytes', (_field, yaml) => {
    const file = join(dir, 'todos.yaml')
    writeFileSync(file, yaml)
    const before = readFileSync(file)

    expect(() => store.list()).toThrow('must be an array')
    expect(readFileSync(file)).toEqual(before)
  })

  // --- listArchived & compact ---

  it('reads a legacy archive without migrating or rewriting it', () => {
    const legacyPath = join(dir, 'archive.yaml')
    const newPath = join(dir, 'todos.archive.yaml')
    const legacyContent = `todos:
  - ref: legacy-archive
    title: Legacy archive
    type: chore
    status: done
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2025-01-01"
    updated: "2025-01-01"
    archived: "2025-01-02"
`
    writeFileSync(legacyPath, legacyContent)

    expect(store.listArchived()[0]!.ref).toBe('legacy-archive')
    expect(store.resolveItemFromAll('legacy-archive')?.title).toBe('Legacy archive')
    expect(existsSync(newPath)).toBe(false)
    expect(readFileSync(legacyPath, 'utf-8')).toBe(legacyContent)
  })

  it('migrates a legacy archive only when an explicit archive write occurs', () => {
    writeFileSync(join(dir, 'archive.yaml'), `todos:
  - ref: legacy-archive
    title: Legacy archive
    type: chore
    status: done
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2025-01-01"
    updated: "2025-01-01"
    archived: "2025-01-02"
`)
    store.add({ ref: 'new-archive', title: 'New archive', type: 'feature' })

    completeAndArchive(0)

    expect(existsSync(join(dir, 'todos.archive.yaml'))).toBe(true)
    expect(store.listArchived().map(item => item.ref)).toEqual(['legacy-archive', 'new-archive'])
    expect(existsSync(join(dir, 'archive.yaml'))).toBe(true)
  })

  it('lists archived items', () => {
    store.add({ ref: '#1', title: 'Task 1', type: 'bug' })
    store.add({ ref: '#2', title: 'Task 2', type: 'feature' })
    completeAndArchive(0)
    completeAndArchive(0)
    expect(store.listArchived()).toHaveLength(2)
  })

  it('compacts archive by keep count', () => {
    store.add({ ref: '#1', title: 'Old', type: 'bug' })
    store.add({ ref: '#2', title: 'Mid', type: 'feature' })
    store.add({ ref: '#3', title: 'New', type: 'docs' })
    completeAndArchive(0)
    completeAndArchive(0)
    completeAndArchive(0)
    expect(store.listArchived()).toHaveLength(3)

    const result = store.compact({ keep: 1 })
    expect(result.removed).toBe(2)
    expect(result.remaining).toBe(1)
    expect(store.listArchived()[0]!.ref).toBe('#3')
  })

  it('compacts archive by date', () => {
    store.add({ ref: '#1', title: 'Old', type: 'bug' })
    completeAndArchive(0)
    // Manually set old archive date
    const { writeFileSync } = require('node:fs')
    writeFileSync(join(dir, 'todos.archive.yaml'), `todos:
  - ref: "#1"
    title: Old
    type: bug
    status: done
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2024-01-01"
    updated: "2024-01-01"
    archived: "2024-01-01"
  - ref: "#2"
    title: Recent
    type: feature
    status: done
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2026-03-01"
    updated: "2026-03-01"
    archived: "2026-03-01"
`)
    const result = store.compact({ before: '2025-01-01' })
    expect(result.removed).toBe(1)
    expect(result.remaining).toBe(1)
    expect(store.listArchived()[0]!.ref).toBe('#2')
  })

  it('compact keep=0 clears all', () => {
    store.add({ ref: '#1', title: 'Task', type: 'bug' })
    completeAndArchive(0)
    const result = store.compact({ keep: 0 })
    expect(result.removed).toBe(1)
    expect(result.remaining).toBe(0)
  })

  it('requires force to compact archived execution history by count or date', () => {
    store.add({ ref: '#1', title: 'Historical execution', type: 'bug' })
    store.activateExecution(0)
    completeAndArchive(0)

    expect(() => store.compact({ keep: 0 })).toThrow('force')
    expect(() => store.compact({ before: '9999-01-01' })).toThrow('force')
    expect(store.listArchived()).toHaveLength(1)

    expect(store.compact({ keep: 0, force: true })).toEqual({ removed: 1, remaining: 0 })
  })

  it('requires a stable id to disambiguate reused archived refs', () => {
    const first = store.add({ ref: '#1', title: 'First use', type: 'bug' })
    completeAndArchive(0)
    const second = store.add({ ref: '#1', title: 'Second use', type: 'feature' })
    completeAndArchive(0)

    expect(() => store.resolveItemFromAll('#1')).toThrow('Multiple archived todos')
    expect(store.resolveItemFromAll(first.id!)?.title).toBe('First use')
    expect(store.resolveItemFromAll(second.id!)?.title).toBe('Second use')
  })

  it('prefers an exact archived stable id over an active title substring', () => {
    const archived = store.add({ ref: 'archived-id', title: 'Archived identity', type: 'bug' })
    completeAndArchive(0)
    store.add({ ref: 'shadow', title: `Follow up ${archived.id}`, type: 'feature' })

    expect(store.resolveItemFromAll(archived.id!)?.title).toBe('Archived identity')
  })

  it('compact on empty archive returns zero', () => {
    const result = store.compact({ keep: 10 })
    expect(result.removed).toBe(0)
    expect(result.remaining).toBe(0)
  })

  it('compact throws when neither before nor keep provided', () => {
    store.add({ ref: '#1', title: 'Task', type: 'bug' })
    completeAndArchive(0)
    expect(() => store.compact({})).toThrow('Exactly one')
  })

  // --- resolveItemFromAll ---

  it('resolves from all todos including done', () => {
    store.add({ ref: '#1', title: 'Done item', type: 'bug' })
    store.update(0, { status: 'done' })
    store.add({ ref: '#2', title: 'Open item', type: 'feature' })

    const todo = store.resolveItemFromAll('Done')
    expect(todo).toBeDefined()
    expect(todo!.ref).toBe('#1')
  })

  it('resolves a done todo by exact custom ref', () => {
    store.add({ ref: 'completed-work', title: 'Completed work', type: 'chore' })
    store.update(0, { status: 'done' })

    expect(store.resolveItemFromAll('completed-work')?.ref).toBe('completed-work')
  })

  it('keeps display indexes stable across status groups', () => {
    store.add({ ref: 'done-task', title: 'Done', type: 'chore' })
    store.update(0, { status: 'done' })
    store.add({ ref: 'idea-task', title: 'Idea', type: 'feature' })
    store.add({ ref: 'active-task', title: 'Active', type: 'bug' })
    store.update(2, { status: 'active' })

    expect(store.listForDisplay().map(t => t.ref)).toEqual(['active-task', 'idea-task', 'done-task'])
    expect(store.resolveItemFromAll('1')?.ref).toBe('active-task')
    expect(store.resolveItemFromAll('2')?.ref).toBe('idea-task')
    expect(store.resolveItemFromAll('3')?.ref).toBe('done-task')
  })
})
