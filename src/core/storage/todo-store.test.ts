import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
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

  it('returns undefined when no match', () => {
    store.add({ ref: '#1', title: 'First', type: 'bug' })
    expect(store.resolveItem('nonexistent')).toBeUndefined()
  })

  // --- archiveAndDelete ---

  it('archives and deletes a todo', () => {
    store.add({ ref: '#1', title: 'To archive', type: 'bug' })
    store.add({ ref: '#2', title: 'To keep', type: 'feature' })

    const archived = store.archiveAndDelete(0)
    expect(archived).toBeDefined()
    expect(archived!.title).toBe('To archive')
    expect(archived!.status).toBe('done')
    expect(archived!.archived).toBeDefined()

    // Check remaining todos
    const remaining = store.list()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.ref).toBe('#2')

    // Check archive file exists
    expect(existsSync(join(dir, 'archive.yaml'))).toBe(true)
  })

  it('returns undefined for invalid index', () => {
    expect(store.archiveAndDelete(5)).toBeUndefined()
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
})
