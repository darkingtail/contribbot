import { testProjectDirectory, testRepository } from '../../utils/test-repository.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TODO_STATUSES, TODO_UPDATABLE_STATUSES, UPSTREAM_ITEM_STATUSES } from '../../enums.js'
import { TodoStore } from '../../storage/todo-store.js'
import { todoUpdate } from './todo-update.js'

vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockResolvedValue({ owner: 'owner', name: 'repo' }),
}))

describe('six-state Todo contract', () => {
  let home: string
  let directory: string
  let store: TodoStore

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-six-state-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    directory = testProjectDirectory()
    store = new TodoStore(directory)
    store.add({ ref: 'task', title: 'Task', type: 'chore' })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('separates Todo lifecycle states from upstream delivery states', () => {
    expect([...TODO_STATUSES].sort()).toEqual(['active', 'backlog', 'cancelled', 'done', 'idea', 'paused'])
    expect(TODO_UPDATABLE_STATUSES).toEqual(['idea', 'backlog', 'active'])
    expect(UPSTREAM_ITEM_STATUSES).toContain('pr_submitted')
  })

  it.each(['pr_submitted', 'not_planned'])('rejects %s before metadata or note writes', async status => {
    const before = readFileSync(join(directory, 'todos.yaml'), 'utf8')
    await expect(todoUpdate('task', { status, pr: 42, branch: 'changed', note: 'Must not be saved' }, testRepository))
      .rejects.toThrow(/status/i)
    expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toBe(before)
  })

  it.each(['pr_submitted', 'not_planned'])('rejects direct library %s writes', status => {
    const before = readFileSync(join(directory, 'todos.yaml'), 'utf8')
    expect(() => store.update(0, { status: status as never, branch: 'changed' })).toThrow(/status/i)
    expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toBe(before)
  })

  it.each(['pr_submitted', 'not_planned'])('rejects stored %s without converting or rewriting it', status => {
    writeFileSync(join(directory, 'todos.yaml'), stringify({ todos: [{ ...store.get(0), status }] }))
    const before = readFileSync(join(directory, 'todos.yaml'), 'utf8')
    expect(() => store.list()).toThrow(/unsupported.*status|status.*unsupported/i)
    expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toBe(before)
  })
})
