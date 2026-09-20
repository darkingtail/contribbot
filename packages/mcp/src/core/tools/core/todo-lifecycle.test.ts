import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoStore } from '../../storage/todo-store.js'
import { getContribDir } from '../../utils/config.js'
import { todoActivate } from './todo-activate.js'
import { todoDone, todoList } from './todos.js'
import { archiveTodos, todoArchiveSnapshot, todoCancel, todoReopen, todoRestore } from './todo-lifecycle.js'
import { projectList } from './project-list.js'
import { closeManaged } from '../../execution/closure.js'

vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockResolvedValue({ owner: 'owner', name: 'repo' }),
}))

describe('completion, archival, restoration and reopening', () => {
  let home: string
  let directory: string
  let store: TodoStore
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-lifecycle-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    directory = getContribDir('owner', 'repo')
    store = new TodoStore(directory)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })
  const add = (ref: string) => store.add({ ref, title: ref, type: 'chore' }).id!
  const selection = (id: string) => ({ todo_id: id, snapshot: todoArchiveSnapshot(store.list().find(todo => todo.id === id)!) })

  it('completes and cancels without touching a broken archive destination', async () => {
    const done = add('done')
    const stopped = add('stopped')
    store.activateExecution(0)
    store.activateExecution(1)
    mkdirSync(join(directory, 'todos.archive.yaml.tmp'))
    await todoDone(done, 'owner/repo')
    await todoCancel('owner/repo', stopped, 0, 'fixture:stop')
    const first = store.list()
    expect(first.map(todo => todo.status)).toEqual(['done', 'cancelled'])
    expect(first.every(todo => todo.executions[0]!.closed_at !== null && !todo.pending_transition)).toBe(true)
    await todoDone(done, 'owner/repo')
    await todoCancel('owner/repo', stopped, 0, 'fixture:stop')
    expect(store.list()).toEqual(first)
    expect(store.listArchived()).toEqual([])
    expect(await todoList('owner/repo')).toContain('Cancelled, not archived')
    expect(await todoList('owner/repo', 'done')).toContain('Completed, not archived')
    expect(projectList()).toContain('0 / 1')
  })

  it('previews without writing and moves only the confirmed exact snapshot', async () => {
    const first = add('first')
    await todoDone(first, 'owner/repo')
    const selected = selection(first)
    const before = readFileSync(join(directory, 'todos.yaml'), 'utf8')
    expect(await archiveTodos('owner/repo')).toContain(selected.snapshot)
    expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toBe(before)
    const later = add('later')
    await todoDone(later, 'owner/repo')
    expect(await archiveTodos('owner/repo', [selected])).toContain('| success |')
    expect(store.list().map(todo => todo.id)).toEqual([later])
    expect(store.listArchived().map(todo => todo.id)).toEqual([first])
    expect(await archiveTodos('owner/repo', [selected])).toContain('Already archived')
    expect(store.listArchived()).toHaveLength(1)
  })

  it('rejects stale or wrong-identity selections and never completes unfinished work', async () => {
    const id = add('target')
    await todoDone(id, 'owner/repo')
    const old = selection(id)
    store.update(0, { title: 'Changed after preview' })
    expect(await archiveTodos('owner/repo', [old])).toContain('changed after preview')
    const open = add('open')
    expect(await archiveTodos('owner/repo', [selection(open)])).toContain('no open execution')
    expect(await archiveTodos('owner/repo', [{ ...selection(id), todo_id: open }])).toContain('| failed |')
    expect(store.listArchived()).toEqual([])
    expect(store.list().find(todo => todo.id === open)!.status).toBe('idea')
    expect(await archiveTodos('owner/repo', [])).toContain('no changes')
  })

  it('preserves outcome when restoring and opens a new execution only on activation', async () => {
    const id = add('history')
    store.activateExecution(0)
    await todoDone(id, 'owner/repo')
    const history = store.list()[0]!.executions
    await archiveTodos('owner/repo', [selection(id)])
    await todoRestore(id, 'owner/repo')
    expect(store.list()[0]).toMatchObject({ id, status: 'done', executions: history })
    expect(store.listArchived()).toEqual([])
    await todoReopen(id, 'owner/repo')
    expect(store.list()[0]).toMatchObject({ id, status: 'backlog', executions: history })
    await todoReopen(id, 'owner/repo')
    await todoActivate(id, undefined, 'owner/repo')
    expect(store.list()[0]!.executions).toHaveLength(2)
    expect(store.list()[0]!.executions[0]).toEqual(history[0])
    await expect(todoReopen(id, 'owner/repo')).rejects.toThrow('open execution')
  })

  it('keeps explicit cancellation unarchived and preserves it across archive and restore', async () => {
    const id = add('cancelled-history')
    const executionId = store.activateExecution(0).execution.id
    store.applyWorkflow(id, executionId, {
      request_id: 'cancel', expected_revision: 0,
      command: { action: 'request_control', control_id: 'cancel', kind: 'cancel',
        decision: 'user:cancel', note: 'Do not continue this work.' },
    })
    closeManaged({ directory, todo_id: id, execution_id: executionId,
      closure_id: 'cancel', expected_revision: 1, mode: 'stopped', acknowledged_gaps: [],
      decision: 'user:cancel', note: 'Partial work retained.', target: { kind: 'local' } })
    const history = store.list()[0]!.executions
    expect(store.list()[0]?.status).toBe('cancelled')
    expect(store.listArchived()).toEqual([])
    expect(await todoList('owner/repo', 'cancelled')).toContain('cancelled-history')
    await archiveTodos('owner/repo', [selection(id)])
    expect(store.list()).toEqual([])
    expect(store.listArchived()[0]?.status).toBe('cancelled')
    await todoRestore(id, 'owner/repo')
    expect(store.list()[0]).toMatchObject({ status: 'cancelled', executions: history })
    await todoReopen(id, 'owner/repo')
    expect(store.list()[0]).toMatchObject({ status: 'backlog', executions: history })
    expect(store.activateExecution(0).execution.id).not.toBe(executionId)
  })

  it('does not turn restoration retries into reopening after an interrupted move', async () => {
    const id = add('restore')
    await todoDone(id, 'owner/repo')
    await archiveTodos('owner/repo', [selection(id)])
    mkdirSync(join(directory, 'todos.archive.yaml.tmp'))
    await expect(todoRestore(id, 'owner/repo')).rejects.toThrow()
    expect(store.list()[0]).toMatchObject({ status: 'done', pending_transition: 'restore', lifecycle_revision: 1 })
    rmSync(join(directory, 'todos.archive.yaml.tmp'), { recursive: true })
    await todoRestore(id, 'owner/repo')
    expect(store.list()[0]).toMatchObject({ status: 'done', executions: [], lifecycle_revision: 1 })
    expect(store.list()[0]!.pending_transition).toBeUndefined()
    expect(store.listArchived()).toEqual([])
  })

  it.each([false, true])('recovers unversioned historical restoration once (archive already removed: %s)', async removed => {
    const id = add('old-restore')
    await todoDone(id, 'owner/repo')
    const old = selection(id)
    await archiveTodos('owner/repo', [old])
    const { archived: _archived, ...pending } = store.listArchived()[0]!
    writeFileSync(join(directory, 'todos.yaml'), stringify({ todos: [{ ...pending, pending_transition: 'restore' }] }))
    if (removed) writeFileSync(join(directory, 'todos.archive.yaml'), stringify({ todos: [] }))
    await todoRestore(id, 'owner/repo')
    const restored = store.list()
    expect(restored[0]).toMatchObject({ status: 'done', lifecycle_revision: 1 })
    expect(restored[0]!.pending_transition).toBeUndefined()
    await todoRestore(id, 'owner/repo')
    expect(store.list()).toEqual(restored)
    expect(await archiveTodos('owner/repo', [old])).toContain('changed after preview')
  })

  it('refuses mismatched restoration revisions without removing either copy', async () => {
    const id = add('restore-conflict')
    await todoDone(id, 'owner/repo')
    await archiveTodos('owner/repo', [selection(id)])
    const { archived: _archived, ...original } = store.listArchived()[0]!
    writeFileSync(join(directory, 'todos.yaml'), stringify({
      todos: [{ ...original, pending_transition: 'restore', lifecycle_revision: 2 }],
    }))
    const before = store.list()
    const archive = store.listArchived()
    await expect(todoRestore(id, 'owner/repo')).rejects.toThrow('conflicting lifecycle revision')
    expect(store.list()).toEqual(before)
    expect(store.listArchived()).toEqual(archive)
  })

  it('rejects inexact restore and reopen selectors before changing archive placement', async () => {
    const id = add('exact-only')
    await todoDone(id, 'owner/repo')
    await archiveTodos('owner/repo', [selection(id)])
    const before = store.listArchived()
    for (const query of ['exact-only', id.toUpperCase()]) {
      await expect(todoRestore(query, 'owner/repo')).rejects.toThrow('Exact stable')
      await expect(todoReopen(query, 'owner/repo')).rejects.toThrow('Exact stable')
    }
    expect(store.list()).toEqual([])
    expect(store.listArchived()).toEqual(before)
  })

  it('rejects invalid or exhausted revisions without wrapping or silently repairing data', async () => {
    const id = add('revision-limit')
    await todoDone(id, 'owner/repo')
    const terminal = store.list()[0]!
    writeFileSync(join(directory, 'todos.yaml'), stringify({
      todos: [{ ...terminal, lifecycle_revision: Number.MAX_SAFE_INTEGER }],
    }))
    const before = store.list()
    await expect(todoReopen(id, 'owner/repo')).rejects.toThrow('exhausted')
    expect(store.list()).toEqual(before)
    await archiveTodos('owner/repo', [selection(id)])
    await expect(todoRestore(id, 'owner/repo')).rejects.toThrow('exhausted')
    expect(store.list()).toEqual([])
    expect(store.listArchived()).toHaveLength(1)
    writeFileSync(join(directory, 'todos.yaml'), stringify({ todos: [{ ...terminal, lifecycle_revision: -1 }] }))
    expect(() => store.list()).toThrow('nonnegative safe integer')
  })

  it('reconciles partial explicit archival only with its unchanged selection', async () => {
    const id = add('partial')
    await todoDone(id, 'owner/repo')
    const selected = selection(id)
    mkdirSync(join(directory, 'todos.yaml.tmp'))
    expect(await archiveTodos('owner/repo', [selected])).toContain('| failed |')
    expect(store.list()[0]!.status).toBe('done')
    expect(store.listArchived()).toHaveLength(1)
    expect(await archiveTodos('owner/repo')).toContain('Pending transition')
    rmSync(join(directory, 'todos.yaml.tmp'), { recursive: true })
    expect(await archiveTodos('owner/repo', [selected])).toContain('Reconciled partial')
    expect(store.list()).toEqual([])
    expect(store.listArchived()).toHaveLength(1)
  })

  it('reports per-item failure without expanding or rolling back the confirmed batch', async () => {
    const first = add('first')
    const second = add('second')
    await todoDone(first, 'owner/repo')
    await todoDone(second, 'owner/repo')
    const selected = [selection(first), selection(second)]
    store.update(1, { title: 'Edited' })
    const result = await archiveTodos('owner/repo', selected)
    expect(result).toContain(`| ${first} | success |`)
    expect(result).toContain(`| ${second} | failed |`)
    expect(store.listArchived().map(todo => todo.id)).toEqual([first])
    expect(store.list().map(todo => todo.id)).toEqual([second])
  })

  it('invalidates old archival selections after restore even when content and date are unchanged', async () => {
    const id = add('restored-again')
    await todoDone(id, 'owner/repo')
    const old = selection(id)
    await archiveTodos('owner/repo', [old])
    await todoRestore(id, 'owner/repo')
    expect(await archiveTodos('owner/repo', [old])).toContain('changed after preview')
    expect(store.list().map(todo => todo.id)).toEqual([id])
    expect(store.listArchived()).toEqual([])
    expect(await archiveTodos('owner/repo', [selection(id)])).toContain('| success |')
  })

  it.each([false, true])('reports an already stopped managed-history Todo without manufacturing another closure (reopened: %s)', async reopened => {
    const id = add('stopped-retry')
    const executionId = store.activateExecution(0).execution.id
    store.applyWorkflow(id, executionId, {
      request_id: 'plan', expected_revision: 0,
      command: {
        action: 'propose_plan', plan_id: 'plan', plan: {
          goal: 'Explore a possible change', completion_scope: 'task', remaining_scope: [], scope: ['.'], non_goals: [], risk: 'normal',
          steps: [{ id: 'explore', title: 'Explore', scope: ['.'], depends_on: [], acceptance_ids: ['user'] }],
          acceptance: [{ id: 'user', description: 'User reviews the findings', required: true, kind: 'manual', independent: false }],
        },
      },
    })
    store.applyWorkflow(id, executionId, {
      request_id: 'cancel', expected_revision: 1,
      command: { action: 'request_control', control_id: 'cancel', kind: 'cancel',
        decision: 'fixture:user-stop', note: 'Do not continue' },
    })
    const request = {
      directory, todo_id: id, execution_id: executionId, closure_id: 'stop',
      expected_revision: 2, mode: 'stopped' as const, acknowledged_gaps: [],
      decision: 'fixture:user-stop', note: 'Do not continue', target: { kind: 'local' as const },
    }
    closeManaged(request)
    const history = store.list()[0]!.executions
    if (reopened) {
      await todoReopen(id, 'owner/repo')
      await todoCancel('owner/repo', id, store.list()[0]!.lifecycle_revision ?? 0, 'fixture:user-stop')
    }
    const before = store.list()
    if (reopened) {
      expect(await todoCancel('owner/repo', id, before[0]!.lifecycle_revision ?? 0, 'fixture:user-stop'))
        .toMatchObject({ todo: before[0] })
    }
    else expect(closeManaged(request)).toEqual(before[0])
    expect(store.list()).toEqual(before)
    expect(store.list()[0]!.executions).toEqual(history)
    expect(() => store.completeTodo(0, 'abandoned', 'No new closure')).toThrow(/cancelTodo/i)
    await expect(todoCancel('owner/repo', id, before[0]!.lifecycle_revision ?? 0, 'fixture:different-decision'))
      .rejects.toThrow(/decision/i)
    await expect(todoDone(id, 'owner/repo')).rejects.toThrow(/managed/i)
    expect(store.list()).toEqual(before)
  })

  it('invalidates old archival selections across a no-execution reopen and completion cycle', async () => {
    const id = add('reopened-again')
    await todoDone(id, 'owner/repo')
    const old = selection(id)
    await todoReopen(id, 'owner/repo')
    await todoDone(id, 'owner/repo')
    expect(store.list()[0]!.executions).toEqual([])
    expect(await archiveTodos('owner/repo', [old])).toContain('changed after preview')
    expect(store.list().map(todo => todo.id)).toEqual([id])
    expect(store.listArchived()).toEqual([])
  })

  it('requires explicit identity preparation for old ended records and does not archive them', async () => {
    add('legacy')
    const legacy = store.list()[0]!
    delete legacy.id
    legacy.status = 'done'
    writeFileSync(join(directory, 'todos.yaml'), stringify({ todos: [legacy] }))
    expect(await archiveTodos('owner/repo')).toContain('Legacy identity missing')
    expect(store.list()[0]!.id).toBeUndefined()
    expect(await archiveTodos('owner/repo', undefined, true)).toContain('No archival was performed')
    expect(store.list()[0]!.id).toMatch(/^t-/)
    expect(store.listArchived()).toEqual([])
    await expect(archiveTodos('owner/repo', [], true)).rejects.toThrow('separate calls')
  })
})
