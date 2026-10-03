import { testProjectDirectory, testRepository } from '../../utils/test-repository.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore } from '../../storage/todo-store.js'
import { RecordFiles } from '../../storage/record-files.js'
import { generateDefaultBranchName, todoActivate } from './todo-activate.js'
import { todoDone } from './todos.js'

const github = vi.hoisted(() => ({
  getIssue: vi.fn(),
  getIssueComments: vi.fn(),
}))

vi.mock('../../clients/github.js', () => github)
vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockImplementation(async () => ({
    owner: 'owner', name: 'repo', directory: testProjectDirectory(),
    repository: { platform: 'github', instance: 'https://github.com', path: 'owner/repo' },
  })),
}))

describe('generateDefaultBranchName', () => {
  it('generates feat/number-slug for issue ref', () => {
    const name = generateDefaultBranchName({ ref: '#259', title: 'Cascader showSearch support', type: 'feature' })
    expect(name).toBe('feat/259-cascader-showsearch-support')
  })

  it('uses fix prefix for bug type', () => {
    const name = generateDefaultBranchName({ ref: '#42', title: 'Fix dropdown overflow', type: 'bug' })
    expect(name).toBe('fix/42-fix-dropdown-overflow')
  })

  it('uses docs prefix for docs type', () => {
    const name = generateDefaultBranchName({ ref: '#10', title: 'Update API documentation', type: 'docs' })
    expect(name).toBe('docs/10-update-api-documentation')
  })

  it('uses slug ref directly for non-issue ref', () => {
    const name = generateDefaultBranchName({ ref: 'playground', title: 'Setup playground', type: 'chore' })
    expect(name).toBe('feat/playground')
  })

  it('generates from title when no ref', () => {
    const name = generateDefaultBranchName({ ref: null, title: 'Research WebSocket integration', type: 'feature' })
    expect(name).toBe('feat/research-websocket-integration')
  })

  it('falls back to task when title has no usable words', () => {
    const name = generateDefaultBranchName({ ref: null, title: '测试', type: 'feature' })
    expect(name).toBe('feat/task')
  })

  it('filters stop words from slug', () => {
    const name = generateDefaultBranchName({ ref: '#1', title: 'Fix the bug with the modal', type: 'bug' })
    expect(name).toBe('fix/1-fix-bug-modal')
  })

  it('limits slug to 3 words', () => {
    const name = generateDefaultBranchName({ ref: '#1', title: 'Add new fancy dropdown component widget', type: 'feature' })
    expect(name).toBe('feat/1-add-new-fancy')
  })
})

describe('todoActivate concurrency', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'todo-activate-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    github.getIssue.mockReset()
    github.getIssueComments.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('re-resolves the activated todo by stable id after GitHub awaits', async () => {
    const store = new TodoStore(testProjectDirectory())
    store.add({ ref: 'earlier', title: 'Earlier', type: 'chore' })
    store.add({ ref: '#2', title: 'Target issue', type: 'bug' })
    store.add({ ref: 'following', title: 'Following', type: 'feature' })

    let releaseIssue!: (value: unknown) => void
    github.getIssue.mockReturnValue(new Promise(resolve => { releaseIssue = resolve }))
    github.getIssueComments.mockResolvedValue([])

    const activation = todoActivate('#2', undefined, testRepository)
    await vi.waitFor(() => expect(store.resolveItem('#2')!.item.executions).toHaveLength(1))
    store.delete(0)

    releaseIssue({
      number: 2,
      title: 'Target issue',
      state: 'open',
      user: { login: 'author' },
      labels: [{ name: 'bug' }],
      created_at: '2026-09-17T00:00:00.000Z',
      updated_at: '2026-09-17T00:00:00.000Z',
      html_url: 'https://github.com/owner/repo/issues/2',
      body: '',
    })
    await activation

    expect(store.resolveItem('#2')!.item).toMatchObject({ status: 'active', branch: 'fix/2-target-issue' })
    expect(store.resolveItem('following')!.item).toMatchObject({ status: 'idea', branch: null })
  })

  it('does not fall back to a title match when the activated todo disappears', async () => {
    const store = new TodoStore(testProjectDirectory())
    const target = store.add({ ref: '#2', title: 'Target issue', type: 'bug' })
    store.add({ ref: 'shadow', title: `Follow up ${target.id}`, type: 'feature' })

    let releaseIssue!: (value: unknown) => void
    github.getIssue.mockReturnValue(new Promise(resolve => { releaseIssue = resolve }))
    github.getIssueComments.mockResolvedValue([])

    const activation = todoActivate('#2', undefined, testRepository)
    await vi.waitFor(() => expect(store.resolveItem('#2')!.item.executions).toHaveLength(1))
    const targetIndex = store.resolveItem(target.id!)!.storeIndex
    store.delete(targetIndex, { force: true })

    releaseIssue({
      number: 2,
      title: 'Target issue',
      state: 'open',
      user: { login: 'author' },
      labels: [{ name: 'bug' }],
      created_at: '2026-09-17T00:00:00.000Z',
      updated_at: '2026-09-17T00:00:00.000Z',
      html_url: 'https://github.com/owner/repo/issues/2',
      body: '',
    })

    await expect(activation).rejects.toThrow('changed or was removed')
    expect(store.resolveItem('shadow')!.item).toMatchObject({ status: 'idea', executions: [] })
  })

  it('retries legacy record adoption after the todo id was already persisted', async () => {
    const dir = testProjectDirectory()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'todos.yaml'), `todos:
  - ref: legacy-active
    title: Legacy active
    type: chore
    status: idea
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2025-01-01"
    updated: "2025-01-01"
`, 'utf-8')
    const records = new RecordFiles(dir)
    const recordPath = records.createTodoRecord('legacy-active', 'Legacy active', 'chore', '2025-01-01')
    appendFileSync(recordPath, '\nLegacy note.\n', 'utf-8')
    mkdirSync(`${recordPath}.tmp`)

    await expect(todoActivate('legacy-active', undefined, testRepository)).rejects.toThrow()
    const store = new TodoStore(dir)
    const todoId = store.findByRef('legacy-active')!.id!
    expect(todoId).toMatch(/^t-/)

    rmSync(`${recordPath}.tmp`, { recursive: true, force: true })
    await todoActivate(todoId, undefined, testRepository)

    expect(records.readRecord('legacy-active', todoId)).toContain('Legacy note.')
    expect(readFileSync(recordPath, 'utf-8')).toContain(`contribbot:todo-id ${todoId}`)
  })

  it('updates one managed issue-details section across repeated execution cycles', async () => {
    const dir = testProjectDirectory()
    const store = new TodoStore(dir)
    const todo = store.add({ ref: '#2', title: 'Repeated issue', type: 'bug' })
    github.getIssue.mockResolvedValue({
      number: 2,
      title: 'Repeated issue',
      state: 'open',
      user: { login: 'author' },
      labels: [{ name: 'bug' }],
      created_at: '2026-09-16T00:00:00.000Z',
      updated_at: '2026-09-16T00:00:00.000Z',
      html_url: 'https://github.com/owner/repo/issues/2',
      body: 'Current issue body.',
    })
    github.getIssueComments.mockResolvedValue([])

    await todoActivate(todo.id!, undefined, testRepository)
    await todoDone(todo.id!, testRepository)
    await todoActivate(todo.id!, undefined, testRepository)

    const content = new RecordFiles(dir).readRecord('#2', todo.id)!
    expect(content.match(/## Issue Details/g)).toHaveLength(1)
    expect(content.match(/## Comments Summary/g)).toHaveLength(1)
  })
})
