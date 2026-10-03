import { testProjectDirectory, testRepository } from '../../utils/test-repository.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore } from '../../storage/todo-store.js'
import { todoUpdate } from './todo-update.js'
import { todoList } from './todos.js'
import { settleControl } from '../../execution/control.js'

vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockImplementation(async () => ({
    owner: 'owner', name: 'repo', directory: testProjectDirectory(),
    repository: { platform: 'github', instance: 'https://github.com', path: 'owner/repo' },
  })),
}))

describe('Todo PR associations', () => {
  let home: string
  let dir: string
  let store: TodoStore
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'todo-pr-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    dir = testProjectDirectory()
    store = new TodoStore(dir)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it.each(['idea', 'backlog', 'active'] as const)(
    'links without changing %s, retains legacy PR and deduplicates repeat links', async (status) => {
      const todo = store.add({ ref: 'association', title: 'Association', type: 'feature' })
      store.update(0, { status, pr: 41 })
      await todoUpdate(todo.id!, { pr: 42 }, testRepository)
      await todoUpdate(todo.id!, { pr: 42 }, testRepository)
      expect(store.get(0)).toMatchObject({ status, pr: 42, pull_requests: [
        { repo: testRepository, number: 41 }, { repo: testRepository, number: 42 },
      ] })
      expect(store.listArchived()).toEqual([])
      const listing = await todoList(testRepository)
      expect(listing).toContain('/pull/41')
      expect(listing).toContain('/pull/42')
    },
  )

  it('links a PR without resuming paused work', async () => {
    const todo = store.add({ ref: 'paused', title: 'Paused', type: 'feature' })
    const execution = store.activateExecution(0).execution
    store.update(0, { pr: 41 })
    store.applyWorkflow(todo.id!, execution.id, { request_id: 'pause', expected_revision: 0,
      command: { action: 'request_control', control_id: 'pause', kind: 'pause', decision: 'user:pause', note: 'Pause work.' } })
    settleControl('settle_pause', { directory: dir, todo_id: todo.id, execution_id: execution.id,
      request_id: 'settle', expected_revision: 1, control_id: 'pause', actor: 'primary' })
    await todoUpdate(todo.id!, { pr: 42 }, testRepository)
    expect(store.get(0)).toMatchObject({ status: 'paused', pr: 42, pull_requests: [
      { repo: testRepository, number: 41 }, { repo: testRepository, number: 42 },
    ] })
    expect(store.listArchived()).toEqual([])
  })

  it.each(['done', 'cancelled'] as const)('does not reopen %s via ordinary association', async (status) => {
    const todo = store.add({ ref: 'ended', title: 'Ended', type: 'docs' })
    store.update(0, { pr: 41 })
    if (status === 'cancelled') store.cancelTodo(todo.id!, store.get(0)!.lifecycle_revision ?? 0, 'user:cancel')
    else store.completeTodo(0, 'done', 'User completed the work.')
    const before = readFileSync(join(dir, 'todos.yaml'), 'utf8')
    await expect(todoUpdate(todo.id!, { pr: 42 }, testRepository)).rejects.toThrow()
    expect(readFileSync(join(dir, 'todos.yaml'), 'utf8')).toBe(before)
    expect(store.get(0)?.status).toBe(status)
  })

  it('still permits an explicit otherwise-valid lifecycle decision alongside linkage', async () => {
    const todo = store.add({ ref: 'explicit', title: 'Explicit', type: 'feature' })
    await todoUpdate(todo.id!, { status: 'backlog', pr: 42 }, testRepository)
    expect(store.get(0)).toMatchObject({ status: 'backlog', pr: 42 })
  })

  it('reads a legacy PR without rewriting its YAML or treating the issue ref as a PR', async () => {
    store.add({ ref: '#123', title: 'Legacy', type: 'docs' })
    store.update(0, { pr: 41, status: 'active' })
    const file = join(dir, 'todos.yaml')
    const before = readFileSync(file, 'utf8')
    const listing = await todoList(testRepository)
    expect(listing).toContain('/pull/41')
    expect(listing).not.toContain('/pull/123')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('renders and filters all six lifecycle states without changing linked PRs', async () => {
    const statuses = ['idea', 'backlog', 'active', 'paused', 'done', 'cancelled'] as const
    const todos = statuses.map(status => ({
      ...store.add({ ref: status, title: `Work ${status}`, type: 'feature' }), status, pr: 42,
    }))
    const file = join(dir, 'todos.yaml')
    writeFileSync(file, JSON.stringify({ todos }))
    const before = readFileSync(file, 'utf8')
    const listing = await todoList(testRepository)
    expect(listing).toContain('> 1 active · 1 backlog · 1 idea · 1 paused · 1 done · 1 cancelled\n')
    expect(listing).toContain('### Paused')
    expect(listing).toContain('### Cancelled')
    expect(listing).toContain('Completed, not archived')
    expect(listing).toContain('Cancelled, not archived')
    expect(listing.match(/\/pull\/42/g)).toHaveLength(statuses.length)
    for (const status of statuses) {
      const filtered = await todoList(testRepository, status)
      expect(filtered).toContain(`Work ${status}`)
      expect(filtered).toContain('/pull/42')
      for (const other of statuses.filter(other => other !== status)) expect(filtered).not.toContain(`Work ${other}`)
    }
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid PR number %s without writing', async (pr) => {
    const todo = store.add({ ref: 'invalid', title: 'Invalid PR', type: 'docs' })
    const before = readFileSync(join(dir, 'todos.yaml'), 'utf8')
    await expect(todoUpdate(todo.id!, { pr }, testRepository)).rejects.toThrow(/PR|number|integer/i)
    expect(readFileSync(join(dir, 'todos.yaml'), 'utf8')).toBe(before)
  })
})
