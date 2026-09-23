import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { TodoStore } from '../storage/todo-store.js'
import { ExecutionArtifacts } from './artifacts.js'
import { runLocalCommand } from './local.js'
import { recordCheckReport } from './reports.js'

describe('candidate-bound manual and review observations', () => {
  let home: string
  let workspace: string
  let directory: string
  let store: TodoStore
  let todoId: string
  let executionId: string
  type Result = { code: number | null; output: string; error: string }
  let workers: { child: ChildProcess; done: Promise<Result> }[]
  const state = () => store.list()[0]!.executions[0]!.workflow!
  const local = (action: string, input: Record<string, unknown> = {}) => runLocalCommand({
    action, repo: 'fixture/reports', data_root: join(home, 'data'),
    todo_id: todoId, execution_id: executionId, ...input,
  })
  const input = (id = 'review') => ({
    directory, todo_id: todoId, execution_id: executionId,
    request_id: id, expected_revision: state().revision, operation_id: id,
    plan_id: state().plan_id, attempt_id: state().attempt_id, epoch: state().epoch, candidate: state().yield!.candidate,
    observed_at: new Date().toISOString(),
    acceptance_id: 'review', actor: 'reviewer', source: 'host_report', outcome: 'passed',
    locator: 'fixture:actual-review-of-current-text', summary: 'Read the delivered document.',
  })
  const startWorker = (request: ReturnType<typeof input>, name: string, pausePublication: boolean, stall = false) => {
    const file = join(home, `${name}.json`)
    writeFileSync(file, JSON.stringify(request))
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
    const fixture = fileURLToPath(new URL('./__fixtures__/report-worker.ts', import.meta.url))
    const child = spawn(process.execPath, ['--import', loader, fixture, file, home, name, pausePublication ? 'yes' : 'no', stall ? 'yes' : 'no'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let error = ''
    child.stdout.on('data', data => { output = (output + data).slice(-65536) })
    child.stderr.on('data', data => { error = (error + data).slice(-65536) })
    child.on('error', failure => { error += String(failure) })
    const done = new Promise<Result>((resolve) => {
      child.once('close', code => resolve({ code, output, error }))
    })
    workers.push({ child, done })
    return done
  }
  const stoppedWithin = async (done: Promise<Result>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        done.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms) }),
      ])
    }
    finally { clearTimeout(timer) }
  }
  const finishWorkers = async (waitMs = 3000) => {
    await Promise.all(workers.map(async ({ child, done }) => {
      if (await stoppedWithin(done, waitMs)) return
      child.kill('SIGKILL')
      if (!await stoppedWithin(done, 3000)) throw new Error(`Worker did not stop; retained fixture ${home}.`)
    }))
  }
  const release = (stage: string) => writeFileSync(join(home, `${stage}.release`), 'release')
  const awaitBoth = (stage: string) => vi.waitFor(() => {
    for (const name of ['first', 'second']) expect(existsSync(join(home, `${name}-${stage}.ready`))).toBe(true)
  }, { timeout: 10000, interval: 20 })
  beforeEach(async () => {
    workers = []
    home = mkdtempSync(join(tmpdir(), 'contribbot-report-'))
    workspace = join(home, 'workspace')
    directory = join(home, 'data/fixture/reports')
    mkdirSync(workspace)
    const git = (...args: string[]) => execFileSync('git', [
      '-c', 'core.hooksPath=nonexistent-hooks', '-c', 'commit.gpgSign=false', ...args,
    ], { cwd: workspace, windowsHide: true, stdio: 'pipe' })
    git('init', '--quiet', '--initial-branch=fixture')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('remote', 'add', 'origin', 'https://github.com/fixture/reports.git')
    writeFileSync(join(workspace, 'README.md'), 'Reviewed candidate A')
    git('add', '.')
    git('commit', '--quiet', '-m', 'fixture')
    store = new TodoStore(directory)
    todoId = store.add({ ref: 'review', title: 'Inspect document', type: 'docs' }).id!
    executionId = store.activateExecution(0).execution.id
    writeFileSync(join(directory, 'config.yaml'), 'fork: null\nupstream: null\n')
    await local('apply', { request_id: 'plan', expected_revision: 0, command: {
      action: 'propose_plan', plan_id: 'plan', plan: {
        goal: 'Deliver an inspected document', completion_scope: 'task', remaining_scope: [], non_goals: [], scope: ['README.md'], risk: 'high',
        steps: [{ id: 'write', title: 'Document', scope: ['README.md'], depends_on: [], acceptance_ids: ['review'] }],
        acceptance: [{ id: 'review', description: 'An independent actor inspects this exact document',
          kind: 'review', independent: true, required: true }],
      },
    } })
    await local('apply', { request_id: 'confirm', expected_revision: state().revision, command: {
      action: 'confirm_plan', plan_id: 'plan', digest: state().plans[0]!.digest, confirmation: 'fixture:user-plan',
    } })
    await local('bind', { request_id: 'bind', expected_revision: state().revision,
      attempt_id: 'attempt', owner: 'builder', workspace })
    await local('yield', { request_id: 'yield', expected_revision: state().revision,
      actor: 'builder', observed_operations: [], note: 'Fixture editor stopped.' })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    release('start')
    release('publication')
    await finishWorkers()
    rmSync(home, { recursive: true, force: true })
  })

  it('reaps a real worker stalled outside all gates before fixture removal', async () => {
    const done = startWorker(input(), 'stalled', false, true)
    const worker = workers.at(-1)!
    let cleanup: Promise<void> | undefined
    try {
      release('start')
      await vi.waitFor(() => expect(existsSync(join(home, 'stalled-stalled.ready'))).toBe(true), { timeout: 10000 })
      let observedClose = false
      void done.then(() => { observedClose = true })
      let closedAtCleanupReturn: boolean | undefined
      cleanup = finishWorkers(100).then(() => { closedAtCleanupReturn = observedClose })
      await vi.waitFor(() => expect(closedAtCleanupReturn).toBe(true), { timeout: 1500, interval: 20 })
      expect((await done).code).not.toBe(0)
      expect(worker.child.killed).toBe(true)
    }
    finally {
      worker.child.kill('SIGKILL')
      await finishWorkers(100)
      await cleanup
    }
  }, 15_000)

  it('imports one exact report once when two processes overlap at immutable result publication', async () => {
    const request = input()
    const first = startWorker(request, 'first', true)
    const second = startWorker(request, 'second', true)
    await awaitBoth('start')
    release('start')
    await awaitBoth('publication')
    expect(state().operations).toHaveLength(1)
    expect(state().checks).toHaveLength(0)
    release('publication')
    for (const result of await Promise.all([first, second])) {
      expect(result.code, result.error + result.output).toBe(0)
      expect(JSON.parse(result.output).ok).toBe(true)
    }
    expect(state().operations).toHaveLength(1)
    expect(state().checks).toHaveLength(1)
    expect(state().revision).toBe(request.expected_revision + 2)
    const artifacts = new ExecutionArtifacts(directory, executionId)
    expect(artifacts.getReceipt(request.operation_id)?.digest).toBe(state().checks[0]!.receipt)
    expect(artifacts.getReceipt(request.operation_id, 'report-intent')?.value).toMatchObject({ summary: request.summary, observed_at: request.observed_at })
    expect((await local('inspect')).readiness).toMatchObject({ ready: true })
    const before = state()
    recordCheckReport(request)
    expect(state()).toEqual(before)
  }, 30000)

  it('keeps the winning observation when concurrent imports reuse an identity with conflicting outcomes', async () => {
    const passed = input()
    const failed = { ...passed, outcome: 'failed', summary: 'A conflicting observation must not overwrite the original.' }
    const first = startWorker(passed, 'first', false)
    const second = startWorker(failed, 'second', false)
    await awaitBoth('start')
    release('start')
    const results = await Promise.all([first, second])
    expect(results.map(result => result.code).sort()).toEqual([0, 1])
    const winner = results[0]!.code === 0 ? passed : failed
    const loser = results[0]!.code === 0 ? failed : passed
    // Publication can reject before the domain-specific conflict message; the
    // winner and immutable original below are the actual concurrency contract.
    expect(JSON.parse(results.find(result => result.code === 1)!.output)).toMatchObject({ ok: false })
    expect(state().operations).toHaveLength(1)
    expect(state().checks).toHaveLength(1)
    expect(state().checks[0]).toMatchObject({ outcome: winner.outcome, summary: winner.summary })
    const artifacts = new ExecutionArtifacts(directory, executionId)
    const { directory: _directory, ...original } = winner
    expect(artifacts.getReceipt(winner.operation_id, 'report-intent')?.value).toEqual(original)
    const before = state()
    expect(() => recordCheckReport(loser)).toThrow(/Conflicting report intent/)
    expect(state()).toEqual(before)
    expect((await local('inspect')).readiness).toMatchObject({ ready: winner.outcome === 'passed' })
  }, 30000)

  it('does not relabel a delayed observation of A as acceptance of B', async () => {
    const original = input()
    writeFileSync(join(workspace, 'README.md'), 'Unreviewed candidate B')
    await local('yield', { request_id: 'yield-b', expected_revision: state().revision,
      actor: 'builder', observed_operations: [], note: 'New candidate needs a new review.' })
    const before = state()
    expect(() => recordCheckReport({ ...original, expected_revision: before.revision })).toThrow()
    expect(state()).toEqual(before)
    expect((await local('inspect')).readiness).toMatchObject({ ready: false })
    expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe('Unreviewed candidate B')
  })

  it('recovers a report publication failure without leaving a permanent running reservation', async () => {
    const request = input()
    const put = ExecutionArtifacts.prototype.putReceipt
    const fault = vi.spyOn(ExecutionArtifacts.prototype, 'putReceipt').mockImplementation(function (this: ExecutionArtifacts, ...args) {
      if (args[2] === undefined || args[2] === 'result') throw new Error('fixture: interrupted result publication')
      return put.apply(this, args)
    })
    expect(() => recordCheckReport(request)).toThrow('fixture: interrupted result publication')
    expect(state().operations[0]!.status).toBe('running')
    expect(state().checks).toEqual([])
    fault.mockRestore()
    expect(() => recordCheckReport(request)).not.toThrow()
    expect(state().operations).toHaveLength(1)
    expect(state().checks).toHaveLength(1)
    expect((await local('inspect')).readiness).toMatchObject({ ready: true })
  })

  it.each(['plan_id', 'attempt_id', 'epoch', 'candidate'] as const)('refuses an observation with a different %s before reserving', field => {
    const original = input()
    const changed = field === 'epoch' ? original.epoch + 1
      : field === 'candidate' ? { ...original.candidate, digest: 'a'.repeat(64) } : 'another'
    const before = state()
    expect(() => recordCheckReport({ ...original, [field]: changed })).toThrow(/originally reviewed/)
    expect(state()).toEqual(before)
    expect(new ExecutionArtifacts(directory, executionId).getReceipt(original.operation_id, 'report-intent')).toBeUndefined()
  })

  it('rejects missing binding and the builder acting as its own independent reviewer', () => {
    const { candidate: _candidate, ...unbound } = input()
    const before = state()
    expect(() => recordCheckReport(unbound)).toThrow()
    expect(() => recordCheckReport({ ...input(), actor: 'builder' })).toThrow(/independent/i)
    expect(state()).toEqual(before)
  })

  it('does not reserve a check when publishing the original intent fails', () => {
    const before = state()
    const fault = vi.spyOn(ExecutionArtifacts.prototype, 'putReceipt').mockImplementation(() => {
      throw new Error('fixture: intent publication failed')
    })
    const request = input()
    expect(() => recordCheckReport(request)).toThrow('fixture: intent publication failed')
    expect(state()).toEqual(before)
    fault.mockRestore()
    recordCheckReport(request)
    expect(state().checks).toHaveLength(1)
  })

  it('cannot replace a failed observation with a pass during recovery', () => {
    const request = { ...input(), outcome: 'failed', summary: 'Reviewer found an incorrect statement.' }
    const put = ExecutionArtifacts.prototype.putReceipt
    const fault = vi.spyOn(ExecutionArtifacts.prototype, 'putReceipt').mockImplementation(function (this: ExecutionArtifacts, ...args) {
      if (args[2] === undefined || args[2] === 'result') throw new Error('fixture: no result yet')
      return put.apply(this, args)
    })
    expect(() => recordCheckReport(request)).toThrow('fixture: no result yet')
    fault.mockRestore()
    const before = state()
    expect(() => recordCheckReport({ ...request, outcome: 'passed' })).toThrow(/conflicting report intent/i)
    expect(state()).toEqual(before)
    recordCheckReport(request)
    expect(state().checks).toHaveLength(1)
    expect(state().checks[0]!.outcome).toBe('failed')
  })

  it('releases an interrupted import as stale when files changed, then requires a fresh review', async () => {
    const request = input()
    const put = ExecutionArtifacts.prototype.putReceipt
    const fault = vi.spyOn(ExecutionArtifacts.prototype, 'putReceipt').mockImplementation(function (this: ExecutionArtifacts, ...args) {
      if (args[2] === undefined || args[2] === 'result') throw new Error('fixture: no result yet')
      return put.apply(this, args)
    })
    expect(() => recordCheckReport(request)).toThrow('fixture: no result yet')
    fault.mockRestore()
    writeFileSync(join(workspace, 'README.md'), 'Unreviewed changes during interrupted import')
    recordCheckReport(request)
    expect(state().operations[0]!.status).toBe('completed')
    expect(state().checks[0]!.outcome).toBe('stale')
    expect(state().yield).toBeNull()
    expect((await local('inspect')).readiness).toMatchObject({ ready: false })
    await local('yield', { request_id: 'new-yield', expected_revision: state().revision,
      actor: 'builder', observed_operations: ['review'], note: 'Original importer completed without verifying these changes.' })
    recordCheckReport({ ...input('fresh-review'), locator: 'fixture:new-review-of-changed-document' })
    expect((await local('inspect')).readiness).toMatchObject({ ready: true })
    expect(state().checks.map(item => item.outcome)).toEqual(['stale', 'passed'])
  }, 15_000)

  it('reattaches a published report after state-save failure without republishing or accepting later drift', async () => {
    const request = input()
    const apply = TodoStore.prototype.applyWorkflow
    const fault = vi.spyOn(TodoStore.prototype, 'applyWorkflow').mockImplementation(function (this: TodoStore, ...args) {
      if ((args[2] as { command: { action: string } }).command.action === 'complete_check') {
        throw new Error('fixture: result state save failed')
      }
      return apply.apply(this, args)
    })
    expect(() => recordCheckReport(request)).toThrow('fixture: result state save failed')
    fault.mockRestore()
    const artifacts = new ExecutionArtifacts(directory, executionId)
    const originalReceipt = artifacts.getReceipt(request.operation_id)
    writeFileSync(join(workspace, 'README.md'), 'Changed after the review result was published')
    const writes = vi.spyOn(ExecutionArtifacts.prototype, 'putReceipt')
    recordCheckReport(request)
    recordCheckReport(request)
    expect(writes).not.toHaveBeenCalled()
    expect(artifacts.getReceipt(request.operation_id)).toEqual(originalReceipt)
    expect(state().checks).toHaveLength(1)
    expect((await local('inspect')).readiness).toMatchObject({ ready: false })
  })

  it('does not treat a later failed review of the same candidate as a pass', async () => {
    recordCheckReport(input())
    expect((await local('inspect')).readiness).toMatchObject({ ready: true })
    recordCheckReport({ ...input('later-review'), outcome: 'failed', summary: 'Fresh review identified an incorrect requirement.' })
    expect((await local('inspect')).readiness).toMatchObject({ ready: false })
    expect(state().checks.map(item => item.outcome)).toEqual(['passed', 'failed'])
  }, 15_000)

  it('refuses verified delivery after its original report intent is lost', async () => {
    recordCheckReport(input())
    const artifacts = new ExecutionArtifacts(directory, executionId)
    const intent = artifacts.getReceipt('review', 'report-intent')!
    rmSync(join(directory, 'executions', executionId, 'artifacts', `${intent.digest}.json`))
    expect((await local('inspect')).readiness).toMatchObject({ ready: false, gaps: ['artifact:review'] })
    await expect(local('close', { closure_id: 'lost-intent', expected_revision: state().revision,
      mode: 'verified', acknowledged_gaps: [], decision: 'fixture:user-close', note: 'Must refuse lost evidence',
      target: { kind: 'local' } })).rejects.toThrow()
    expect(store.listArchived()).toEqual([])
  })

  it('does not invent an original intent for a historical reservation without any report', () => {
    const request = input()
    const put = ExecutionArtifacts.prototype.putReceipt
    const fault = vi.spyOn(ExecutionArtifacts.prototype, 'putReceipt').mockImplementation(function (this: ExecutionArtifacts, ...args) {
      if (args[2] === undefined || args[2] === 'result') throw new Error('fixture: no result yet')
      return put.apply(this, args)
    })
    expect(() => recordCheckReport(request)).toThrow('fixture: no result yet')
    fault.mockRestore()
    const key = createHash('sha256').update('review').digest('hex')
    rmSync(join(directory, 'executions', executionId, 'receipts', `report-intent-${key}.json`))
    const before = state()
    expect(() => recordCheckReport(request)).toThrow(/no original intent/)
    expect(state()).toEqual(before)
    expect(state().checks).toEqual([])
  })

  it('reads a historical v1 report without manufacturing a new intent or rewriting it', async () => {
    recordCheckReport(input())
    const artifacts = new ExecutionArtifacts(directory, executionId)
    const original = artifacts.getReceipt('review')!.value as Record<string, unknown>
    const { intent: _intent, observed_at: _observed, ...legacy } = original
    legacy.version = 1
    const digest = artifacts.put(legacy)
    const key = createHash('sha256').update('review').digest('hex')
    const receipts = join(directory, 'executions', executionId, 'receipts')
    // Seed the previous on-disk format; this is fixture construction, not a migration API.
    writeFileSync(join(receipts, `${key}.json`), JSON.stringify({ version: 1, operation_id: 'review', artifact: digest }))
    rmSync(join(receipts, `report-intent-${key}.json`))
    const todos = store.list()
    const workflow = todos[0]!.executions[0]!.workflow!
    workflow.checks[0]!.receipt = digest
    workflow.operations[0]!.receipt = digest
    writeFileSync(join(directory, 'todos.yaml'), stringify({ todos }))
    const before = state()
    expect((await local('inspect')).readiness).toMatchObject({ ready: true })
    expect(state()).toEqual(before)
    expect(artifacts.getReceipt('review')!.value).toEqual(legacy)
    expect(artifacts.getReceipt('review', 'report-intent')).toBeUndefined()
  })

  it('does not let a delayed older pass erase a more recent failed observation', async () => {
    const olderPass = input('delayed-pass')
    await new Promise(resolve => setTimeout(resolve, 5))
    recordCheckReport({ ...input('newer-failure'), outcome: 'failed', summary: 'Later reviewer found incorrect text.' })
    const before = state()
    expect(() => recordCheckReport({ ...olderPass, expected_revision: state().revision })).toThrow()
    expect(state()).toEqual(before)
    expect((await local('inspect')).readiness).toMatchObject({ ready: false })
  }, 20_000)

  it('restores only the original result pointer after a completed report and subsequent file drift', async () => {
    const request = input()
    recordCheckReport(request)
    const artifacts = new ExecutionArtifacts(directory, executionId)
    const receipt = artifacts.getReceipt('review')
    const key = createHash('sha256').update('review').digest('hex')
    rmSync(join(directory, 'executions', executionId, 'receipts', `${key}.json`))
    writeFileSync(join(workspace, 'README.md'), 'A different candidate after completed review')
    const before = state()
    expect(() => recordCheckReport(request)).not.toThrow()
    expect(artifacts.getReceipt('review')).toEqual(receipt)
    expect(state()).toEqual(before)
    expect((await local('inspect')).readiness).toMatchObject({ ready: false })
  })

  it.each(['before-attempt', 'future'])('refuses a report observed %s without reserving', mode => {
    const before = state()
    const time = mode === 'before-attempt' ? Date.parse(before.attempts[0]!.started_at) - 1 : Date.now() + 60_000
    expect(() => recordCheckReport({ ...input(), observed_at: new Date(time).toISOString() })).toThrow(/observation/)
    expect(state()).toEqual(before)
  })

  it('keeps failure when a later import has the same observation time', async () => {
    const original = input()
    recordCheckReport({ ...original, outcome: 'failed', summary: 'One observation found a problem.' })
    const before = state()
    expect(() => recordCheckReport({
      ...input('tied-pass'), observed_at: original.observed_at,
    })).toThrow(/tied pass/)
    expect(state()).toEqual(before)
    expect((await local('inspect')).readiness).toMatchObject({ ready: false })
  })

  it('does not replace lost original result content with a new capture of changed files', () => {
    const request = input()
    recordCheckReport(request)
    const artifacts = new ExecutionArtifacts(directory, executionId)
    const receipt = artifacts.getReceipt('review')!
    const key = createHash('sha256').update('review').digest('hex')
    rmSync(join(directory, 'executions', executionId, 'receipts', `${key}.json`))
    rmSync(join(directory, 'executions', executionId, 'artifacts', `${receipt.digest}.json`))
    writeFileSync(join(workspace, 'README.md'), 'Unreviewed current files cannot replace the lost original')
    const before = state()
    expect(() => recordCheckReport(request)).toThrow()
    expect(artifacts.getReceipt('review')).toBeUndefined()
    expect(state()).toEqual(before)
  })
})
