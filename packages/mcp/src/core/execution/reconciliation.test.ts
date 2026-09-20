import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoStore } from '../storage/todo-store.js'
import { ExecutionArtifacts } from './artifacts.js'
import { observeCheck, recoverCheck, runCheck } from './checks.js'
import { runLocalCommand } from './local.js'
import { describeProcess, observeProcess } from './processes.js'
import type { ProcessHandle, WorkflowRequest } from './contracts.js'
import { captureCandidate } from './candidate.js'
import * as processes from './processes.js'

describe('explicit interrupted-command reconciliation', () => {
  let home: string
  let workspace: string
  let dataRoot: string
  let directory: string
  let store: TodoStore
  let todoId: string
  let executionId: string
  const state = () => store.list()[0]!.executions[0]!.workflow!
  const identity = () => ({ todo_id: todoId, execution_id: executionId })
  const local = (action: string, payload: Record<string, unknown> = {}) => runLocalCommand({
    action, repo: 'fixture/repo', data_root: dataRoot, ...identity(), ...payload,
  })
  const checkRequest = (id: string) => ({
    directory, ...identity(), request_id: id, operation_id: id, acceptance_id: 'behavior',
    actor: 'runner', expected_revision: state().revision,
  })
  const report = (operationId: string, descendants: ProcessHandle[] = []) => {
    const observation = observeCheck({ directory, ...identity(), operation_id: operationId })
    return {
      source: 'host_report', actor: 'fixture-controller', locator: 'fixture:owned-process-observations',
      operation_id: operationId, attempt_id: 'attempt', observed_at: new Date().toISOString(),
      raw: JSON.stringify({ observation, descendants: descendants.map(handle => ({ handle, observation: observeProcess(handle) })) }),
      coverage_basis: 'Fixture owns the executed script and all descendants; each created process is listed and observed.',
      reviewed_candidate: captureCandidate(workspace).digest,
      descendants: descendants.map(handle => ({ handle, locator: 'fixture:spawned-descendant' })),
      accounted_missing: [
        ...(!observation.runner ? ['runner'] : []),
        ...(!observation.supervisor ? ['supervisor'] : []),
        ...(!observation.command ? ['command'] : []),
      ],
      unresolved: [] as string[],
    }
  }
  const reconcile = (operationId: string, descendants: ProcessHandle[] = []) => ({
    ...identity(), request_id: `reconcile-${operationId}`, operation_id: operationId,
    expected_revision: state().revision, actor: 'primary',
    decision: 'fixture:user-approved-interruption-reconciliation', report: report(operationId, descendants),
  })
  const yieldNow = () => local('yield', {
    request_id: `yield-${state().revision}`, expected_revision: state().revision, actor: 'primary',
    observed_operations: state().operations.map(operation => operation.id), note: 'Fixture accounted for all operations.',
  })
  async function setup(script: string, timeout = 2000) {
    writeFileSync(join(workspace, 'check.cjs'), script)
    await local('apply', {
      request_id: 'p', expected_revision: 0, command: {
        action: 'propose_plan', plan_id: 'p', plan: {
          goal: 'Recover without inventing a passed check', completion_scope: 'task', remaining_scope: [], non_goals: ['Network'], scope: ['.'], risk: 'normal',
          steps: [{ id: 's', title: 'Implement', scope: ['.'], depends_on: [], acceptance_ids: ['behavior'] }],
          acceptance: [{
            id: 'behavior', description: 'Verify the actual arithmetic', kind: 'command', required: true, independent: false,
            command: { executable: process.execPath, argv: ['check.cjs'], timeout_ms: timeout, max_output_bytes: 4096 },
          }],
        },
      },
    })
    await local('apply', { request_id: 'c', expected_revision: state().revision, command: {
      action: 'confirm_plan', plan_id: 'p', digest: state().plans[0]!.digest, confirmation: 'fixture:user-confirmation',
    } })
    await local('bind', { request_id: 'b', expected_revision: state().revision, attempt_id: 'attempt', owner: 'primary', workspace })
    await yieldNow()
  }
  async function unknownReservation(operationId = 'legacy', runner?: ProcessHandle) {
    if (!state()) await setup("require('node:assert/strict').equal(require('./sum.cjs')(2,3),5)")
    store.applyWorkflow(todoId, executionId, {
      request_id: `reserve-${operationId}`, expected_revision: state().revision,
      command: { action: 'begin_check', operation_id: operationId, acceptance_id: 'behavior',
        actor: 'runner', candidate: state().yield!.candidate, ...(runner ? { runner } : {}) },
    })
    await local('apply', { request_id: `lost-${operationId}`, expected_revision: state().revision,
      command: { action: 'mark_unknown', operation_id: operationId, reason: 'Fixture injects a historical missing-process-metadata state.' } })
  }
  function failStatePublication() {
    const apply = TodoStore.prototype.applyWorkflow
    return vi.spyOn(TodoStore.prototype, 'applyWorkflow').mockImplementation(function (this: TodoStore, ...args) {
      if ((args[2] as WorkflowRequest).command.action === 'reconcile_check') throw new Error('fixture: state publication failed')
      return apply.apply(this, args)
    })
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-reconciliation-'))
    workspace = join(home, 'workspace')
    dataRoot = join(home, 'data')
    directory = join(dataRoot, 'fixture', 'repo')
    mkdirSync(workspace)
    const git = (...args: string[]) => execFileSync('git', [
      '-c', 'core.hooksPath=nonexistent-hooks', '-c', 'commit.gpgSign=false', ...args,
    ], { cwd: workspace, windowsHide: true, stdio: 'pipe' })
    git('init', '--quiet', '--initial-branch=fixture')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git')
    writeFileSync(join(workspace, 'sum.cjs'), 'module.exports = (a, b) => a + b\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'fixture')
    store = new TodoStore(directory)
    todoId = store.add({ ref: 'task', title: 'Recovery', type: 'bug' }).id!
    executionId = store.activateExecution(0).execution.id
    writeFileSync(join(directory, 'config.yaml'), 'fork: null\nupstream: null\n')
  })
  afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }) })

  it('settles an interrupted check without rewriting its result or rerunning it, then requires a fresh check', async () => {
    const counter = join(home, 'runs')
    const wait = join(home, 'wait')
    writeFileSync(wait, 'wait')
    await setup(`const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(counter)},'run\\n');
      require('node:assert/strict').equal(require('./sum.cjs')(2,3),5);
      if(fs.existsSync(${JSON.stringify(wait)})) setInterval(()=>{},100);`, 300)
    const original = checkRequest('interrupted')
    const failed = await runCheck(original)
    expect(failed.outcome).toBe('blocked')
    const before = state()
    expect(before.operations[0]!.status).toBe('unknown')
    const request = reconcile('interrupted')
    const result = await local('reconcile', request)
    expect(result).toMatchObject({ schema_version: 1, operation_id: 'interrupted', verification: 'not_verified' })
    expect(state().operations[0]!.status).toBe('reconciled')
    expect(state().checks).toEqual(before.checks)
    expect(state().epoch).toBe(before.epoch + 1)
    expect(state().yield).toBeNull()
    const artifacts = new ExecutionArtifacts(directory, executionId)
    expect(artifacts.getReceipt('interrupted')!.digest).toBe(failed.artifact)
    const settled = state()
    expect(await local('reconcile', request)).toMatchObject({ verification: 'not_verified' })
    expect(state()).toEqual(settled)
    await expect(runCheck(original)).rejects.toThrow()
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
    await yieldNow()
    expect((await local('inspect')).readiness).toMatchObject({ ready: false, missing: ['behavior'] })
    rmSync(wait)
    expect((await runCheck(checkRequest('fresh'))).outcome).toBe('passed')
    expect((await local('inspect')).readiness).toMatchObject({ ready: true })
    expect(readFileSync(counter, 'utf8')).toBe('run\nrun\n')
  }, 30_000)

  it.each([
    'wrong owner', 'wrong operation', 'wrong attempt', 'stale report', 'future report',
    'wrong candidate', 'unresolved processes', 'missing accounting',
  ])('leaves the original occupancy intact for %s', async invalid => {
    await unknownReservation()
    const request = reconcile('legacy')
    if (invalid === 'wrong owner') request.actor = 'unrelated'
    if (invalid === 'wrong operation') request.report.operation_id = 'unrelated'
    if (invalid === 'wrong attempt') request.report.attempt_id = 'unrelated'
    if (invalid === 'stale report') request.report.observed_at = new Date(Date.parse(state().operations[0]!.started_at) - 1).toISOString()
    if (invalid === 'future report') request.report.observed_at = new Date(Date.now() + 60_000).toISOString()
    if (invalid === 'wrong candidate') request.report.reviewed_candidate = '0'.repeat(64)
    if (invalid === 'unresolved processes') request.report.unresolved = ['Detached descendants not accounted for']
    if (invalid === 'missing accounting') request.report.accounted_missing = []
    const before = state()
    await expect(local('reconcile', request)).rejects.toThrow()
    expect(state()).toEqual(before)
    await expect(yieldNow()).rejects.toThrow()
    expect(new ExecutionArtifacts(directory, executionId).getReceipt(JSON.stringify(['legacy', 'reconcile-legacy']), 'reconciliation')).toBeUndefined()
  }, 15_000)

  it('rejects a reported descendant from another machine instead of assuming that its PID is absent locally', async () => {
    await unknownReservation()
    const handle = describeProcess(process.pid)
    handle.machine.hostname = 'not-the-current-fixture-machine'
    const before = state()
    await expect(local('reconcile', reconcile('legacy', [handle]))).rejects.toThrow(/unknown/)
    expect(state()).toEqual(before)
  }, 15_000)

  it('does not release a legacy executor that is still alive merely because it lacks supervisor metadata', async () => {
    const ready = join(home, 'legacy-ready')
    const stop = join(home, 'legacy-stop')
    const write = join(home, 'legacy-write')
    const legacy = spawn(process.execPath, ['-e', `
      const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');
      setInterval(()=>{
        if(fs.existsSync(${JSON.stringify(write)}))fs.writeFileSync(${JSON.stringify(join(workspace, 'late.txt'))},'legacy mutation');
        if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0);
      },30);setTimeout(()=>process.exit(2),30000);
    `], { windowsHide: true, stdio: 'ignore' })
    const terminal = new Promise<void>((resolve, reject) => { legacy.on('close', () => resolve()); legacy.on('error', reject) })
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5000 })
      const handle = describeProcess(legacy.pid!)
      await unknownReservation('legacy', handle)
      const before = state()
      await expect(local('reconcile', reconcile('legacy'))).rejects.toThrow(/legacy runner is running/i)
      expect(state()).toEqual(before)
      await expect(yieldNow()).rejects.toThrow()
      writeFileSync(write, 'produce a real delayed write')
      await vi.waitFor(() => expect(readFileSync(join(workspace, 'late.txt'), 'utf8')).toBe('legacy mutation'), { timeout: 5000 })
      writeFileSync(stop, 'stop')
      await terminal
      const request = reconcile('legacy')
      await local('reconcile', { ...request, report: {
        ...request.report, changes_review: 'fixture: observed the delayed legacy write and stopped the original process',
      } })
      expect(state().checks).toEqual([])
    }
    finally { writeFileSync(stop, 'stop'); await terminal }
  }, 30_000)

  it('does not confuse two different operation and request tuples containing colons', async () => {
    await unknownReservation('check:1')
    const first = await local('reconcile', { ...reconcile('check:1'), request_id: 'cleanup' })
    await yieldNow()
    await unknownReservation('check')
    const second = await local('reconcile', { ...reconcile('check'), request_id: '1:cleanup' })
    expect(first.reconciliation_receipt).not.toBe(second.reconciliation_receipt)
    expect(state().operations.map(operation => operation.status)).toEqual(['reconciled', 'reconciled'])
    expect(state().checks).toEqual([])
  }, 20_000)

  it('requires actual current content to match the reviewed report and records explicitly reviewed edits as unverified', async () => {
    await unknownReservation()
    const stale = reconcile('legacy')
    writeFileSync(join(workspace, 'sum.cjs'), 'module.exports = (a,b) => a - b\n')
    const before = state()
    await expect(local('reconcile', stale)).rejects.toThrow(/reviewed current candidate/)
    await expect(local('reconcile', reconcile('legacy'))).rejects.toThrow(/review changed/)
    expect(state()).toEqual(before)
    const request = reconcile('legacy')
    const result = await local('reconcile', { ...request, report: {
      ...request.report, changes_review: 'fixture: inspected sum.cjs; subtraction is incorrect and requires repair',
    } })
    const record = new ExecutionArtifacts(directory, executionId).get(result.reconciliation_receipt as string)
    expect(record).toMatchObject({ changed_since_check: true, machine: processes.localMachine() })
    expect(state().checks).toEqual([])
    await yieldNow()
    expect((await runCheck(checkRequest('actual-failure'))).outcome).toBe('failed')
    expect((await local('inspect')).readiness).toMatchObject({ ready: false })
  }, 25_000)

  it('does not release occupancy when real files change between reconciliation publication and state application', async () => {
    await unknownReservation()
    const publish = ExecutionArtifacts.prototype.putReceipt
    vi.spyOn(ExecutionArtifacts.prototype, 'putReceipt').mockImplementation(function (this: ExecutionArtifacts, ...args) {
      const receipt = publish.apply(this, args)
      if (args[2] === 'reconciliation') writeFileSync(join(workspace, 'unreviewed.txt'), 'Not in the reviewed candidate')
      return receipt
    })
    const before = state()
    await expect(local('reconcile', reconcile('legacy'))).rejects.toThrow(/changed|candidate/)
    expect(state()).toEqual(before)
  }, 15_000)

  it('re-observes liveness after a publication crash and retries without replacing evidence or executing another command', async () => {
    await setup('setInterval(()=>{},100)', 300)
    await runCheck(checkRequest('timeout'))
    const request = reconcile('timeout')
    const before = state()
    const failure = failStatePublication()
    await expect(local('reconcile', request)).rejects.toThrow('fixture: state publication failed')
    failure.mockRestore()
    expect(state()).toEqual(before)
    const artifacts = new ExecutionArtifacts(directory, executionId)
    const published = artifacts.getReceipt(JSON.stringify(['timeout', 'reconcile-timeout']), 'reconciliation')!
    expect(published).toBeDefined()
    const observation = vi.spyOn(processes, 'observeProcess').mockReturnValue({
      state: 'unknown', observed_at: new Date().toISOString(), reason: 'Fixture injects unavailable OS process information on retry.',
    })
    await expect(local('reconcile', request)).rejects.toThrow(/unknown/)
    expect(observation).toHaveBeenCalled()
    expect(state()).toEqual(before)
    observation.mockRestore()
    await local('reconcile', request)
    expect(artifacts.getReceipt(JSON.stringify(['timeout', 'reconcile-timeout']), 'reconciliation')).toEqual(published)
    expect(state().checks).toEqual(before.checks)
  }, 25_000)

  it('refuses a pending published request after later edits and permits only a newly reviewed request', async () => {
    await unknownReservation()
    const request = reconcile('legacy')
    const failure = failStatePublication()
    await expect(local('reconcile', request)).rejects.toThrow('fixture: state publication failed')
    failure.mockRestore()
    const before = state()
    writeFileSync(join(workspace, 'notes.txt'), 'Inspected after the crash')
    await expect(local('reconcile', request)).rejects.toThrow(/reviewed current candidate/)
    expect(state()).toEqual(before)
    const fresh = reconcile('legacy')
    await local('reconcile', { ...fresh, request_id: 'new-review', report: {
      ...fresh.report, changes_review: 'fixture: inspected the added notes.txt after the publication failure',
    } })
    expect(state().operations[0]!.status).toBe('reconciled')
    expect(state().checks).toEqual([])
  }, 20_000)

  it('uses an available terminal result instead of discarding it and rejects its recovery after another attempt starts', async () => {
    const counter = join(home, 'runs')
    await setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)},'run\\n');
      require('node:assert/strict').equal(require('./sum.cjs')(2,3),5)`)
    const original = checkRequest('complete')
    const apply = TodoStore.prototype.applyWorkflow
    const crash = vi.spyOn(TodoStore.prototype, 'applyWorkflow').mockImplementation(function (this: TodoStore, ...args) {
      if ((args[2] as WorkflowRequest).command.action === 'complete_check') throw new Error('fixture: result state crash')
      return apply.apply(this, args)
    })
    await expect(runCheck(original)).rejects.toThrow('fixture: result state crash')
    crash.mockRestore()
    const before = state()
    await expect(local('reconcile', reconcile('complete'))).rejects.toThrow(/normal terminal result/)
    expect(state()).toEqual(before)
    expect(recoverCheck(original).outcome).toBe('passed')
    await local('bind', { request_id: 'new-attempt', expected_revision: state().revision,
      attempt_id: 'next-attempt', owner: 'primary', workspace })
    const next = state()
    expect(() => recoverCheck(original)).toThrow(/current check identity/)
    expect(state()).toEqual(next)
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
    expect((await local('inspect')).readiness).toMatchObject({ ready: false, missing: ['behavior'] })
  }, 25_000)

  it('does not adopt a late original result or replay its command after explicit reconciliation', async () => {
    await unknownReservation()
    await local('reconcile', reconcile('legacy'))
    await yieldNow()
    const fresh = await runCheck(checkRequest('fresh'))
    expect(fresh.outcome).toBe('passed')
    const artifacts = new ExecutionArtifacts(directory, executionId)
    artifacts.putReceipt('legacy', { ...fresh.receipt, operation_id: 'legacy' })
    const before = state()
    expect(() => recoverCheck(checkRequest('legacy'))).toThrow(/reconciled/)
    await expect(runCheck(checkRequest('legacy'))).rejects.toThrow()
    expect(state()).toEqual(before)
    expect(state().checks).toHaveLength(1)
    expect(state().checks[0]!.operation_id).toBe('fresh')
    expect((await local('inspect')).readiness).toMatchObject({ ready: true })
  }, 25_000)

  it.each(['receipt', 'manifest'] as const)('refuses verified delivery after a reconciliation %s is lost, even with a fresh passed check', async missing => {
    await unknownReservation()
    const result = await local('reconcile', reconcile('legacy'))
    await yieldNow()
    expect((await runCheck(checkRequest('fresh'))).outcome).toBe('passed')
    expect((await local('inspect')).readiness).toMatchObject({ ready: true })
    const receipt = result.reconciliation_receipt as string
    const artifacts = new ExecutionArtifacts(directory, executionId)
    const record = artifacts.get(receipt) as { manifest: string }
    const path = join(directory, 'executions', executionId, 'artifacts', `${missing === 'receipt' ? receipt : record.manifest}.json`)
    const original = readFileSync(path)
    rmSync(path)
    const inspection = await local('inspect')
    expect(inspection.readiness).toMatchObject({ ready: false, gaps: expect.arrayContaining(['reconciliation:legacy']) })
    await expect(local('close', {
      closure_id: 'finish', expected_revision: state().revision, mode: 'verified', acknowledged_gaps: [],
      decision: 'fixture:user-close', note: 'Do not bypass missing reconciliation evidence', target: { kind: 'local' },
    })).rejects.toThrow()
    expect(store.listArchived()).toEqual([])
    writeFileSync(path, original)
    expect((await local('inspect')).readiness).toMatchObject({ ready: true })
  }, 25_000)

  it('refuses release while an actual detached descendant is alive and recovers a lost-result crash only after it stops', async () => {
    const stop = join(home, 'stop')
    const stopCommand = join(home, 'stop-command')
    const childPid = join(home, 'descendant.pid')
    const counter = join(home, 'runs')
    const childScript = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(childPid)},String(process.pid));
      setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0)},50);setTimeout(()=>process.exit(2),30000);`
    await setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)},'run\\n');
      require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],
        {detached:true,windowsHide:true,stdio:'ignore'}).unref();
      setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(stopCommand)}))process.exit(0)},50);`, 30_000)
    const original = checkRequest('crashed')
    const input = join(home, 'request.json')
    writeFileSync(input, JSON.stringify(original))
    const loader = new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href
    const fixture = fileURLToPath(new URL('./__fixtures__/check-worker.ts', import.meta.url))
    const requester = spawn(process.execPath, ['--import', loader, fixture, input], { windowsHide: true, stdio: 'ignore' })
    const terminal = new Promise<void>((resolve, reject) => { requester.on('close', () => resolve()); requester.on('error', reject) })
    const artifacts = new ExecutionArtifacts(directory, executionId)
    let supervisor: ProcessHandle | undefined
    let command: ProcessHandle | undefined
    let descendant: ProcessHandle | undefined
    try {
      await vi.waitFor(() => {
        expect(existsSync(childPid)).toBe(true)
        expect(artifacts.getReceipt('crashed', 'process')).toBeDefined()
      }, { timeout: 12_000, interval: 50 })
      descendant = describeProcess(Number(readFileSync(childPid, 'utf8')))
      const observation = observeCheck({ directory, ...identity(), operation_id: 'crashed' })
      supervisor = observation.supervisor!.handle
      command = observation.command!.handle
      requester.kill('SIGKILL')
      await terminal
      expect(observeProcess(supervisor).state).toBe('running')
      const running = state()
      await expect(local('reconcile', reconcile('crashed', [descendant]))).rejects.toThrow(/Original supervisor is running/)
      expect(state()).toEqual(running)
      process.kill(supervisor.pid, 'SIGKILL')
      await vi.waitFor(() => expect(observeProcess(supervisor!).state).toBe('stopped'), { timeout: 5000 })
      writeFileSync(stopCommand, 'stop')
      await vi.waitFor(() => expect(observeProcess(command!).state).toBe('stopped'), { timeout: 5000 })
      expect(observeProcess(descendant).state).toBe('running')
      const before = state()
      await expect(local('reconcile', reconcile('crashed', [descendant]))).rejects.toThrow(/Reported descendant .* is running/)
      expect(state()).toEqual(before)
      expect(artifacts.getReceipt('crashed')).toBeUndefined()
      writeFileSync(stop, 'stop')
      await vi.waitFor(() => {
        expect(observeProcess(command!).state).toBe('stopped')
        expect(observeProcess(descendant!).state).toBe('stopped')
      }, { timeout: 5000 })
      await local('reconcile', reconcile('crashed', [descendant]))
      expect(state().operations[0]!.status).toBe('reconciled')
      expect(state().checks).toEqual([])
      expect(readFileSync(counter, 'utf8')).toBe('run\n')
      await local('apply', { request_id: 'new-write', expected_revision: state().revision, command: {
        action: 'begin_operation', operation_id: 'writer', actor: 'primary', kind: 'write', delegated: false,
        step_id: 's', scope: ['.'], purpose: 'Continue after accounted interruption',
      } })
      expect(state().operations.at(-1)!.id).toBe('writer')
    }
    finally {
      writeFileSync(stopCommand, 'stop')
      writeFileSync(stop, 'stop')
      if (requester.exitCode === null && requester.signalCode === null) requester.kill('SIGKILL')
      await terminal
      for (const handle of [supervisor, command, descendant]) {
        if (handle) await vi.waitFor(() => expect(observeProcess(handle).state).toBe('stopped'), { timeout: 8000 })
      }
    }
  }, 45_000)
})
