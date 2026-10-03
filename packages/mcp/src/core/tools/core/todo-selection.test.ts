import { testProjectDirectory, testRepository } from '../../utils/test-repository.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore } from '../../storage/todo-store.js'
import { todoActivate } from './todo-activate.js'
import { todoDetail } from './todo-detail.js'
import { todoUpdate } from './todo-update.js'
import { todoProgress } from './todo-progress.js'
import { todoAdd, todoDelete, todoDone, todoList } from './todos.js'
import { archiveTodos, todoArchiveSnapshot, todoCancel } from './todo-lifecycle.js'
import { patrolRecord } from './patrol-record.js'

vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockImplementation(async () => ({
    owner: 'owner', name: 'repo', directory: testProjectDirectory(),
    repository: { platform: 'github', instance: 'https://github.com', path: 'owner/repo' },
  })),
}))

describe('Todo tool item selection', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'todo-selection-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  async function completeAndArchive(item: string) {
    const result = await todoDone(item, testRepository)
    const store = new TodoStore(testProjectDirectory())
    const resolved = store.resolveItemForArchival(item)!
    store.archiveAndDelete(resolved.storeIndex)
    return result
  }

  it('uses one exact-ref contract across detail, update, activate, delete and done', async () => {
    await todoAdd('Detail task', 'detail-ref', testRepository)
    await todoAdd('Update task', 'update-ref', testRepository)
    await todoAdd('Activate task', 'activate-ref', testRepository)
    await todoAdd('Delete task', 'delete-ref', testRepository)
    await todoAdd('Done task', 'done-ref', testRepository)

    expect(await todoDetail('detail-ref', testRepository)).toContain('# Detail task')
    expect(await todoUpdate('update-ref', { branch: 'feat/update-ref' }, testRepository)).toContain('Updated **Update task**')
    expect(await todoActivate('activate-ref', undefined, testRepository)).toContain('Activated: **Activate task**')
    expect(await todoDelete('delete-ref', testRepository)).toContain('Deleted: ~~Delete task~~')
    expect(await todoDone('done-ref', testRepository)).toContain('Done: ~~Done task~~')
  })

  it('prints global indexes that resolve to the same items, including filtered lists', async () => {
    const store = new TodoStore(testProjectDirectory())
    store.add({ ref: 'backlog-ref', title: 'Backlog task', type: 'chore' })
    store.update(0, { status: 'backlog' })
    store.add({ ref: 'active-ref', title: 'Active task', type: 'feature' })
    store.update(1, { status: 'active' })

    const list = await todoList(testRepository)
    expect(list).toContain('| 1 | active-ref | feature | Active task |')
    expect(list).toContain('| 2 | backlog-ref | chore | Backlog task |')
    expect(store.resolveItem('1')?.item.ref).toBe('active-ref')
    expect(store.resolveItem('2')?.item.ref).toBe('backlog-ref')

    const filtered = await todoList(testRepository, 'backlog')
    expect(filtered).toContain('| 2 | backlog-ref | chore | Backlog task |')
  })

  it('creates, resumes, progresses, renders and archives one execution aggregate', async () => {
    await todoAdd('Phase 3 task', 'phase3-ref', testRepository)

    await todoActivate('phase3-ref', undefined, testRepository)
    const store = new TodoStore(testProjectDirectory())
    const initial = store.resolveItem('phase3-ref')!.item
    const first = initial.executions[0]!

    await todoActivate('phase3-ref', undefined, testRepository)
    expect(store.resolveItem('phase3-ref')!.item.executions).toHaveLength(1)
    expect(store.resolveItem('phase3-ref')!.item.executions[0]!.id).toBe(first.id)

    const completion = await completeAndArchive('phase3-ref')
    const todoId = completion.match(/Todo ID: `(t-[^`]+)`/)?.[1]
    expect(todoId).toBeTruthy()
    expect(store.list()).toEqual([])
    expect(store.listArchived()[0]!.id).toBe(todoId)

    await todoActivate(todoId!, undefined, testRepository)
    const reopened = store.resolveItem(todoId!)!.item
    expect(reopened.id).toBe(todoId)
    expect(reopened.executions).toHaveLength(2)
    expect(reopened.executions[1]!.id).not.toBe(first.id)
    expect(store.listArchived()).toEqual([])

    const progress = await todoProgress('phase3-ref', {
      phase: 'execute',
      next: 'Implement the vertical slice.',
      blocked_on: null,
      evidence: [{
        source: 'human',
        locator: 'conversation:approval',
        observed_at: '2026-09-16T08:00:00.000Z',
        digest: 'User approved implementation.',
      }],
    }, testRepository)
    expect(progress).toContain('Phase → execute')

    const detail = await todoDetail('phase3-ref', testRepository)
    expect(detail).toContain(`Todo ID: \`${todoId}\``)
    expect(detail).toContain('## Current Execution')
    expect(detail).toContain('Implement the vertical slice.')
    expect(detail).toContain('conversation:approval')
    expect(detail).toContain('## Execution History')
    expect(detail).toContain('Todo completed.')

    await completeAndArchive('phase3-ref')
    const archived = store.listArchived()[0]!
    expect(archived.executions[0]).toMatchObject({ phase: 'finish', outcome: 'done' })
    expect(archived.executions[1]).toMatchObject({ phase: 'finish', outcome: 'done' })
    expect(archived.executions[1]!.closed_at).toBeTruthy()
    const archivedDetail = await todoDetail(archived.id!, testRepository)
    expect(archivedDetail).toContain('Todo completed.')
    expect(archivedDetail).toContain('conversation:approval')
    expect(archivedDetail).toContain(first.id)
  })

  it('retries archived reactivation without splitting todo identity or execution history', async () => {
    await todoAdd('Retry reactivation', 'retry-reactivation', testRepository)
    await todoActivate('retry-reactivation', undefined, testRepository)
    const dir = testProjectDirectory()
    const store = new TodoStore(dir)
    const todoId = store.resolveItem('retry-reactivation')!.item.id!
    await completeAndArchive('retry-reactivation')
    mkdirSync(join(dir, 'todos.archive.yaml.tmp'))

    await expect(todoActivate(todoId, undefined, testRepository)).rejects.toThrow()
    expect(store.list()[0]).toMatchObject({ id: todoId, status: 'backlog', pending_transition: 'restore' })
    expect(store.listArchived()[0]!.id).toBe(todoId)
    await expect(todoUpdate('retry-reactivation', { branch: 'feat/must-not-mutate' }, testRepository))
      .rejects.toThrow('pending archive restoration')

    rmSync(join(dir, 'todos.archive.yaml.tmp'), { recursive: true, force: true })
    await todoActivate('1', undefined, testRepository)

    const restored = store.resolveItem(todoId)!.item
    expect(restored.id).toBe(todoId)
    expect(restored.executions).toHaveLength(2)
    expect(restored.executions[0]).toMatchObject({ outcome: 'done' })
    expect(restored.executions[1]).toMatchObject({ closed_at: null, outcome: null })
    expect(restored.pending_transition).toBeUndefined()
    expect(store.listArchived()).toEqual([])
  })

  it('reactivates a completed todo that had no previous execution', async () => {
    await todoAdd('Direct completion', 'direct-completion', testRepository)
    const completion = await todoDone('direct-completion', testRepository)
    const todoId = completion.match(/Todo ID: `(t-[^`]+)`/)?.[1]
    expect(todoId).toBeTruthy()

    await todoActivate(todoId!, undefined, testRepository)

    const restored = new TodoStore(testProjectDirectory()).resolveItem(todoId!)!.item
    expect(restored.executions).toHaveLength(1)
    expect(restored.executions[0]).toMatchObject({ closed_at: null, outcome: null })
  })

  it('rejects restoring an archived todo when another active todo owns its ref', async () => {
    await todoAdd('First owner', 'shared-ref', testRepository)
    await todoActivate('shared-ref', undefined, testRepository)
    const store = new TodoStore(testProjectDirectory())
    const archivedId = store.resolveItem('shared-ref')!.item.id!
    await completeAndArchive('shared-ref')
    await todoAdd('Second owner', 'shared-ref', testRepository)

    await expect(todoActivate(archivedId, undefined, testRepository)).rejects.toThrow('already belongs')

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]).toMatchObject({ ref: 'shared-ref', title: 'Second owner' })
    expect(store.listArchived()[0]!.id).toBe(archivedId)
  })

  it('preserves evidence when explicitly cancelling an unmanaged open execution', async () => {
    await todoAdd('Deferred task', 'deferred-ref', testRepository)
    await todoActivate('deferred-ref', undefined, testRepository)
    await todoProgress('deferred-ref', {
      evidence: [{
        source: 'test',
        locator: 'pytest:deferred',
        observed_at: '2026-09-16T09:00:00.000Z',
        digest: 'Deferral condition reproduced.',
        revision: 'rev-deferred',
      }],
    }, testRepository)

    const store = new TodoStore(testProjectDirectory())
    const todoId = store.findByRef('deferred-ref')!.id!
    await todoCancel(testRepository, todoId, 0, 'fixture:user-defers-task')

    const cancelled = store.list()[0]!
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.executions[0]).toMatchObject({ phase: 'finish', outcome: 'abandoned' })
    expect(store.listArchived()).toEqual([])
    const detail = await todoDetail(cancelled.id!, testRepository)
    expect(detail).toContain('fixture:user-defers-task')
    expect(detail).toContain('pytest:deferred')
    expect(detail).toContain('rev-deferred')
  })

  it('rejects done status updates so completion stays on the todo_done path', async () => {
    await todoAdd('Canonical completion', 'canonical-done', testRepository)
    await todoActivate('canonical-done', undefined, testRepository)

    await expect(todoUpdate('canonical-done', { status: 'done' }, testRepository))
      .rejects.toThrow('todo_done')

    const todo = new TodoStore(testProjectDirectory()).resolveItem('canonical-done')!.item
    expect(todo.status).toBe('active')
    expect(todo.executions[0]).toMatchObject({ closed_at: null, outcome: null })
  })

  it('rejects notes for a ref-less todo instead of silently discarding them', async () => {
    const store = new TodoStore(testProjectDirectory())
    const todo = store.add({ ref: null, title: 'Legacy ref-less todo', type: 'chore' })

    await expect(todoUpdate(todo.id!, { note: 'Must not disappear.' }, testRepository))
      .rejects.toThrow('no ref-backed record')
    await expect(todoUpdate(todo.id!, { status: 'backlog', note: 'Still must not disappear.' }, testRepository))
      .rejects.toThrow('no ref-backed record')

    expect(store.resolveItemById(todo.id!)!.item.status).toBe('idea')
    expect(store.listArchived()).toEqual([])
  })

  it('keeps cancellation independent of archive write failures', async () => {
    await todoAdd('Retry deferral', 'retry-deferral', testRepository)
    await todoActivate('retry-deferral', undefined, testRepository)
    const dir = testProjectDirectory()
    mkdirSync(join(dir, 'todos.archive.yaml.tmp'))

    const store = new TodoStore(dir)
    const todoId = store.findByRef('retry-deferral')!.id!
    await todoCancel(testRepository, todoId, 0, 'fixture:defer')
    expect(store.list()[0]!.status).toBe('cancelled')
    const closedAt = store.list()[0]!.executions[0]!.closed_at
    expect(closedAt).toBeTruthy()
    expect(store.listArchived()).toEqual([])

    rmSync(join(dir, 'todos.archive.yaml.tmp'), { recursive: true, force: true })
    await todoCancel(testRepository, todoId, 0, 'fixture:defer')
    expect(store.list()[0]!.executions[0]).toMatchObject({ outcome: 'abandoned', closed_at: closedAt })
  })

  it('does not duplicate a note when explicit archival is retried', async () => {
    await todoAdd('Retry note deferral', 'retry-note-deferral', testRepository)
    const dir = testProjectDirectory()
    const recordPath = join(dir, 'todos', 'retry-note-deferral.md')
    await todoUpdate('retry-note-deferral', {
      note: 'Deferred for the same reason.',
    }, testRepository)
    const store = new TodoStore(dir)
    const todoId = store.findByRef('retry-note-deferral')!.id!
    await todoCancel(testRepository, todoId, 0, 'fixture:defer-with-note')
    const selected = [{ todo_id: todoId, snapshot: todoArchiveSnapshot(store.list()[0]!) }]
    mkdirSync(join(dir, 'todos.archive.yaml.tmp'))
    expect(await archiveTodos(testRepository, selected)).toContain('| failed |')
    expect(store.listArchived()).toEqual([])

    rmSync(join(dir, 'todos.archive.yaml.tmp'), { recursive: true, force: true })
    expect(await archiveTodos(testRepository, selected)).toContain('| success |')
    expect(await archiveTodos(testRepository, selected)).toContain('Already archived')
    expect(store.list()).toEqual([])
    expect(store.listArchived()).toHaveLength(1)

    const content = readFileSync(recordPath, 'utf-8')
    expect(content.match(/Deferred for the same reason\./g)).toHaveLength(1)
  })

  it('retries completion of a backlog todo without confusing it for restoration', async () => {
    await todoAdd('Backlog retry', 'backlog-retry', testRepository)
    await todoUpdate('backlog-retry', { status: 'backlog' }, testRepository)
    const dir = testProjectDirectory()
    const store = new TodoStore(dir)
    mkdirSync(join(dir, 'todos.yaml.tmp'))

    await expect(todoDone('backlog-retry', testRepository)).rejects.toThrow()
    expect(store.list()).toHaveLength(1)
    expect(store.listArchived()).toHaveLength(0)

    rmSync(join(dir, 'todos.yaml.tmp'), { recursive: true, force: true })
    await todoDone('backlog-retry', testRepository)
    expect(store.list()[0]!.status).toBe('done')
    expect(store.listArchived()).toHaveLength(0)
  })

  it('does not show a reused refs record in archived detail for another todo id', async () => {
    await todoAdd('Historical owner', 'reused-record', testRepository)
    const store = new TodoStore(testProjectDirectory())
    const historicalId = store.resolveItem('reused-record')!.item.id!
    await completeAndArchive('reused-record')

    await todoAdd('Current owner', 'reused-record', testRepository)
    await todoUpdate('reused-record', { note: 'Current owner note.' }, testRepository)

    const detail = await todoDetail(historicalId, testRepository)
    expect(detail).toContain(`Todo ID: \`${historicalId}\``)
    expect(detail).not.toContain('Current owner note.')
    expect(detail).not.toContain('# Current owner')
  })

  it('does not show a reused refs stamped record for a legacy archive without an id', async () => {
    const dir = testProjectDirectory()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'todos.archive.yaml'), `todos:
  - ref: legacy-reused
    title: Legacy historical owner
    type: chore
    status: done
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2025-01-01"
    updated: "2025-01-01"
    archived: "2025-01-02"
`, 'utf-8')

    await todoAdd('Current owner', 'legacy-reused', testRepository)
    await todoUpdate('legacy-reused', { note: 'Current owner note.' }, testRepository)

    const detail = await todoDetail('Legacy historical owner', testRepository)
    expect(detail).toContain('Legacy historical owner')
    expect(detail).not.toContain('Current owner note.')
    expect(detail).not.toContain('# Current owner')
  })

  it('does not treat an archived stable id as an active title substring', async () => {
    await todoAdd('Historical owner', 'historical-owner', testRepository)
    const store = new TodoStore(testProjectDirectory())
    const historicalId = store.findByRef('historical-owner')!.id!
    await completeAndArchive(historicalId)
    await todoAdd(`Follow up ${historicalId}`, 'shadow-owner', testRepository)

    await expect(todoDone(historicalId, testRepository)).rejects.toThrow('Todo not found')

    expect(store.listArchived()).toHaveLength(1)
    expect(store.listArchived()[0]!.id).toBe(historicalId)
    expect(store.findByRef('shadow-owner')?.title).toBe(`Follow up ${historicalId}`)
  })

  it('keeps an id-less active todo from reading, mutating, or deleting an archived legacy record', async () => {
    const dir = testProjectDirectory()
    mkdirSync(join(dir, 'todos'), { recursive: true })
    writeFileSync(join(dir, 'todos.archive.yaml'), `todos:
  - ref: shared-legacy
    title: Archived legacy owner
    type: chore
    status: done
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2024-01-01"
    updated: "2024-01-01"
    archived: "2024-01-02"
`, 'utf-8')
    writeFileSync(join(dir, 'todos.yaml'), `todos:
  - ref: shared-legacy
    title: Active legacy owner
    type: feature
    status: idea
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2025-01-01"
    updated: "2025-01-01"
`, 'utf-8')
    const legacyPath = join(dir, 'todos', 'shared-legacy.md')
    writeFileSync(legacyPath, '# Archived legacy owner\n\nArchived note.\n', 'utf-8')

    const detail = await todoDetail('Active legacy owner', testRepository)
    expect(detail).not.toContain('Archived note.')

    await todoUpdate('Active legacy owner', { note: 'Active note.' }, testRepository)
    const store = new TodoStore(dir)
    const active = store.findByRef('shared-legacy')!
    expect(active.id).toMatch(/^t-/)
    expect(readFileSync(legacyPath, 'utf-8')).not.toContain('Active note.')

    await todoDelete(active.id!, testRepository)
    expect(existsSync(legacyPath)).toBe(true)
    expect(readFileSync(legacyPath, 'utf-8')).toContain('Archived note.')
  })

  it('blocks deletion after a partial archive and reconciles the explicit archive selection', async () => {
    await todoAdd('Partial archive', 'partial-archive', testRepository)
    const dir = testProjectDirectory()
    const store = new TodoStore(dir)
    const todoId = store.findByRef('partial-archive')!.id!
    await todoDone(todoId, testRepository)
    const selected = [{ todo_id: todoId, snapshot: todoArchiveSnapshot(store.list()[0]!) }]
    mkdirSync(join(dir, 'todos.yaml.tmp'))

    expect(await archiveTodos(testRepository, selected)).toContain('| failed |')
    rmSync(join(dir, 'todos.yaml.tmp'), { recursive: true, force: true })

    const before = store.list()
    const archived = store.listArchived()
    await expect(todoDelete(todoId, testRepository)).rejects.toThrow('Todo not found')
    expect(() => store.delete(0)).toThrow('pending archival')
    expect(store.list()).toEqual(before)
    expect(store.listArchived()).toEqual(archived)
    expect(await archiveTodos(testRepository, selected)).toContain('Reconciled partial')

    expect(store.list()).toEqual([])
    expect(store.listArchived()[0]!.id).toBe(todoId)
    expect(await todoDetail(todoId, testRepository)).toContain('# Partial archive')
  })

  it('records a patrol run without creating todos or executions', async () => {
    await patrolRecord({
      repo: testRepository,
      run_id: 'run-no-side-effects',
      report: '# Patrol report',
      snapshot_json: '{}',
      analysis_json: '{}',
      trace_json: '[]',
      actions_json: '[]',
    })

    expect(new TodoStore(testProjectDirectory()).list()).toEqual([])
  })
})
