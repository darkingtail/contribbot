import { testProjectDirectory, testRepository } from '../../utils/test-repository.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoStore } from '../../storage/todo-store.js'
import { RecordFiles } from '../../storage/record-files.js'
import { prCreate } from '../linkage/pr-create.js'
import { todoActivate } from './todo-activate.js'
import { todoClaim } from './todo-claim.js'
import { todoAdd } from './todos.js'

const github = vi.hoisted(() => ({
  getIssue: vi.fn(), getIssueComments: vi.fn(), getCurrentUser: vi.fn(), createComment: vi.fn(),
  createPull: vi.fn(), parseRepo: vi.fn(),
}))
vi.mock('../../clients/github.js', () => github)
vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockImplementation(async () => ({
    owner: 'owner', name: 'repo', directory: testProjectDirectory(),
    repository: { platform: 'github', instance: 'https://github.com', path: 'owner/repo' },
  })),
}))

describe('tool-level selection and publication transactions', () => {
  let home: string
  let directory: string
  let store: TodoStore
  const compete = () => {
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', fileURLToPath(new URL('./__fixtures__/transaction-race-worker.ts', import.meta.url)), directory,
    ], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    expect(child.status, child.stderr).toBe(0)
    return JSON.parse(child.stdout).outcome as string
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-tool-transactions-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    directory = testProjectDirectory()
    store = new TodoStore(directory)
    github.getIssue.mockReset().mockResolvedValue({
      number: 2, title: 'Target', state: 'open', user: { login: 'author' }, labels: [],
      created_at: '2026-09-17T00:00:00Z', html_url: 'https://github.com/owner/repo/issues/2', body: '',
    })
    github.getIssueComments.mockReset().mockResolvedValue([])
    github.getCurrentUser.mockReset().mockResolvedValue({ login: 'maintainer' })
    github.createComment.mockReset().mockResolvedValue({ id: 90 })
    github.createPull.mockReset().mockResolvedValue({ number: 77 })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })
  const seed = () => {
    store.add({ ref: 'earlier', title: 'Earlier', type: 'chore' })
    const target = store.add({ ref: '#2', title: 'Target', type: 'feature' })
    store.add({ ref: 'following', title: 'Following', type: 'bug' })
    return target.id!
  }

  it('keeps selection and initial activation in one transaction', async () => {
    const id = seed()
    const original = TodoStore.prototype.activateExecution
    let contender: string | undefined
    vi.spyOn(TodoStore.prototype, 'activateExecution').mockImplementation(function (this: TodoStore, index) {
      contender ??= compete()
      return original.call(this, index)
    })
    await todoActivate(id, 'feature/target', testRepository)
    expect(contender).toBe('blocked')
    expect(store.findByRef('following')!.executions).toEqual([])
    expect(store.resolveItemById(id)!.item.executions).toHaveLength(1)
  }, 15_000)

  it.each(['activate-final', 'pr-link', 'claim-save'] as const)('protects stable-identity revalidation and %s writeback', async (action) => {
    const id = seed()
    const original = TodoStore.prototype.update
    let contender: string | undefined
    vi.spyOn(TodoStore.prototype, 'update').mockImplementation(function (this: TodoStore, index, fields) {
      contender ??= compete()
      return original.call(this, index, fields)
    })
    if (action === 'activate-final') await todoActivate(id, 'feature/target', testRepository)
    if (action === 'pr-link') await prCreate('Target PR', 'feature/target', 'main', undefined, false, id, testRepository)
    if (action === 'claim-save') await todoClaim(id, ['Implement target'], testRepository)
    expect(contender).toBe('blocked')
    expect(store.findByRef('following')).toMatchObject({ status: 'idea', claimed_items: null, pr: null, branch: null })
    const target = store.resolveItemById(id)!.item
    if (action === 'activate-final') expect(target).toMatchObject({ status: 'active', branch: 'feature/target' })
    if (action === 'pr-link') expect(target).toMatchObject({ status: 'idea', pr: 77,
      pull_requests: [{ repo: testRepository, number: 77 }] })
    if (action === 'claim-save') expect(target.claimed_items).toEqual(['Implement target'])
  }, 15_000)

  it('does not allow deletion between publishing a new Todo and creating its document', async () => {
    const original = RecordFiles.prototype.createTodoRecord
    let contender: string | undefined
    vi.spyOn(RecordFiles.prototype, 'createTodoRecord').mockImplementation(function (this: RecordFiles, ...args) {
      contender ??= compete()
      return original.apply(this, args)
    })
    await todoAdd('New task', 'new-task', testRepository)
    expect(contender).toBe('blocked')
    const todo = store.findByRef('new-task')!
    expect(todo).toBeDefined()
    expect(new RecordFiles(directory).readRecord('new-task', todo.id)).toContain('New task')
  }, 15_000)
})
