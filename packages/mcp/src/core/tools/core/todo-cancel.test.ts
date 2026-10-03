import { testProjectDirectory, testRepository } from '../../utils/test-repository.js'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoStore } from '../../storage/todo-store.js'
import { RemoteEffects } from '../../storage/remote-effects.js'
import { issueCloseReceiptPath, writeIssueCloseReceipt } from '../../storage/issue-close-journal.js'
import { archiveTodos, todoArchiveSnapshot, todoCancel, todoReopen } from './todo-lifecycle.js'
import { todoDetail } from './todo-detail.js'

vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockImplementation(async () => ({
    owner: 'owner', name: 'repo', directory: testProjectDirectory(),
    repository: { platform: 'github', instance: 'https://github.com', path: 'owner/repo' },
  })),
}))

describe('explicit plain Todo cancellation', () => {
  let home: string
  let directory: string
  let store: TodoStore
  let todoId: string
  const cancel = (revision = 0, decision = 'user:do-not-continue') => todoCancel(testRepository, todoId, revision, decision)
  const snapshot = () => readFileSync(join(directory, 'todos.yaml'), 'utf8')

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-cancel-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    directory = testProjectDirectory()
    store = new TodoStore(directory)
    todoId = store.add({ ref: 'cancel-me', title: 'Cancel me', type: 'chore' }).id!
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('cancels an unstarted task without creating execution or verification evidence', async () => {
    const result = await cancel()
    expect(result).toMatchObject({ todo_id: todoId, archived: false, todo: {
      status: 'cancelled', executions: [], last_cancellation: {
        decision: 'user:do-not-continue', lifecycle_revision: 0,
      },
    } })
    const before = snapshot()
    expect(await cancel()).toEqual(result)
    expect(snapshot()).toBe(before)
    expect(store.listArchived()).toEqual([])
    expect(await todoDetail(todoId, testRepository)).toContain('user:do-not-continue')
  })

  it('closes a plain execution as abandoned while retaining its progress and evidence', async () => {
    const execution = store.activateExecution(0).execution
    store.progressExecution(0, { next: 'Finish later', blocked_on: 'Waiting for input' })
    const result = await cancel()
    expect(result.todo.executions).toHaveLength(1)
    expect(result.todo.executions[0]).toMatchObject({
      id: execution.id, outcome: 'abandoned', phase: 'finish', blocked_on: null,
      outcome_note: 'user:do-not-continue', evidence: [],
    })
    expect(result.todo.executions[0]!.closed_at).toBeTruthy()
    expect(result.todo.executions[0]).not.toHaveProperty('workflow')
  })

  it('does not require a ref or invent a document-backed execution to keep the decision', async () => {
    const todo = store.add({ ref: null, title: 'No ref', type: 'chore' })
    expect((await todoCancel(testRepository, todo.id!, 0, 'user:no-ref-cancel')).todo)
      .toMatchObject({ status: 'cancelled', executions: [], last_cancellation: { decision: 'user:no-ref-cancel' } })
  })

  it('rejects empty decisions, inexact identity and invalid revisions without mutation', async () => {
    const before = snapshot()
    await expect(cancel(0, '  ')).rejects.toThrow('decision')
    await expect(todoCancel(testRepository, 'cancel-me', 0, 'user:cancel')).rejects.toThrow('Exact stable')
    for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(cancel(revision)).rejects.toThrow('revision')
    }
    expect(snapshot()).toBe(before)
  })

  it('rejects stale cancellation after reopening and accepts a new explicit decision', async () => {
    await cancel()
    const first = store.get(0)!.last_cancellation
    await todoReopen(todoId, testRepository)
    const before = snapshot()
    await expect(cancel()).rejects.toThrow('revision changed')
    expect(snapshot()).toBe(before)
    expect(store.get(0)!.last_cancellation).toEqual(first)
    const second = await cancel(1, 'user:cancel-reopened-work')
    expect(second.todo).toMatchObject({ status: 'cancelled', executions: [], last_cancellation: {
      decision: 'user:cancel-reopened-work', lifecycle_revision: 1,
    } })
  })

  it('does not rewrite a cancelled decision or change done into cancelled', async () => {
    await cancel()
    const before = snapshot()
    await expect(cancel(0, 'user:different-decision')).rejects.toThrow('another decision')
    expect(snapshot()).toBe(before)
    await todoReopen(todoId, testRepository)
    store.completeTodo(0, 'done', 'User completed the reopened task.')
    await expect(cancel(1)).rejects.toThrow('Reopen')
    expect(store.get(0)!.status).toBe('done')
  })

  it('requires the managed control path even before a workspace is bound', async () => {
    const executionId = store.activateExecution(0).execution.id
    store.applyWorkflow(todoId, executionId, {
      request_id: 'pause', expected_revision: 0,
      command: { action: 'request_control', kind: 'pause', control_id: 'pause',
        decision: 'user:pause', note: 'Pause first.' },
    })
    const before = snapshot()
    await expect(cancel()).rejects.toThrow(/todo_control/)
    expect(snapshot()).toBe(before)
  })

  it('blocks pending PR effects without pretending cancellation settled them', async () => {
    new RemoteEffects(directory, todoId).reserve({
      kind: 'pr', execution_id: null, repo: testRepository,
      payload: { title: 'In flight', head: 'feature', base: 'main', body: '', draft: false },
    })
    const before = snapshot()
    await expect(cancel()).rejects.toThrow('Unresolved remote effects')
    expect(snapshot()).toBe(before)
  })

  it.each(['pending', 'closed'] as const)('blocks a %s Issue journal until its original operation is accounted for', async state => {
    const identity = { repository: testRepository, issueNumber: 3, todoId, executionId: null }
    writeIssueCloseReceipt(issueCloseReceiptPath(directory, testRepository, 3, todoId, null), {
      ...identity, lifecycleRevision: 0, state, startedAt: new Date().toISOString(),
      dispatch: { version: 1, initializedAt: new Date().toISOString(), commentDigest: '0'.repeat(64), effects: [] },
      ...(state === 'closed' ? { remoteClosedAt: new Date().toISOString() } : {}),
    })
    const before = snapshot()
    await expect(cancel()).rejects.toThrow(/Issue.*operation|issue_close/i)
    expect(snapshot()).toBe(before)
  })

  it.each([null, '', '  ', 7, {}])('blocks cancellation when a retained Issue journal has malformed identity %j', async identity => {
    const path = issueCloseReceiptPath(directory, testRepository, 3, todoId, null)
    mkdirSync(join(directory, '.operations'), { recursive: true })
    writeFileSync(path, JSON.stringify({ todoId: identity, state: 'pending' }))
    const before = snapshot()
    await expect(cancel()).rejects.toThrow(/identity.*unknown/i)
    expect(snapshot()).toBe(before)
    expect(readFileSync(path, 'utf8')).toContain('"pending"')
  })

  it('rejects cancellation during a partial explicit archive instead of changing either copy', async () => {
    await cancel()
    const selection = { todo_id: todoId, snapshot: todoArchiveSnapshot(store.get(0)!) }
    mkdirSync(join(directory, 'todos.yaml.tmp'))
    expect(await archiveTodos(testRepository, [selection])).toContain('| failed |')
    const active = snapshot()
    const archived = store.listArchived()
    await expect(cancel()).rejects.toThrow('pending archival')
    expect(snapshot()).toBe(active)
    expect(store.listArchived()).toEqual(archived)
  })
})
