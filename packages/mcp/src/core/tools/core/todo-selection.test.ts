import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore } from '../../storage/todo-store.js'
import { getContribDir } from '../../utils/config.js'
import { todoActivate } from './todo-activate.js'
import { todoDetail } from './todo-detail.js'
import { todoUpdate } from './todo-update.js'
import { todoProgress } from './todo-progress.js'
import { todoAdd, todoDelete, todoDone, todoList } from './todos.js'
import { archiveTodos, todoArchiveSnapshot, todoCancel } from './todo-lifecycle.js'
import { patrolRecord } from './patrol-record.js'

vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockResolvedValue({ owner: 'owner', name: 'repo' }),
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
    const result = await todoDone(item, 'owner/repo')
    const store = new TodoStore(getContribDir('owner', 'repo'))
    const resolved = store.resolveItemForArchival(item)!
    store.archiveAndDelete(resolved.storeIndex)
    return result
  }

  it('uses one exact-ref contract across detail, update, activate, delete and done', async () => {
    await todoAdd('Detail task', 'detail-ref', 'owner/repo')
    await todoAdd('Update task', 'update-ref', 'owner/repo')
    await todoAdd('Activate task', 'activate-ref', 'owner/repo')
    await todoAdd('Delete task', 'delete-ref', 'owner/repo')
    await todoAdd('Done task', 'done-ref', 'owner/repo')

    expect(await todoDetail('detail-ref', 'owner/repo')).toContain('# Detail task')
    expect(await todoUpdate('update-ref', { branch: 'feat/update-ref' }, 'owner/repo')).toContain('Updated **Update task**')
    expect(await todoActivate('activate-ref', undefined, 'owner/repo')).toContain('Activated: **Activate task**')
    expect(await todoDelete('delete-ref', 'owner/repo')).toContain('Deleted: ~~Delete task~~')
    expect(await todoDone('done-ref', 'owner/repo')).toContain('Done: ~~Done task~~')
  })

  it('prints global indexes that resolve to the same items, including filtered lists', async () => {
    const store = new TodoStore(getContribDir('owner', 'repo'))
    store.add({ ref: 'backlog-ref', title: 'Backlog task', type: 'chore' })
    store.update(0, { status: 'backlog' })
    store.add({ ref: 'active-ref', title: 'Active task', type: 'feature' })
    store.update(1, { status: 'active' })

    const list = await todoList('owner/repo')
    expect(list).toContain('| 1 | active-ref | feature | Active task |')
    expect(list).toContain('| 2 | backlog-ref | chore | Backlog task |')
    expect(store.resolveItem('1')?.item.ref).toBe('active-ref')
    expect(store.resolveItem('2')?.item.ref).toBe('backlog-ref')

    const filtered = await todoList('owner/repo', 'backlog')
    expect(filtered).toContain('| 2 | backlog-ref | chore | Backlog task |')
  })

  it('creates, resumes, progresses, renders and archives one execution aggregate', async () => {
    await todoAdd('Phase 3 task', 'phase3-ref', 'owner/repo')

    await todoActivate('phase3-ref', undefined, 'owner/repo')
    const store = new TodoStore(getContribDir('owner', 'repo'))
    const initial = store.resolveItem('phase3-ref')!.item
    const first = initial.executions[0]!

    await todoActivate('phase3-ref', undefined, 'owner/repo')
    expect(store.resolveItem('phase3-ref')!.item.executions).toHaveLength(1)
    expect(store.resolveItem('phase3-ref')!.item.executions[0]!.id).toBe(first.id)

    const completion = await completeAndArchive('phase3-ref')
    const todoId = completion.match(/Todo ID: `(t-[^`]+)`/)?.[1]
    expect(todoId).toBeTruthy()
    expect(store.list()).toEqual([])
    expect(store.listArchived()[0]!.id).toBe(todoId)

    await todoActivate(todoId!, undefined, 'owner/repo')
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
    }, 'owner/repo')
    expect(progress).toContain('Phase → execute')

    const detail = await todoDetail('phase3-ref', 'owner/repo')
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
    const archivedDetail = await todoDetail(archived.id!, 'owner/repo')
    expect(archivedDetail).toContain('Todo completed.')
    expect(archivedDetail).toContain('conversation:approval')
    expect(archivedDetail).toContain(first.id)
  })

  it('retries archived reactivation without splitting todo identity or execution history', async () => {
    await todoAdd('Retry reactivation', 'retry-reactivation', 'owner/repo')
    await todoActivate('retry-reactivation', undefined, 'owner/repo')
    const dir = getContribDir('owner', 'repo')
    const store = new TodoStore(dir)
    const todoId = store.resolveItem('retry-reactivation')!.item.id!
    await completeAndArchive('retry-reactivation')
    mkdirSync(join(dir, 'todos.archive.yaml.tmp'))

    await expect(todoActivate(todoId, undefined, 'owner/repo')).rejects.toThrow()
    expect(store.list()[0]).toMatchObject({ id: todoId, status: 'backlog', pending_transition: 'restore' })
    expect(store.listArchived()[0]!.id).toBe(todoId)
    await expect(todoUpdate('retry-reactivation', { branch: 'feat/must-not-mutate' }, 'owner/repo'))
      .rejects.toThrow('pending archive restoration')

    rmSync(join(dir, 'todos.archive.yaml.tmp'), { recursive: true, force: true })
    await todoActivate('1', undefined, 'owner/repo')

    const restored = store.resolveItem(todoId)!.item
    expect(restored.id).toBe(todoId)
    expect(restored.executions).toHaveLength(2)
    expect(restored.executions[0]).toMatchObject({ outcome: 'done' })
    expect(restored.executions[1]).toMatchObject({ closed_at: null, outcome: null })
    expect(restored.pending_transition).toBeUndefined()
    expect(store.listArchived()).toEqual([])
  })

  it('reactivates a completed todo that had no previous execution', async () => {
    await todoAdd('Direct completion', 'direct-completion', 'owner/repo')
    const completion = await todoDone('direct-completion', 'owner/repo')
    const todoId = completion.match(/Todo ID: `(t-[^`]+)`/)?.[1]
    expect(todoId).toBeTruthy()

    await todoActivate(todoId!, undefined, 'owner/repo')

    const restored = new TodoStore(getContribDir('owner', 'repo')).resolveItem(todoId!)!.item
    expect(restored.executions).toHaveLength(1)
    expect(restored.executions[0]).toMatchObject({ closed_at: null, outcome: null })
  })

  it('rejects restoring an archived todo when another active todo owns its ref', async () => {
    await todoAdd('First owner', 'shared-ref', 'owner/repo')
    await todoActivate('shared-ref', undefined, 'owner/repo')
    const store = new TodoStore(getContribDir('owner', 'repo'))
    const archivedId = store.resolveItem('shared-ref')!.item.id!
    await completeAndArchive('shared-ref')
    await todoAdd('Second owner', 'shared-ref', 'owner/repo')

    await expect(todoActivate(archivedId, undefined, 'owner/repo')).rejects.toThrow('already belongs')

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]).toMatchObject({ ref: 'shared-ref', title: 'Second owner' })
    expect(store.listArchived()[0]!.id).toBe(archivedId)
  })

  it('preserves evidence when explicitly cancelling an unmanaged open execution', async () => {
    await todoAdd('Deferred task', 'deferred-ref', 'owner/repo')
    await todoActivate('deferred-ref', undefined, 'owner/repo')
    await todoProgress('deferred-ref', {
      evidence: [{
        source: 'test',
        locator: 'pytest:deferred',
        observed_at: '2026-09-16T09:00:00.000Z',
        digest: 'Deferral condition reproduced.',
        revision: 'rev-deferred',
      }],
    }, 'owner/repo')

    const store = new TodoStore(getContribDir('owner', 'repo'))
    const todoId = store.findByRef('deferred-ref')!.id!
    await todoCancel('owner/repo', todoId, 0, 'fixture:user-defers-task')

    const cancelled = store.list()[0]!
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.executions[0]).toMatchObject({ phase: 'finish', outcome: 'abandoned' })
    expect(store.listArchived()).toEqual([])
    const detail = await todoDetail(cancelled.id!, 'owner/repo')
    expect(detail).toContain('fixture:user-defers-task')
    expect(detail).toContain('pytest:deferred')
    expect(detail).toContain('rev-deferred')
  })

  it('rejects done status updates so completion stays on the todo_done path', async () => {
    await todoAdd('Canonical completion', 'canonical-done', 'owner/repo')
    await todoActivate('canonical-done', undefined, 'owner/repo')

    await expect(todoUpdate('canonical-done', { status: 'done' }, 'owner/repo'))
      .rejects.toThrow('todo_done')

    const todo = new TodoStore(getContribDir('owner', 'repo')).resolveItem('canonical-done')!.item
    expect(todo.status).toBe('active')
    expect(todo.executions[0]).toMatchObject({ closed_at: null, outcome: null })
  })

  it('rejects notes for a ref-less todo instead of silently discarding them', async () => {
    const store = new TodoStore(getContribDir('owner', 'repo'))
    const todo = store.add({ ref: null, title: 'Legacy ref-less todo', type: 'chore' })

    await expect(todoUpdate(todo.id!, { note: 'Must not disappear.' }, 'owner/repo'))
      .rejects.toThrow('no ref-backed record')
    await expect(todoUpdate(todo.id!, { status: 'backlog', note: 'Still must not disappear.' }, 'owner/repo'))
      .rejects.toThrow('no ref-backed record')

    expect(store.resolveItemById(todo.id!)!.item.status).toBe('idea')
    expect(store.listArchived()).toEqual([])
  })

  it('keeps cancellation independent of archive write failures', async () => {
    await todoAdd('Retry deferral', 'retry-deferral', 'owner/repo')
    await todoActivate('retry-deferral', undefined, 'owner/repo')
    const dir = getContribDir('owner', 'repo')
    mkdirSync(join(dir, 'todos.archive.yaml.tmp'))

    const store = new TodoStore(dir)
    const todoId = store.findByRef('retry-deferral')!.id!
    await todoCancel('owner/repo', todoId, 0, 'fixture:defer')
    expect(store.list()[0]!.status).toBe('cancelled')
    const closedAt = store.list()[0]!.executions[0]!.closed_at
    expect(closedAt).toBeTruthy()
    expect(store.listArchived()).toEqual([])

    rmSync(join(dir, 'todos.archive.yaml.tmp'), { recursive: true, force: true })
    await todoCancel('owner/repo', todoId, 0, 'fixture:defer')
    expect(store.list()[0]!.executions[0]).toMatchObject({ outcome: 'abandoned', closed_at: closedAt })
  })

  it('does not duplicate a note when explicit archival is retried', async () => {
    await todoAdd('Retry note deferral', 'retry-note-deferral', 'owner/repo')
    const dir = getContribDir('owner', 'repo')
    const recordPath = join(dir, 'todos', 'retry-note-deferral.md')
    await todoUpdate('retry-note-deferral', {
      note: 'Deferred for the same reason.',
    }, 'owner/repo')
    const store = new TodoStore(dir)
    const todoId = store.findByRef('retry-note-deferral')!.id!
    await todoCancel('owner/repo', todoId, 0, 'fixture:defer-with-note')
    const selected = [{ todo_id: todoId, snapshot: todoArchiveSnapshot(store.list()[0]!) }]
    mkdirSync(join(dir, 'todos.archive.yaml.tmp'))
    expect(await archiveTodos('owner/repo', selected)).toContain('| failed |')
    expect(store.listArchived()).toEqual([])

    rmSync(join(dir, 'todos.archive.yaml.tmp'), { recursive: true, force: true })
    expect(await archiveTodos('owner/repo', selected)).toContain('| success |')
    expect(await archiveTodos('owner/repo', selected)).toContain('Already archived')
    expect(store.list()).toEqual([])
    expect(store.listArchived()).toHaveLength(1)

    const content = readFileSync(recordPath, 'utf-8')
    expect(content.match(/Deferred for the same reason\./g)).toHaveLength(1)
  })

  it('retries completion of a backlog todo without confusing it for restoration', async () => {
    await todoAdd('Backlog retry', 'backlog-retry', 'owner/repo')
    await todoUpdate('backlog-retry', { status: 'backlog' }, 'owner/repo')
    const dir = getContribDir('owner', 'repo')
    const store = new TodoStore(dir)
    mkdirSync(join(dir, 'todos.yaml.tmp'))

    await expect(todoDone('backlog-retry', 'owner/repo')).rejects.toThrow()
    expect(store.list()).toHaveLength(1)
    expect(store.listArchived()).toHaveLength(0)

    rmSync(join(dir, 'todos.yaml.tmp'), { recursive: true, force: true })
    await todoDone('backlog-retry', 'owner/repo')
    expect(store.list()[0]!.status).toBe('done')
    expect(store.listArchived()).toHaveLength(0)
  })

  it('does not show a reused refs record in archived detail for another todo id', async () => {
    await todoAdd('Historical owner', 'reused-record', 'owner/repo')
    const store = new TodoStore(getContribDir('owner', 'repo'))
    const historicalId = store.resolveItem('reused-record')!.item.id!
    await completeAndArchive('reused-record')

    await todoAdd('Current owner', 'reused-record', 'owner/repo')
    await todoUpdate('reused-record', { note: 'Current owner note.' }, 'owner/repo')

    const detail = await todoDetail(historicalId, 'owner/repo')
    expect(detail).toContain(`Todo ID: \`${historicalId}\``)
    expect(detail).not.toContain('Current owner note.')
    expect(detail).not.toContain('# Current owner')
  })

  it('does not show a reused refs stamped record for a legacy archive without an id', async () => {
    const dir = getContribDir('owner', 'repo')
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

    await todoAdd('Current owner', 'legacy-reused', 'owner/repo')
    await todoUpdate('legacy-reused', { note: 'Current owner note.' }, 'owner/repo')

    const detail = await todoDetail('Legacy historical owner', 'owner/repo')
    expect(detail).toContain('Legacy historical owner')
    expect(detail).not.toContain('Current owner note.')
    expect(detail).not.toContain('# Current owner')
  })

  it('does not treat an archived stable id as an active title substring', async () => {
    await todoAdd('Historical owner', 'historical-owner', 'owner/repo')
    const store = new TodoStore(getContribDir('owner', 'repo'))
    const historicalId = store.findByRef('historical-owner')!.id!
    await completeAndArchive(historicalId)
    await todoAdd(`Follow up ${historicalId}`, 'shadow-owner', 'owner/repo')

    await expect(todoDone(historicalId, 'owner/repo')).rejects.toThrow('Todo not found')

    expect(store.listArchived()).toHaveLength(1)
    expect(store.listArchived()[0]!.id).toBe(historicalId)
    expect(store.findByRef('shadow-owner')?.title).toBe(`Follow up ${historicalId}`)
  })

  it('keeps an id-less active todo from reading, mutating, or deleting an archived legacy record', async () => {
    const dir = getContribDir('owner', 'repo')
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

    const detail = await todoDetail('Active legacy owner', 'owner/repo')
    expect(detail).not.toContain('Archived note.')

    await todoUpdate('Active legacy owner', { note: 'Active note.' }, 'owner/repo')
    const store = new TodoStore(dir)
    const active = store.findByRef('shared-legacy')!
    expect(active.id).toMatch(/^t-/)
    expect(readFileSync(legacyPath, 'utf-8')).not.toContain('Active note.')

    await todoDelete(active.id!, 'owner/repo')
    expect(existsSync(legacyPath)).toBe(true)
    expect(readFileSync(legacyPath, 'utf-8')).toContain('Archived note.')
  })

  it('blocks deletion after a partial archive and reconciles the explicit archive selection', async () => {
    await todoAdd('Partial archive', 'partial-archive', 'owner/repo')
    const dir = getContribDir('owner', 'repo')
    const store = new TodoStore(dir)
    const todoId = store.findByRef('partial-archive')!.id!
    await todoDone(todoId, 'owner/repo')
    const selected = [{ todo_id: todoId, snapshot: todoArchiveSnapshot(store.list()[0]!) }]
    mkdirSync(join(dir, 'todos.yaml.tmp'))

    expect(await archiveTodos('owner/repo', selected)).toContain('| failed |')
    rmSync(join(dir, 'todos.yaml.tmp'), { recursive: true, force: true })

    const before = store.list()
    const archived = store.listArchived()
    await expect(todoDelete(todoId, 'owner/repo')).rejects.toThrow('Todo not found')
    expect(() => store.delete(0)).toThrow('pending archival')
    expect(store.list()).toEqual(before)
    expect(store.listArchived()).toEqual(archived)
    expect(await archiveTodos('owner/repo', selected)).toContain('Reconciled partial')

    expect(store.list()).toEqual([])
    expect(store.listArchived()[0]!.id).toBe(todoId)
    expect(await todoDetail(todoId, 'owner/repo')).toContain('# Partial archive')
  })

  it('records a patrol run without creating todos or executions', async () => {
    await patrolRecord({
      repo: 'owner/repo',
      run_id: 'run-no-side-effects',
      report: '# Patrol report',
      snapshot_json: '{}',
      analysis_json: '{}',
      trace_json: '[]',
      actions_json: '[]',
    })

    expect(new TodoStore(getContribDir('owner', 'repo')).list()).toEqual([])
  })
})
