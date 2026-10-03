import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stringify } from 'yaml'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentTodoExecution, TodoStore } from '../storage/todo-store.js'
import { captureCandidate } from './candidate.js'
import { runCheck } from './checks.js'
import { closeManaged, prepareClosure, finalizeClosure } from './closure.js'
import { planDigest } from './workflow.js'
import type { WorkflowCommand, WorkflowPlanInput } from './contracts.js'
import { localMachine } from './processes.js'
import * as fsUtils from '../utils/fs.js'

describe('local managed closure with actual candidate and check artifacts', () => {
  let directory: string
  let workspace: string
  let storage: string
  let store: TodoStore
  let todoId: string
  let executionId: string
  let serial: number
  const state = () => store.list()[0]!.executions[0]!.workflow!
  const send = (command: WorkflowCommand) => store.applyWorkflow(todoId, executionId, {
    request_id: `fixture-${++serial}`, expected_revision: state()?.revision ?? 0, command,
  })
  const input = (mode: 'verified' | 'with_gaps' | 'stopped' = 'verified', gaps: string[] = []) => ({
    directory: storage, todo_id: todoId, execution_id: executionId, closure_id: 'finish',
    expected_revision: state().revision, mode, acknowledged_gaps: gaps,
    decision: 'explicit-user-finish-turn', note: 'Requested final outcome',
    target: { kind: 'local' as const },
  })
  const cancel = () => send({
    action: 'request_control', control_id: 'cancel', kind: 'cancel',
    decision: 'explicit-user-finish-turn', note: 'User explicitly cancels this task.',
  })
  const check = async () => runCheck({
    directory: storage, todo_id: todoId, execution_id: executionId,
    request_id: 'test-run', operation_id: 'test-command', acceptance_id: 'behavior',
    actor: 'local-runner', expected_revision: state().revision,
  })

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'contribbot-closure-'))
    workspace = join(directory, 'repo')
    storage = join(directory, 'data')
    mkdirSync(workspace)
    const git = (...args: string[]) => execFileSync('git', [
      '-c', 'core.hooksPath=nonexistent-hooks', '-c', 'commit.gpgSign=false', ...args,
    ], { cwd: workspace, windowsHide: true, stdio: 'pipe' })
    git('init', '--quiet', '--initial-branch=fixture')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(workspace, 'source.txt'), 'implemented')
    git('add', '.')
    git('commit', '--quiet', '-m', 'fixture')
    store = new TodoStore(storage)
    todoId = store.add({ ref: 'feature', title: 'Feature', type: 'feature' }).id!
    executionId = store.activateExecution(0).execution.id
    serial = 0
    const plan: WorkflowPlanInput = {
      completion_scope: 'task', remaining_scope: [],
      goal: 'Deliver working code', scope: ['.'], non_goals: ['Publish'], risk: 'normal',
      steps: [{ id: 'code', title: 'Implement', scope: ['.'], depends_on: [], acceptance_ids: ['behavior'] }],
      acceptance: [{
        id: 'behavior', description: 'Actual content is correct', kind: 'command', independent: false, required: true,
        command: {
          executable: process.execPath,
          argv: ['-e', "if(require('node:fs').readFileSync('source.txt','utf8') !== 'implemented') process.exit(1)"],
          timeout_ms: 2000, max_output_bytes: 4096,
        },
      }],
    }
    send({ action: 'propose_plan', plan_id: 'plan', plan })
    send({ action: 'confirm_plan', plan_id: 'plan', digest: planDigest(plan), confirmation: 'user-plan-turn' })
    const { root, git_dir, common_dir, digest } = captureCandidate(workspace)
    send({
      action: 'start_attempt', attempt_id: 'attempt', owner: 'primary',
      workspace: { repo: { platform: 'github', instance: 'https://github.com', path: 'fixture/repo' },
        root, git_dir, common_dir, baseline: digest, machine: localMachine() },
    })
    send({
      action: 'yield', actor: 'primary', candidate: { root, git_dir, common_dir, digest },
      observed_operations: [], note: 'No writes remain.',
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  function replan(scope: 'task' | 'stage', id: string) {
    const original = state()
    const plan: WorkflowPlanInput = {
      ...original.plans.at(-1)!.content, completion_scope: scope,
      remaining_scope: scope === 'stage' ? ['Implement the remaining user workflow'] : [],
    }
    const workspace = original.attempts.at(-1)!.workspace
    send({ action: 'propose_plan', plan_id: id, plan })
    send({ action: 'confirm_plan', plan_id: id, digest: planDigest(plan), confirmation: 'fixture:scope-reviewed' })
    send({ action: 'start_attempt', attempt_id: `${id}-attempt`, owner: 'primary', workspace })
    const { root, git_dir, common_dir, digest } = captureCandidate(workspace.root)
    send({ action: 'yield', actor: 'primary', candidate: { root, git_dir, common_dir, digest },
      observed_operations: [], note: 'Fixture settled' })
  }

  it('keeps a checked stage active, then accepts a separately confirmed whole-task plan', async () => {
    replan('stage', 'design-only')
    await check()
    const before = readFileSync(join(storage, 'todos.yaml'), 'utf8')
    for (const mode of ['verified', 'with_gaps'] as const) {
      expect(() => closeManaged(input(mode))).toThrow(/stage|coverage/i)
      expect(readFileSync(join(storage, 'todos.yaml'), 'utf8')).toBe(before)
    }
    expect(store.get(0)!.status).toBe('active')
    expect(currentTodoExecution(store.get(0)!)).toBeDefined()
    expect(state().checks).toHaveLength(1)
    replan('task', 'whole-task')
    expect(() => closeManaged(input())).toThrow(/acceptance/i)
    await runCheck({
      directory: storage, todo_id: todoId, execution_id: executionId,
      request_id: 'whole-test', operation_id: 'whole-test', acceptance_id: 'behavior',
      actor: 'local-runner', expected_revision: state().revision,
    })
    const completed = closeManaged({ ...input(), closure_id: 'whole-completed' })
    expect(completed.status).toBe('done')
    expect(completed.executions).toHaveLength(1)
    expect(completed.executions[0]!.workflow!.checks).toHaveLength(2)
    expect(store.listArchived()).toEqual([])
  }, 30_000)

  it('reads legacy plans without rewriting and requires coverage before new completion', async () => {
    await check()
    const todos = store.list()
    const historical = todos[0]!.executions[0]!.workflow!.plans[0]!
    delete historical.content.completion_scope
    delete historical.content.remaining_scope
    historical.digest = planDigest(historical.content)
    writeFileSync(join(storage, 'todos.yaml'), stringify({ todos }))
    const original = readFileSync(join(storage, 'todos.yaml'), 'utf8')
    expect(state().plans[0]!.digest).toBe(historical.digest)
    expect(state().plans[0]!.content).not.toHaveProperty('completion_scope')
    expect(() => closeManaged(input('with_gaps'))).toThrow(/coverage|completion_scope/i)
    expect(readFileSync(join(storage, 'todos.yaml'), 'utf8')).toBe(original)
    cancel()
    expect(closeManaged({ ...input('stopped'), closure_id: 'stop-legacy' }).status).toBe('cancelled')
  }, 20_000)

  it('does not reinterpret an already completed legacy plan during idempotent retry', async () => {
    await check()
    const request = input()
    closeManaged(request)
    const todos = store.list()
    const historical = todos[0]!.executions[0]!.workflow!.plans[0]!
    delete historical.content.completion_scope
    delete historical.content.remaining_scope
    historical.digest = planDigest(historical.content)
    writeFileSync(join(storage, 'todos.yaml'), stringify({ todos }))
    const original = store.list()[0]!
    writeFileSync(join(workspace, 'later.txt'), 'New work, unrelated to historical completion')
    expect(closeManaged(request)).toEqual(original)
  }, 20_000)

  it('completes a verified candidate without archiving and retries before and after explicit archival', async () => {
    await check()
    const request = input()
    const completed = closeManaged(request)
    expect(store.list()).toEqual([completed])
    expect(completed.status).toBe('done')
    expect(completed.pending_transition).toBeUndefined()
    expect(completed.executions[0]!.workflow!.closure).toMatchObject({ mode: 'verified', gaps: [], id: 'finish' })
    expect(completed.executions[0]!.closed_at).toBeTruthy()
    expect(store.listArchived()).toEqual([])
    expect(closeManaged(request)).toEqual(completed)
    const archived = store.archiveAndDelete(0)
    expect(closeManaged(request)).toEqual(archived)
    expect(store.listArchived()).toHaveLength(1)
  }, 20_000)

  it('refuses a missing check without archiving and permits explicitly acknowledged unverified delivery', () => {
    expect(() => closeManaged(input())).toThrow(/behavior|acceptance/i)
    expect(store.listArchived()).toEqual([])
    const request = { ...input('with_gaps', ['acceptance:behavior']), closure_id: 'unverified' }
    const archived = closeManaged(request)
    expect(archived.status).toBe('done')
    expect(archived.executions[0]!.workflow!.closure).toMatchObject({
      mode: 'with_gaps', gaps: ['acceptance:behavior'],
    })
  }, 15_000)

  it('rejects stopped closure without cancel control before any reservation or persistent write', () => {
    const before = readFileSync(join(storage, 'todos.yaml'))
    const write = vi.spyOn(fsUtils, 'safeWriteFileSync')
    expect(() => closeManaged(input('stopped'))).toThrow(/cancel.*control|control.*cancel/i)
    expect(write).not.toHaveBeenCalled()
    expect(readFileSync(join(storage, 'todos.yaml'))).toEqual(before)
    expect(state().closings).toEqual([])
    expect(state().closing_id).toBeNull()
    expect(state().closure).toBeNull()
    expect(store.listArchived()).toEqual([])
    expect(store.get(0)!.status).toBe('active')
  })

  it('does not turn stopped work into verified work', () => {
    cancel()
    const archived = closeManaged(input('stopped'))
    expect(archived.status).toBe('cancelled')
    expect(archived.executions[0]!.outcome).toBe('abandoned')
    expect(archived.executions[0]!.workflow!.closure!.mode).toBe('stopped')
  }, 15_000)

  it('does not turn reopened managed history into legacy completion without a new execution', () => {
    cancel()
    closeManaged(input('stopped'))
    store.reopen(todoId)
    const before = store.list()
    expect(() => store.completeTodo(0, 'done', 'Legacy completion bypass')).toThrow(/managed/i)
    expect(store.list()).toEqual(before)
    expect(store.list()[0]!.executions[0]!.workflow!.closure!.mode).toBe('stopped')
  }, 15_000)

  it('checks artifact existence, not just stored passed strings', async () => {
    const result = await check()
    rmSync(join(storage, 'executions', executionId, 'artifacts', `${result.artifact}.json`))
    expect(() => closeManaged(input())).toThrow(/artifact|receipt/i)
    expect(store.listArchived()).toEqual([])
    expect(currentTodoExecution(store.list()[0]!)).toBeDefined()
  }, 20_000)

  it('rejects drift between preparation and finalization without releasing an uncertain close', async () => {
    await check()
    const request = input()
    prepareClosure(request)
    expect(state().closing_id).toBe('finish')
    expect(() => send({
      action: 'begin_operation', operation_id: 'writer', kind: 'write', actor: 'primary',
      delegated: false, step_id: 'code', scope: ['.'], purpose: 'Race the close',
    })).toThrow(/closing|closure/i)
    writeFileSync(join(workspace, 'later.txt'), 'new content')
    expect(() => finalizeClosure(request)).toThrow(/candidate|drift/i)
    expect(store.listArchived()).toEqual([])
    expect(state().closing_id).toBe('finish')
  }, 20_000)

  it('blocks all closure modes while writer liveness is unknown', () => {
    send({
      action: 'begin_operation', operation_id: 'lost', kind: 'write', actor: 'worker',
      delegated: false, step_id: 'code', scope: ['.'], purpose: 'Lost writer',
    })
    send({ action: 'mark_unknown', operation_id: 'lost', reason: 'Host disconnected' })
    for (const mode of ['verified', 'with_gaps', 'stopped'] as const) {
      if (mode === 'stopped') cancel()
      expect(() => closeManaged(input(mode, ['acceptance:behavior']))).toThrow(/unknown|unresolved/i)
    }
    expect(store.listArchived()).toEqual([])
  }, 15_000)

  it('archive failure does not fail completion or block retries and subsequent work', async () => {
    await check()
    const request = input()
    mkdirSync(join(storage, 'todos.archive.yaml.tmp'))
    closeManaged(request)
    const closed = store.list()[0]!.executions[0]!
    expect(closed.workflow!.closure!.mode).toBe('verified')
    expect(closed.closed_at).not.toBeNull()
    expect(store.list()[0]!.pending_transition).toBeUndefined()
    expect(() => store.archiveAndDelete(0)).toThrow()
    writeFileSync(join(workspace, 'after-completion.txt'), 'subsequent work is not historical validation')
    expect(closeManaged(request).executions[0]!.closed_at).toBe(closed.closed_at)
    rmSync(join(storage, 'todos.archive.yaml.tmp'), { recursive: true })
    store.archiveAndDelete(0)
    expect(store.list()).toEqual([])
    expect(store.listArchived()).toHaveLength(1)
    expect(existsSync(join(storage, 'executions', executionId, 'receipts'))).toBe(true)
  }, 20_000)

  it('permits another task to acquire the same workspace after completion without archival', async () => {
    await check()
    closeManaged(input())
    const original = state()
    const plan = original.plans[0]!.content
    const workspace = original.attempts[0]!.workspace
    const other = store.add({ ref: 'next-task', title: 'Next task', type: 'chore' })
    const execution = store.activateExecution(1).execution.id
    store.applyWorkflow(other.id!, execution, {
      request_id: 'plan', expected_revision: 0, command: { action: 'propose_plan', plan_id: 'plan', plan },
    })
    store.applyWorkflow(other.id!, execution, {
      request_id: 'confirm', expected_revision: 1,
      command: { action: 'confirm_plan', plan_id: 'plan', digest: planDigest(plan), confirmation: 'fixture:new-task-approval' },
    })
    store.applyWorkflow(other.id!, execution, {
      request_id: 'bind', expected_revision: 2,
      command: { action: 'start_attempt', attempt_id: 'attempt', owner: 'primary', workspace },
    })
    const acquired = store.applyWorkflow(other.id!, execution, {
      request_id: 'write', expected_revision: 3,
      command: { action: 'begin_operation', operation_id: 'next-writer', kind: 'write', actor: 'primary',
        delegated: false, step_id: 'code', scope: ['.'], purpose: 'Start the next authorized task' },
    })
    expect(acquired.operations[0]!.status).toBe('running')
    expect(store.listArchived()).toEqual([])
    expect(store.get(0)!.status).toBe('done')
  }, 20_000)
})
