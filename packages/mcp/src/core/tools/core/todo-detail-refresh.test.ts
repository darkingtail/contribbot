import { testProjectDirectory, testRepository } from '../../utils/test-repository.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecordFiles } from '../../storage/record-files.js'
import { TodoStore } from '../../storage/todo-store.js'
import { todoDetail } from './todo-detail.js'

const github = vi.hoisted(() => ({
  getPullReviews: vi.fn(),
}))

vi.mock('../../clients/github.js', () => github)
vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockImplementation(async () => ({
    owner: 'owner', name: 'repo', directory: testProjectDirectory(),
    repository: { platform: 'github', instance: 'https://github.com', path: 'owner/repo' },
  })),
}))

describe('todoDetail PR refresh', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'todo-detail-refresh-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    github.getPullReviews.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('does not append stale reviews when the linked PR changes during the await', async () => {
    const dir = testProjectDirectory()
    const store = new TodoStore(dir)
    const todo = store.add({ ref: 'review-target', title: 'Review target', type: 'feature' })
    store.activateExecution(0)
    store.update(0, { pr: 42, status: 'active' })
    const records = new RecordFiles(dir)
    records.createTodoRecord('review-target', todo.title, todo.type, '2026-09-17', todo.id)

    let releaseReviews!: (value: Array<{ state: string; user: { login: string } }>) => void
    github.getPullReviews.mockReturnValue(new Promise(resolve => { releaseReviews = resolve }))
    const detail = todoDetail(todo.id!, testRepository)
    await vi.waitFor(() => expect(github.getPullReviews).toHaveBeenCalledWith('owner', 'repo', 42))
    store.update(0, { pr: 99 })
    releaseReviews([{ state: 'CHANGES_REQUESTED', user: { login: 'reviewer' } }])
    await detail

    expect(records.readRecord('review-target', todo.id)).not.toContain('PR #42')
  })

  it('does not append the same PR feedback again after the cache expires', async () => {
    const dir = testProjectDirectory()
    const store = new TodoStore(dir)
    const todo = store.add({ ref: 'review-repeat', title: 'Review repeat', type: 'feature' })
    store.activateExecution(0)
    store.update(0, { pr: 42, status: 'active' })
    const records = new RecordFiles(dir)
    records.createTodoRecord('review-repeat', todo.title, todo.type, '2026-09-16', todo.id)
    github.getPullReviews.mockResolvedValue([{ state: 'CHANGES_REQUESTED', user: { login: 'reviewer' } }])

    await todoDetail(todo.id!, testRepository)
    const recordPath = records.resolveOwnedRefPath('review-repeat', todo.id)!
    const old = new Date(Date.now() - 6 * 60 * 1000)
    utimesSync(recordPath, old, old)
    await todoDetail(todo.id!, testRepository)

    const content = records.readRecord('review-repeat', todo.id)!
    expect(content.match(/### PR #42/g)).toHaveLength(1)
    expect(github.getPullReviews).toHaveBeenCalledTimes(2)
  })

  it.each(['missing', 'unreadable'] as const)('retains projection health and recovery in detail for a %s managed document', async (failure) => {
    const dir = testProjectDirectory()
    const store = new TodoStore(dir)
    const todo = store.add({ ref: 'managed-detail', title: 'Managed detail', type: 'docs' })
    const execution = store.activateExecution(0).execution
    store.applyWorkflow(todo.id!, execution.id, { request_id: 'plan', expected_revision: 0,
      command: { action: 'propose_plan', plan_id: 'plan', plan: {
        goal: 'Retain actual context', completion_scope: 'task', remaining_scope: [], scope: ['.'], non_goals: [], risk: 'normal',
        steps: [{ id: 'write', title: 'Write', scope: ['.'], depends_on: [], acceptance_ids: ['manual'] }],
        acceptance: [{ id: 'manual', description: 'User reviews the result', required: true, independent: false, kind: 'manual' }],
      } } })
    const path = new RecordFiles(dir).resolveOwnedRefPath(todo.ref!, todo.id)!
    rmSync(path)
    if (failure === 'unreadable') mkdirSync(path)
    const result = await todoDetail(todo.id!, testRepository)
    expect(result).toContain(`Document projection: ${failure === 'missing' ? 'outdated' : 'blocked'}`)
    expect(result).toContain('todo_resume')
    expect(result).toContain(todo.id!)
    expect(store.get(0)!.executions[0]!.workflow!.revision).toBe(1)
    expect(github.getPullReviews).not.toHaveBeenCalled()
  })

  it.each(['missing', 'unreadable'] as const)('refreshes projection health if the document becomes %s while waiting for reviews', async (failure) => {
    const dir = testProjectDirectory()
    const store = new TodoStore(dir)
    const todo = store.add({ ref: 'during-review', title: 'During review', type: 'docs' })
    const execution = store.activateExecution(0).execution
    store.applyWorkflow(todo.id!, execution.id, { request_id: 'plan', expected_revision: 0,
      command: { action: 'propose_plan', plan_id: 'plan', plan: {
        goal: 'Display current document health', completion_scope: 'task', remaining_scope: [], scope: ['.'], non_goals: [], risk: 'normal',
        steps: [{ id: 'write', title: 'Write', scope: ['.'], depends_on: [], acceptance_ids: ['manual'] }],
        acceptance: [{ id: 'manual', description: 'User reviews the result', required: true, independent: false, kind: 'manual' }],
      } } })
    store.update(0, { pr: 42 })
    const path = new RecordFiles(dir).resolveOwnedRefPath(todo.ref!, todo.id)!
    let release!: (reviews: unknown[]) => void
    github.getPullReviews.mockReturnValue(new Promise(resolve => { release = resolve }))
    const pending = todoDetail(todo.id!, testRepository)
    await vi.waitFor(() => expect(github.getPullReviews).toHaveBeenCalled())
    rmSync(path)
    if (failure === 'unreadable') mkdirSync(path)
    release([])
    const result = await pending
    expect(result).toContain(`Document projection: ${failure === 'missing' ? 'outdated' : 'blocked'}`)
    expect(result).not.toContain('Document projection: current')
    expect(result).toContain('todo_resume')
    expect(store.get(0)!.executions[0]!.workflow!.revision).toBe(1)
  })
})
