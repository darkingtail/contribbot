import { testProjectDirectory, testRepository } from '../../utils/test-repository.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore } from '../../storage/todo-store.js'
import { RecordFiles } from '../../storage/record-files.js'
import { todoDetail } from './todo-detail.js'
import { todoUpdate } from './todo-update.js'
import { observeTodoPulls } from './todo-pr-progress.js'
import { fixtureRepository } from '../../execution/__fixtures__/repository.js'
import { pullIdentity } from '../../storage/todo-pulls.js'

const github = vi.hoisted(() => ({ getPull: vi.fn(), getPullReviews: vi.fn() }))
vi.mock('../../clients/github.js', () => github)
vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockImplementation(async () => ({
    owner: 'owner', name: 'repo', directory: testProjectDirectory(),
    repository: { platform: 'github', instance: 'https://github.com', path: 'owner/repo' },
  })),
}))

describe('independent PR progress', () => {
  let home: string
  let dir: string
  let store: TodoStore
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'todo-pr-progress-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    dir = testProjectDirectory()
    store = new TodoStore(dir)
    github.getPull.mockReset()
    github.getPullReviews.mockReset().mockResolvedValue([])
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('shows each remote state alongside, not instead of, user prose and lifecycle', async () => {
    const todo = store.add({ ref: 'visible', title: 'Visible', type: 'feature' })
    store.update(0, { status: 'active' })
    new RecordFiles(dir).createTodoRecord(todo.ref!, todo.title, todo.type, '2026-09-19', todo.id)
    for (const pr of [1, 2, 3, 4]) await todoUpdate(todo.id!, { pr }, testRepository)
    github.getPull.mockImplementation(async (_owner, _repo, number) => ({
      number, state: number >= 3 ? 'closed' : 'open', merged: number === 4, draft: number === 1,
    }))
    const file = join(dir, 'todos.yaml')
    const before = readFileSync(file, 'utf8')
    const detail = await todoDetail(todo.id!, testRepository)
    expect(detail).toContain('Todo status: `active`')
    expect(detail).toContain('## Linked PR Progress')
    expect(detail).toContain('not acceptance evidence')
    expect(detail).toContain('# Visible')
    for (const state of ['draft', 'open', 'closed', 'merged']) expect(detail).toContain(`| ${state} |`)
    expect(github.getPull).toHaveBeenCalledTimes(4)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(store.listArchived()).toEqual([])
  })

  it('isolates read failures, rejects malformed identity, and does not leak raw errors', async () => {
    const todo = store.add({ ref: 'unknown', title: 'Unknown', type: 'feature' })
    for (const pr of [1, 2, 3]) await todoUpdate(todo.id!, { pr }, testRepository)
    github.getPull.mockImplementation(async (_owner, _repo, number) => {
      if (number === 1) throw new Error('private-secret-response')
      return { number: number === 2 ? 999 : number, state: 'closed', merged: true, draft: false }
    })
    const detail = await todoDetail(todo.id!, testRepository)
    expect(detail.match(/\) \| unknown \|/g)).toHaveLength(2)
    expect(detail.match(/\| merged \|/g)).toHaveLength(1)
    expect(detail).not.toContain('private-secret-response')
    expect(store.get(0)?.status).toBe('idea')
  })

  it('refreshes Todo state and labels a newly linked PR unobserved across the remote await', async () => {
    const todo = store.add({ ref: 'changed', title: 'Changed', type: 'feature' })
    await todoUpdate(todo.id!, { pr: 1 }, testRepository)
    let release!: (value: unknown) => void
    github.getPull.mockReturnValue(new Promise(resolve => { release = resolve }))
    const pending = todoDetail(todo.id!, testRepository)
    await vi.waitFor(() => expect(github.getPull).toHaveBeenCalledTimes(1))
    await todoUpdate(todo.id!, { pr: 2, status: 'backlog' }, testRepository)
    release({ number: 1, state: 'closed', merged: true, draft: false })
    const detail = await pending
    expect(detail).toContain('Todo status: `backlog`')
    expect(detail).toContain('pull/1) | merged')
    expect(detail).toContain('pull/2) | unknown')
    expect(detail).toContain('Not read in this snapshot')
    expect(github.getPull).toHaveBeenCalledTimes(1)
  })

  it('does not return another Todo or stale status after deletion and same-ref replacement', async () => {
    const todo = store.add({ ref: 'replaced', title: 'Original', type: 'docs' })
    await todoUpdate(todo.id!, { pr: 1 }, testRepository)
    let release!: (value: unknown) => void
    github.getPull.mockReturnValue(new Promise(resolve => { release = resolve }))
    const pending = todoDetail(todo.id!, testRepository)
    await vi.waitFor(() => expect(github.getPull).toHaveBeenCalledTimes(1))
    store.delete(0)
    store.add({ ref: 'replaced', title: 'Replacement', type: 'docs' })
    release({ number: 1, state: 'closed', merged: true, draft: false })
    await expect(pending).rejects.toThrow(/changed|removed/)
    expect(store.get(0)).toMatchObject({ title: 'Replacement', pr: null })
  })

  it('shows archived history without turning a merge observation into a lifecycle change', async () => {
    const todo = store.add({ ref: 'archived', title: 'Archived', type: 'docs' })
    await todoUpdate(todo.id!, { pr: 1 }, testRepository)
    store.cancelTodo(todo.id!, store.get(0)!.lifecycle_revision ?? 0, 'user:cancel')
    store.archiveAndDelete(0)
    const before = readFileSync(join(dir, 'todos.archive.yaml'), 'utf8')
    github.getPull.mockResolvedValue({ number: 1, state: 'closed', merged: true, draft: false })
    const detail = await todoDetail(todo.id!, testRepository)
    expect(detail).toContain('Todo status: `cancelled`')
    expect(detail).toContain('| merged |')
    expect(readFileSync(join(dir, 'todos.archive.yaml'), 'utf8')).toBe(before)
    expect(store.list()).toEqual([])
    expect(github.getPullReviews).not.toHaveBeenCalled()
  })

  it('bounds concurrent reads to four and total reads to twenty, with explicit missing observations', async () => {
    const todo = store.add({ ref: 'many', title: 'Many', type: 'feature' })
    const pulls = Array.from({ length: 25 }, (_, index) => ({ repo: testRepository, number: index + 1 }))
    store.update(0, { pull_requests: pulls })
    let running = 0
    let maximum = 0
    github.getPull.mockImplementation(async (_owner, _repo, number) => {
      running++
      maximum = Math.max(maximum, running)
      await new Promise(resolve => setTimeout(resolve, 2))
      running--
      return { number, state: 'open', merged: false, draft: false }
    })
    const detail = await todoDetail(todo.id!, testRepository)
    expect(maximum).toBe(4)
    expect(github.getPull).toHaveBeenCalledTimes(20)
    expect(detail.match(/\| unknown \|/g)).toHaveLength(5)
    expect(detail).toContain('20-PR read limit')
  })

  it('uses each exact repository and does not conflate identical PR numbers', async () => {
    const pulls = [{ repo: testRepository, number: 1 }, { repo: fixtureRepository('other/project'), number: 1 }]
    github.getPull.mockResolvedValue({ number: 1, state: 'open', merged: false, draft: false })
    const observations = await observeTodoPulls(pulls)
    expect([...observations.keys()]).toEqual(pulls.map(pull => pullIdentity(pull)))
    expect(github.getPull).toHaveBeenCalledWith('owner', 'repo', 1)
    expect(github.getPull).toHaveBeenCalledWith('other', 'project', 1)
  })
})
