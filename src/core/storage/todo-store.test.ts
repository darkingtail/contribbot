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
})
