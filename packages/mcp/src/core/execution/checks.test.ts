import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { TodoStore } from '../storage/todo-store.js'
import type { TodoItem } from '../storage/todo-store.js'
import { ExecutionArtifacts } from './artifacts.js'
import { captureCandidate } from './candidate.js'
import { runCheck, recoverCheck, observeCheck, executeReservedCheck } from './checks.js'
import type { CheckReceipt } from './checks.js'
import { launchCheckSupervisor } from './supervisor.js'
import { planDigest, workflowReadiness } from './workflow.js'
import type { WorkflowCommand, WorkflowPlanInput } from './contracts.js'
import * as processes from './processes.js'
import { verifyReadiness } from './verification.js'

function windowsPackageManager() {
  const wrappers = execFileSync('where.exe', ['pnpm.cmd'], {
    encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: 'pipe',
  }).trim().split(/\r?\n/)
  for (const wrapper of wrappers) {
    const entrypoint = join(dirname(wrapper), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    if (existsSync(entrypoint)) return { wrapper, entrypoint }
  }
  throw new Error('Windows package-manager tests require the installed pnpm Node entrypoint alongside its wrapper.')
}

describe('real local workflow checks', () => {
  let directory: string
  let repo: string
  let storage: string
  let store: TodoStore
  let todoId: string
  let executionId: string
  let serial: number
  let retainDirectory: boolean
  const state = () => store.get(0)!.executions[0]!.workflow!
  const send = (command: WorkflowCommand) => store.applyWorkflow(todoId, executionId, {
    request_id: `test-${++serial}`, expected_revision: state()?.revision ?? 0, command,
  })
  const reference = () => {
    const { digest, root, git_dir, common_dir } = captureCandidate(repo)
    return { digest, root, git_dir, common_dir }
  }
  const yieldNow = () => send({
    action: 'yield', actor: 'primary', candidate: reference(),
    observed_operations: state().operations.map(operation => operation.id), note: 'Fixture writer has stopped.',
  })
  const request = (id: string) => ({
    directory: storage, todo_id: todoId, execution_id: executionId, operation_id: id,
    request_id: `run-${id}`, acceptance_id: 'behavior', actor: 'local-runner', expected_revision: state().revision,
  })
  const setup = (script: string, timeout = 2000, argv = ['check.cjs'], dependencyInputs?: string[], executable = process.execPath) => {
    writeFileSync(join(repo, 'check.cjs'), script)
    const snapshot = reference()
    const plan: WorkflowPlanInput = {
      goal: 'Exercise an actual behavior', completion_scope: 'task', remaining_scope: [], non_goals: ['Network access'], scope: ['.'], risk: 'normal',
      steps: [{ id: 'code', title: 'Implement', scope: ['.'], depends_on: [], acceptance_ids: ['behavior'] }],
      acceptance: [{
        id: 'behavior', description: 'Fixture behavior holds', required: true, independent: false, kind: 'command',
        command: { executable, argv, timeout_ms: timeout, max_output_bytes: 4096,
          ...(dependencyInputs ? { dependency_inputs: dependencyInputs } : {}) },
      }],
    }
    send({ action: 'propose_plan', plan_id: 'plan', plan })
    send({ action: 'confirm_plan', plan_id: 'plan', digest: planDigest(plan), confirmation: 'fixture-user-turn' })
    send({
      action: 'start_attempt', attempt_id: 'attempt', owner: 'primary',
      workspace: {
        root: snapshot.root, git_dir: snapshot.git_dir, common_dir: snapshot.common_dir,
        baseline: snapshot.digest, repo: 'fixture/repo', machine: processes.localMachine(),
      },
    })
    yieldNow()
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'contribbot real-check-'))
    repo = join(directory, 'repo 空格 with spaces')
    storage = join(directory, 'data')
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=nonexistent-hooks', '-c', 'commit.gpgSign=false', ...args], {
      cwd: repo, windowsHide: true, stdio: 'pipe',
    })
    git('init', '--quiet', '--initial-branch=fixture')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(repo, 'source.txt'), 'initial')
    git('add', '.')
    git('commit', '--quiet', '-m', 'fixture')
    store = new TodoStore(storage)
    todoId = store.add({ ref: 'task', title: 'Actual task', type: 'feature' }).id!
    executionId = store.activateExecution(0).execution.id
    serial = 0
    retainDirectory = false
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    if (retainDirectory) console.warn(`Fixture shutdown unconfirmed; preserving ${directory}`)
    else rmSync(directory, { recursive: true, force: true })
  })

  it('does not dispatch a pending check replay after a durable pause request', async () => {
    const counter = join(directory, 'paused-counter')
    setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n')`)
    const input = request('paused-replay')
    await expect(runCheck(input, async () => { throw new Error('fixture stopped before supervisor launch') }))
      .rejects.toThrow(/fixture stopped/)
    const occupied = state().operations[0]
    send({ action: 'request_control', control_id: 'pause', kind: 'pause', decision: 'user:pause', note: 'Stop dispatch.' })
    const supervise = vi.fn(async () => {})
    await expect(runCheck(input, supervise)).rejects.toThrow(/control|pause/i)
    expect(supervise).not.toHaveBeenCalled()
    expect(state().operations[0]).toEqual(occupied)
    expect(existsSync(counter)).toBe(false)
    expect(observeCheck({ directory: storage, todo_id: todoId, execution_id: executionId,
      operation_id: input.operation_id }).initial_dispatch_retryable).toBe(false)
  }, 20_000)

  it('allows an already saved check result to recover while cancelling without re-execution', async () => {
    const counter = join(directory, 'cancel-result-counter')
    setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n')`)
    const input = request('cancel-result')
    const result = await runCheck(input)
    send({ action: 'request_control', control_id: 'cancel', kind: 'cancel', decision: 'user:cancel', note: 'Do not continue.' })
    const supervise = vi.fn(async () => {})
    expect(await runCheck(input, supervise)).toEqual(result)
    expect(supervise).not.toHaveBeenCalled()
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
    expect(state().closure).toBeNull()
  }, 20_000)

  it('does not start a command when pause arrives after supervisor claim but before spawn', async () => {
    const counter = join(directory, 'late-pause-counter')
    setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n')`)
    const publish = ExecutionArtifacts.prototype.put
    let requested = false
    vi.spyOn(ExecutionArtifacts.prototype, 'put').mockImplementation(function (this: ExecutionArtifacts, value) {
      const artifact = publish.call(this, value)
      if (!requested && value && typeof value === 'object' && 'files' in value) {
        requested = true
        send({ action: 'request_control', control_id: 'pause-late', kind: 'pause',
          decision: 'user:pause-late', note: 'Claimed but command not started.' })
      }
      return artifact
    })
    const result = await runCheck(request('late-pause'), executeReservedCheck)
    expect(requested).toBe(true)
    expect(result.outcome).toBe('blocked')
    expect(result.receipt.process).toBeNull()
    expect(result.receipt.error).toMatch(/control|pause/i)
    expect(existsSync(counter)).toBe(false)
    expect(state().operations[0]?.status).toBe('completed')
    expect(state().control?.active_id).toBe('pause-late')
  }, 20_000)

  it('runs failing code, reworks actual files, passes a fresh check, and invalidates on later changes', async () => {
    setup("const fs = require('node:fs'); console.log('Checking feature'); if (fs.readFileSync('source.txt','utf8') !== 'implemented') process.exit(1)")
    const failed = await runCheck(request('red'))
    expect(failed.outcome).toBe('failed')
    expect(failed.receipt.process?.exit_code).toBe(1)
    expect(failed.receipt.process?.stdout).toContain('Checking feature')
    expect(workflowReadiness(state(), reference()).ready).toBe(false)
    send({
      action: 'begin_operation', operation_id: 'implement', kind: 'write', actor: 'primary',
      delegated: false, step_id: 'code', scope: ['source.txt'], purpose: 'Implement feature',
    })
    writeFileSync(join(repo, 'source.txt'), 'implemented')
    send({ action: 'return_operation', operation_id: 'implement', process_stopped: true, receipt: 'fixture-write', note: 'Wrote source.' })
    send({ action: 'adopt_operation', operation_id: 'implement', actor: 'primary', decision: 'accepted', note: 'Checked the actual file.' })
    yieldNow()
    const passed = await runCheck(request('green'))
    expect(passed.outcome).toBe('passed')
    store = new TodoStore(storage)
    expect(workflowReadiness(state(), reference()).ready).toBe(true)
    writeFileSync(join(repo, 'new.txt'), 'uncommitted change')
    expect(workflowReadiness(state(), reference()).ready).toBe(false)
  }, 30_000)

  it('records the runner environment without claiming or exposing ambient configuration', async () => {
    vi.stubEnv('CONTRIBBOT_TEST_PRIVATE_VALUE', 'fixture-private-value-do-not-record')
    setup("require('node:assert/strict').equal(require('node:fs').readFileSync('source.txt', 'utf8'), 'initial')")
    const result = await runCheck(request('runner-environment'))
    expect(result.outcome).toBe('passed')
    expect(result.receipt).toMatchObject({
      version: 2,
      environment: {
        platform: process.platform, node: process.version, arch: process.arch,
        os_release: release(), runner_executable: process.execPath,
        dependency_inputs: { before: [], after: [] },
      },
    })
    const saved = new ExecutionArtifacts(storage, executionId).getReceipt('runner-environment')
    expect(saved?.value).toEqual(result.receipt)
    expect(JSON.stringify(saved)).not.toContain('fixture-private-value-do-not-record')
    expect(JSON.stringify(saved)).not.toContain('CONTRIBBOT_TEST_PRIVATE_VALUE')
  }, 15_000)

  it('binds declared dependency entry hashes to the actual checked manifests', async () => {
    const manifest = '{"name":"fixture","private":true}\n'
    const lock = 'lockfileVersion: 9\n'
    writeFileSync(join(repo, 'package.json'), manifest)
    writeFileSync(join(repo, 'pnpm-lock.yaml'), lock)
    setup("const assert = require('node:assert/strict'); assert.equal(require('./package.json').name, 'fixture'); assert.equal(require('node:fs').readFileSync('pnpm-lock.yaml','utf8'), 'lockfileVersion: 9\\n')",
      2000, ['check.cjs'], ['package.json', 'pnpm-lock.yaml'])
    const result = await runCheck(request('dependency-entrypoints'))
    expect(result.outcome).toBe('passed')
    const inputs = [
      { path: 'package.json', digest: createHash('sha256').update(manifest).digest('hex') },
      { path: 'pnpm-lock.yaml', digest: createHash('sha256').update(lock).digest('hex') },
    ]
    expect(result.receipt).toMatchObject({
      version: 2, environment: { dependency_inputs: { before: inputs, after: inputs } },
    })
    expect(workflowReadiness(state(), reference()).ready).toBe(true)
  }, 15_000)

  it.each(['missing', 'ignored', 'directory', 'deleted'])('refuses a %s dependency before reserving or running a command', async (kind) => {
    const counter = join(directory, 'dependency-command-count')
    const input = 'dependency.lock'
    if (kind === 'ignored') {
      writeFileSync(join(repo, '.gitignore'), `${input}\n`)
      writeFileSync(join(repo, input), 'ignored input')
    }
    if (kind === 'directory') mkdirSync(join(repo, input))
    if (kind === 'deleted') {
      writeFileSync(join(repo, input), 'tracked input')
      execFileSync('git', ['add', input], { cwd: repo, windowsHide: true, stdio: 'pipe' })
      rmSync(join(repo, input))
    }
    setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n')`, 2000, ['check.cjs'], [input])
    const before = state()
    await expect(runCheck(request('invalid-dependency'))).rejects.toThrow(/dependency\.lock.*missing or not covered/)
    expect(state()).toEqual(before)
    expect(existsSync(counter)).toBe(false)
    expect(new ExecutionArtifacts(storage, executionId).getReceipt('invalid-dependency', 'supervisor')).toBeUndefined()
  }, 15_000)

  it('retains original dependency evidence on replay instead of recapturing changed inputs', async () => {
    const counter = join(directory, 'dependency-replay-count')
    writeFileSync(join(repo, 'dependency.lock'), 'original')
    setup(`const fs = require('node:fs'); require('node:assert/strict').equal(fs.readFileSync('dependency.lock','utf8'),'original'); fs.appendFileSync(${JSON.stringify(counter)}, 'run\\n')`,
      2000, ['check.cjs'], ['dependency.lock'])
    const input = request('dependency-replay')
    const original = await runCheck(input)
    expect(original.outcome).toBe('passed')
    writeFileSync(join(repo, 'dependency.lock'), 'changed after check')
    expect(await runCheck(input)).toEqual(original)
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
    expect(verifyReadiness(storage, todoId, executionId, state(), reference()).ready).toBe(false)
  }, 20_000)

  it.each(['changed', 'removed'])('does not pass when a declared dependency is %s during the command', async (action) => {
    writeFileSync(join(repo, 'dependency.lock'), 'original')
    setup(action === 'changed'
      ? "require('node:fs').writeFileSync('dependency.lock', 'changed')"
      : "require('node:fs').unlinkSync('dependency.lock')",
    2000, ['check.cjs'], ['dependency.lock'])
    const result = await runCheck(request(`dependency-${action}`))
    expect(result.outcome).toBe('stale')
    expect(result.receipt).toMatchObject({
      environment: { dependency_inputs: {
        before: [{ path: 'dependency.lock', digest: createHash('sha256').update('original').digest('hex') }],
        after: [{ path: 'dependency.lock', digest: action === 'removed' ? null : createHash('sha256').update('changed').digest('hex') }],
      } },
    })
    expect(verifyReadiness(storage, todoId, executionId, state(), reference()).ready).toBe(false)
  }, 15_000)

  it('recovers a legacy receipt without inventing observations or comparing it to the current runner', async () => {
    const counter = join(directory, 'legacy-environment-count')
    setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n')`)
    const publish = ExecutionArtifacts.prototype.putReceipt
    const spy = vi.spyOn(ExecutionArtifacts.prototype, 'putReceipt').mockImplementation(function (this: ExecutionArtifacts, operation, value, namespace) {
      if (operation === 'legacy-environment' && (!namespace || namespace === 'result')) {
        const receipt = value as CheckReceipt
        return publish.call(this, operation, {
          ...receipt, version: 1, environment: { platform: 'historical-platform', node: 'historical-node' },
        }, namespace)
      }
      return publish.call(this, operation, value, namespace)
    })
    const input = request('legacy-environment')
    const result = await runCheck(input, executeReservedCheck)
    spy.mockRestore()
    const artifacts = new ExecutionArtifacts(storage, executionId)
    const original = artifacts.getReceipt('legacy-environment')
    expect(result).toMatchObject({ outcome: 'passed', receipt: {
      version: 1, environment: { platform: 'historical-platform', node: 'historical-node' },
    } })
    expect(result.limitations[0]).toContain('were not observed')
    expect(verifyReadiness(storage, todoId, executionId, state(), reference())).toMatchObject({
      ready: true, environment_limitations: [{ acceptance_id: 'behavior', receipt_version: 1 }],
    })
    expect(recoverCheck(input)).toEqual(result)
    expect(artifacts.getReceipt('legacy-environment')).toEqual(original)
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
  }, 20_000)

  it('refuses a v2 receipt whose declared dependency metadata contradicts its candidate', async () => {
    writeFileSync(join(repo, 'dependency.lock'), 'original')
    setup("require('node:assert/strict').equal(require('node:fs').readFileSync('dependency.lock', 'utf8'), 'original')",
      2000, ['check.cjs'], ['dependency.lock'])
    const publish = ExecutionArtifacts.prototype.putReceipt
    vi.spyOn(ExecutionArtifacts.prototype, 'putReceipt').mockImplementation(function (this: ExecutionArtifacts, operation, value, namespace) {
      if (operation === 'wrong-dependency' && (!namespace || namespace === 'result')) {
        const receipt = structuredClone(value) as Extract<CheckReceipt, { version: 2 }>
        receipt.environment.dependency_inputs.before![0]!.digest = 'f'.repeat(64)
        return publish.call(this, operation, receipt, namespace)
      }
      return publish.call(this, operation, value, namespace)
    })
    await expect(runCheck(request('wrong-dependency'), executeReservedCheck)).rejects.toThrow(/Dependency observation/)
    expect(verifyReadiness(storage, todoId, executionId, state(), reference()).ready).toBe(false)
    expect(state().checks).toHaveLength(0)
  }, 15_000)

  it.each(['before', 'after'] as const)('recovers a blocked result after %s-manifest publication throws without replaying the command', async (phase) => {
    const counter = join(directory, 'manifest-publication-count')
    writeFileSync(join(repo, 'dependency.lock'), 'original')
    setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n')`,
      2000, ['check.cjs'], ['dependency.lock'])
    const put = ExecutionArtifacts.prototype.put
    let manifests = 0
    let orphan: string | undefined
    const spy = vi.spyOn(ExecutionArtifacts.prototype, 'put').mockImplementation(function (this: ExecutionArtifacts, value) {
      const digest = put.call(this, value)
      if (value && typeof value === 'object' && 'files' in value) {
        manifests++
        if (manifests === (phase === 'before' ? 1 : 2)) {
          orphan = digest
          throw new Error('Injected failure after publishing the immutable manifest.')
        }
      }
      return digest
    })
    const input = request(`manifest-failure-${phase}`)
    const result = await runCheck(input, executeReservedCheck)
    spy.mockRestore()
    expect(result.outcome).toBe('blocked')
    expect(result.receipt.error).toContain('Injected failure')
    expect(result.receipt[phase]).toBeNull()
    expect(result.receipt[phase === 'before' ? 'before_artifact' : 'after_artifact']).toBeNull()
    expect(result.receipt).toMatchObject({ environment: { dependency_inputs: { [phase]: null } } })
    expect(new ExecutionArtifacts(storage, executionId).get(orphan!)).toHaveProperty('files')
    expect(phase === 'before' ? existsSync(counter) : readFileSync(counter, 'utf8')).toBe(phase === 'before' ? false : 'run\n')
    expect(await runCheck(input)).toEqual(result)
    expect(phase === 'before' ? existsSync(counter) : readFileSync(counter, 'utf8')).toBe(phase === 'before' ? false : 'run\n')
    expect(state().operations.at(-1)?.status).toBe('completed')
    expect(verifyReadiness(storage, todoId, executionId, state(), reference()).ready).toBe(false)
  }, 20_000)

  it.runIf(process.platform === 'win32')('runs the real package manager through an explicit Node entrypoint in a spaced Unicode workspace', async () => {
    const { entrypoint } = windowsPackageManager()
    const counter = join(directory, 'package-manager-count')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'execution-fixture', private: true, scripts: { verify: 'node check.cjs' } }))
    writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    setup(`const fs = require('node:fs'); const assert = require('node:assert/strict'); assert.equal(require('./package.json').name, 'execution-fixture'); assert.equal(fs.readFileSync('pnpm-lock.yaml','utf8'), 'lockfileVersion: 9\\n'); fs.appendFileSync(${JSON.stringify(counter)}, 'run\\n')`,
      10000, [entrypoint, 'run', 'verify'], ['package.json', 'pnpm-lock.yaml'])
    const result = await runCheck(request('explicit-pnpm'))
    expect(result.outcome).toBe('passed')
    expect(result.receipt.command.executable).toBe(process.execPath)
    expect(result.receipt.command.argv).toEqual([entrypoint, 'run', 'verify'])
    expect(result.receipt.process?.exit_code).toBe(0)
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
    expect(verifyReadiness(storage, todoId, executionId, state(), reference()).ready).toBe(true)
  }, 30_000)

  it.runIf(process.platform === 'win32')('does not silently add a shell when given a Windows package-manager batch wrapper', async () => {
    const { wrapper } = windowsPackageManager()
    const counter = join(directory, 'implicit-shell-must-not-run')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ private: true, scripts: { verify: 'node check.cjs' } }))
    setup(`require('node:fs').writeFileSync(${JSON.stringify(counter)}, 'unexpected')`, 2000, ['run', 'verify'], ['package.json'], wrapper)
    const result = await runCheck(request('direct-cmd'))
    expect(result.outcome).toBe('blocked')
    expect(result.receipt.error).toMatch(/spawn.*EINVAL/)
    expect(result.receipt.process).toBeNull()
    expect(existsSync(counter)).toBe(false)
    expect(verifyReadiness(storage, todoId, executionId, state(), reference()).ready).toBe(false)
  }, 15_000)

  it.runIf(process.platform === 'win32')('times out the real package-manager child tree without granting a retry', async () => {
    const { entrypoint } = windowsPackageManager()
    const started = join(directory, 'package-script-started.json')
    const counter = join(directory, 'package-timeout-count')
    const late = join(directory, 'package-script-late-effect')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ private: true, scripts: { verify: 'node check.cjs' } }))
    setup(`const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid })); fs.appendFileSync(${JSON.stringify(counter)}, 'run\\n'); setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, 'too late'), 6000)`,
      3000, [entrypoint, 'run', 'verify'], ['package.json'])
    const input = request('pnpm-timeout')
    const running = runCheck(input)
    void running.catch(() => {})
    let handle: ReturnType<typeof processes.describeProcess> | undefined
    try {
      await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10000, interval: 20 })
      const child = JSON.parse(readFileSync(started, 'utf8')) as { pid: number }
      handle = processes.describeProcess(child.pid)
      const result = await running
      expect(result.receipt.process?.timed_out).toBe(true)
      expect(result.outcome).toBe('blocked')
      await vi.waitFor(() => expect(['stopped', 'replaced']).toContain(processes.observeProcess(handle!).state), { timeout: 10000, interval: 100 })
      expect(existsSync(late)).toBe(false)
      expect(readFileSync(counter, 'utf8')).toBe('run\n')
      expect(state().operations.at(-1)?.status).toBe('unknown')
      await expect(runCheck(request('pnpm-second'))).rejects.toThrow(/unknown|unresolved|yield/i)
      expect(await runCheck(input)).toEqual(result)
      expect(readFileSync(counter, 'utf8')).toBe('run\n')
    }
    finally {
      await running.catch(() => undefined)
      if (!handle && existsSync(started)) handle = processes.describeProcess(JSON.parse(readFileSync(started, 'utf8')).pid)
      if (handle) {
        try {
          await vi.waitFor(() => expect(['stopped', 'replaced']).toContain(processes.observeProcess(handle!).state), { timeout: 10000, interval: 100 })
        }
        catch (error) { retainDirectory = true; throw error }
      }
    }
  }, 30_000)

  it('recovers a durable command receipt after state-save failure without running the command again', async () => {
    const counter = join(directory, 'counter')
    setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n'); console.log('finished')`)
    const realApply = TodoStore.prototype.applyWorkflow
    const spy = vi.spyOn(TodoStore.prototype, 'applyWorkflow').mockImplementation(function (this: TodoStore, ...args) {
      const req = args[2] as { command?: { action: string } }
      if (req.command?.action === 'complete_check') throw new Error('injected status save failure')
      return realApply.apply(this, args)
    })
    const input = request('recoverable')
    await expect(runCheck(input)).rejects.toThrow(/injected status save failure/)
    spy.mockRestore()
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
    expect(state().operations.at(-1)?.status).toBe('running')
    const recovered = recoverCheck(input)
    expect(recovered.outcome).toBe('passed')
    expect((await runCheck(input)).outcome).toBe('passed')
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
  }, 20_000)

  it('persists the real helper identity with the running operation before executing the command', async () => {
    const observedFile = join(directory, 'command-observed.yaml')
    setup(`const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(observedFile)}, fs.readFileSync(${JSON.stringify(join(storage, 'todos.yaml'))}))`)
    await runCheck(request('observable'))
    const observed = parse(readFileSync(observedFile, 'utf8')) as { todos: TodoItem[] }
    expect(observed.todos.find(todo => todo.id === todoId)?.executions[0]?.workflow?.operations.at(-1)).toMatchObject({
      id: 'observable', status: 'running',
      runner: { pid: process.pid, started_at: expect.any(Number), machine: { platform: process.platform } },
    })
  }, 15_000)

  it('keeps timeout occupancy unknown and rejects an automatic retry', async () => {
    setup('setInterval(() => {}, 100)', 150)
    const input = request('timeout')
    const result = await runCheck(input)
    expect(result.outcome).toBe('blocked')
    expect(result.receipt.process?.timed_out).toBe(true)
    expect(state().operations.at(-1)?.status).toBe('unknown')
    await expect(runCheck(request('second'))).rejects.toThrow(/unknown|unresolved|yield/i)
    expect((await runCheck(input)).outcome).toBe('blocked')
    expect(workflowReadiness(state(), reference()).ready).toBe(false)
  }, 20_000)

  it('enforces the command timeout even when OS process identity lookup is slow', async () => {
    const lateEffect = join(directory, 'must-be-stopped-before-this-write')
    setup(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(lateEffect)}, 'late'), 700); setInterval(() => {}, 100)`, 150)
    const describe = processes.describeProcess
    vi.spyOn(processes, 'describeProcess').mockImplementation((pid) => {
      if (pid !== process.pid) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
      return describe(pid)
    })
    vi.spyOn(processes, 'describeProcessAsync').mockImplementation(async (pid) => {
      await new Promise(resolve => setTimeout(resolve, 1500))
      return { pid, machine: processes.localMachine(), started_at: null, observed_at: new Date().toISOString() }
    })
    const result = await runCheck(request('slow-identity'), executeReservedCheck)
    expect(result.receipt.process?.timed_out).toBe(true)
    expect(result.outcome).toBe('blocked')
    expect(existsSync(lateEffect)).toBe(false)
  }, 15_000)

  it('enforces the command timeout while process-record publication is slow', async () => {
    const lateEffect = join(directory, 'must-not-write-during-storage-stall')
    setup(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(lateEffect)}, 'late'), 700); setInterval(() => {}, 100)`, 150)
    vi.spyOn(processes, 'describeProcessAsync').mockImplementation(async (pid) => ({
      pid, machine: processes.localMachine(), started_at: null, observed_at: new Date().toISOString(),
    }))
    const describe = processes.describeProcess
    vi.spyOn(processes, 'describeProcess').mockImplementation((pid) => pid === process.pid ? describe(pid) : {
      pid, machine: processes.localMachine(), started_at: null, observed_at: new Date().toISOString(),
    })
    const syncPublish = ExecutionArtifacts.prototype.putReceipt
    vi.spyOn(ExecutionArtifacts.prototype, 'putReceipt').mockImplementation(function (this: ExecutionArtifacts, ...args) {
      if (args[2] === 'process') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
      return syncPublish.apply(this, args)
    })
    const asyncPublish = ExecutionArtifacts.prototype.putReceiptAsync
    vi.spyOn(ExecutionArtifacts.prototype, 'putReceiptAsync').mockImplementation(async function (this: ExecutionArtifacts, ...args) {
      if (args[2] === 'process') await new Promise(resolve => setTimeout(resolve, 1500))
      return asyncPublish.apply(this, args)
    })
    const result = await runCheck(request('slow-storage'), executeReservedCheck)
    expect(result.receipt.process?.timed_out).toBe(true)
    expect(existsSync(lateEffect)).toBe(false)
    expect(result.outcome).toBe('blocked')
  }, 15_000)

  it('does not identify a replacement PID as the command after the original child exited', async () => {
    setup("console.log('command finished')")
    vi.spyOn(processes, 'describeProcessAsync').mockImplementation(async (pid) => {
      await new Promise(resolve => setTimeout(resolve, 500))
      return { pid, machine: processes.localMachine(), started_at: Date.now() + 10_000, observed_at: new Date().toISOString() }
    })
    const result = await runCheck(request('reused-pid'), executeReservedCheck)
    expect(result.receipt.process?.exit_code).toBe(0)
    const recorded = new ExecutionArtifacts(storage, executionId).getReceipt('reused-pid', 'process')!.value as {
      child: ReturnType<typeof processes.describeProcess>
    }
    expect(recorded.child.started_at).toBeNull()
  }, 15_000)

  it('waits for process tracking and does not publish success when tracking fails after command exit', async () => {
    const executed = join(directory, 'executed-once')
    setup(`require('node:fs').appendFileSync(${JSON.stringify(executed)}, 'run\\n')`)
    vi.spyOn(processes, 'describeProcessAsync').mockImplementation(async (pid) => {
      await new Promise(resolve => setTimeout(resolve, 500))
      return { pid, machine: processes.localMachine(), started_at: null, observed_at: new Date().toISOString() }
    })
    const putReceipt = ExecutionArtifacts.prototype.putReceipt
    const publications: string[] = []
    vi.spyOn(ExecutionArtifacts.prototype, 'putReceiptAsync').mockImplementation(async () => {
      publications.push('process')
      throw new Error('fixture tracking publication failed')
    })
    vi.spyOn(ExecutionArtifacts.prototype, 'putReceipt').mockImplementation(function (this: ExecutionArtifacts, ...args) {
      publications.push(args[2] ?? 'result')
      return putReceipt.apply(this, args)
    })
    const result = await runCheck(request('tracking-failure'), executeReservedCheck)
    expect(readFileSync(executed, 'utf8')).toBe('run\n')
    expect(publications).toEqual(['supervisor', 'process', 'result'])
    expect(result.receipt.process?.exit_code).toBe(0)
    expect(result.receipt.process?.error).toMatch(/tracking publication failed/)
    expect(result.receipt.process?.process_stopped).toBe(false)
    expect(result.outcome).toBe('blocked')
    expect(state().operations.at(-1)?.status).toBe('unknown')
    expect(workflowReadiness(state(), reference()).ready).toBe(false)
  }, 15_000)

  it.each(['supervisor-crash', 'abort-before-handles'] as const)('cleans owned processes after %s without replaying a live command', async mode => {
    const stopFile = join(directory, 'stop-fixture-command')
    const invocations = join(directory, 'invocations')
    const commandPidFile = join(directory, 'command-pid')
    const descendantPidFile = join(directory, 'descendant-pid')
    const releaseDescendant = join(directory, 'release-descendant')
    const descendantScript = `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid));
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(stopFile)}) &&
          ${mode === 'abort-before-handles' ? `fs.existsSync(${JSON.stringify(releaseDescendant)})` : 'true'}) {
          clearInterval(timer);
          process.exit(0);
        }
      }, 50);
      setTimeout(() => process.exit(2), 30000);
    `
    setup(`
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(commandPidFile)}, String(process.pid));
      fs.appendFileSync(${JSON.stringify(invocations)}, 'run\\n');
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}],
        { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
      setInterval(() => { if (fs.existsSync(${JSON.stringify(stopFile)})) process.exit(0) }, 50);
      setTimeout(() => process.exit(2), 30000);
    `, 30_000)
    const input = request('crashed-helper')
    const observationInput = {
      directory: storage, todo_id: todoId, execution_id: executionId, operation_id: input.operation_id,
    }
    const inputFile = join(directory, 'request.json')
    writeFileSync(inputFile, JSON.stringify(input))
    const artifacts = new ExecutionArtifacts(storage, executionId)
    const loader = new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href
    const fixture = fileURLToPath(new URL('./__fixtures__/check-worker.ts', import.meta.url))
    retainDirectory = true
    const helper = spawn(process.execPath, ['--import', loader, fixture, inputFile], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let helperOutput = '', helperError = ''
    helper.stdout.on('data', data => { helperOutput = (helperOutput + String(data)).slice(-8192) })
    helper.stderr.on('data', data => { helperError = (helperError + String(data)).slice(-8192) })
    let helperClosed = false
    const terminal = new Promise<void>((resolve, reject) => {
      helper.on('close', () => { helperClosed = true; resolve() })
      helper.on('error', reject)
    })
    let commandHandle: ReturnType<typeof processes.describeProcess> | undefined
    let descendantHandle: ReturnType<typeof processes.describeProcess> | undefined
    let supervisorHandle: ReturnType<typeof processes.describeProcess> | undefined
    const earlyExit = new Error('fixture: failure before the success-path handles were assigned')
    let observedEarlyExit = false
    let cleanupObservedLiveDescendant = false
    try {
      if (mode === 'abort-before-handles') {
        await vi.waitFor(() => {
          expect(artifacts.getReceipt(input.operation_id, 'supervisor')).toBeDefined()
          expect(existsSync(descendantPidFile)).toBe(true)
        }, { timeout: 12_000, interval: 50 })
        throw earlyExit
      }
      await vi.waitFor(() => {
        const result = artifacts.getReceipt(input.operation_id)
        const receipt = result?.value as { error?: unknown; process?: { error?: unknown } } | undefined
        const operation = state().operations.find(item => item.id === input.operation_id)
        const diagnostic = JSON.stringify({ exit_code: helper.exitCode, signal: helper.signalCode,
          stdout: helperOutput, stderr: helperError, dispatch: operation?.dispatch,
          supervisor: artifacts.getReceipt(input.operation_id, 'supervisor')?.digest,
          result: result?.digest, error: receipt?.error, process_error: receipt?.process?.error,
          invoked: existsSync(invocations), descendant_recorded: existsSync(descendantPidFile) })
        expect(artifacts.getReceipt(input.operation_id, 'process'), diagnostic).toBeDefined()
        expect(existsSync(descendantPidFile)).toBe(true)
      }, { timeout: 12_000, interval: 50 })
      commandHandle = (artifacts.getReceipt(input.operation_id, 'process')!.value as { child: NonNullable<typeof commandHandle> }).child
      descendantHandle = processes.describeProcess(Number(readFileSync(descendantPidFile, 'utf8')))
      const live = observeCheck(observationInput)
      supervisorHandle = live.supervisor!.handle
      expect(live.runner?.handle.pid).toBe(helper.pid)
      expect(live.runner?.observation.state).toBe('running')
      expect(live.supervisor?.observation.state).toBe('running')
      expect(live.command?.observation.state).toBe('running')
      expect(live.result_receipt).toBeNull()
      expect(readFileSync(invocations, 'utf8')).toBe('run\n')
      helper.kill('SIGKILL')
      await terminal
      expect(processes.observeProcess(supervisorHandle).state).toBe('running')
      process.kill(supervisorHandle.pid, 'SIGKILL')
      await vi.waitFor(() => expect(processes.observeProcess(supervisorHandle!).state).toBe('stopped'),
        { timeout: 5000, interval: 50 })

      const beforeObservation = state()
      const orphan = observeCheck(observationInput)
      expect(orphan.runner?.observation.state).toBe('stopped')
      expect(orphan.supervisor?.observation.state).toBe('stopped')
      // Windows can reap the direct command with its supervisor; a detached descendant still survives.
      expect(['running', 'stopped']).toContain(orphan.command?.observation.state)
      expect(processes.observeProcess(descendantHandle).state).toBe('running')
      expect(orphan.automatic_release).toBe(false)
      expect(state()).toEqual(beforeObservation)
      expect(() => recoverCheck(input)).toThrow(/no durable receipt.*unknown/i)
      await expect(runCheck(input)).rejects.toThrow(/no durable receipt.*unknown/i)
      await expect(runCheck(request('duplicate'))).rejects.toThrow(/unresolved|running|yield/i)
      expect(() => send({
        action: 'begin_operation', operation_id: 'second-writer', kind: 'write', actor: 'primary',
        delegated: false, step_id: 'code', scope: ['source.txt'], purpose: 'Must not write over a live command',
      })).toThrow(/unresolved|running|check/i)
      expect(readFileSync(invocations, 'utf8')).toBe('run\n')
      expect(workflowReadiness(state(), reference()).ready).toBe(false)

      writeFileSync(stopFile, 'stop')
      await vi.waitFor(() => {
        expect(processes.observeProcess(commandHandle!).state).toBe('stopped')
        expect(processes.observeProcess(descendantHandle!).state).toBe('stopped')
      }, { timeout: 5000, interval: 50 })
      const stopped = observeCheck(observationInput)
      expect(stopped.command?.observation.state).toBe('stopped')
      expect(stopped.automatic_release).toBe(false)
      expect(state().checks).toHaveLength(0)
      expect(() => recoverCheck(input)).toThrow(/no durable receipt.*unknown/i)
    }
    catch (error) {
      if (error !== earlyExit) throw error
      observedEarlyExit = true
    }
    finally {
      writeFileSync(stopFile, 'stop')
      // A live requester awaits its supervisor; killing it here would discard that shutdown signal.
      await vi.waitFor(() => expect(helperClosed, helperError + helperOutput).toBe(true),
        { timeout: 8000, interval: 50 })
      await terminal
      await vi.waitFor(() => {
        const observed = observeCheck(observationInput)
        supervisorHandle ??= observed.supervisor?.handle
        commandHandle ??= observed.command?.handle
        if (!commandHandle && existsSync(commandPidFile)) commandHandle = processes.describeProcess(Number(readFileSync(commandPidFile, 'utf8')))
        if (!descendantHandle && existsSync(descendantPidFile)) descendantHandle = processes.describeProcess(Number(readFileSync(descendantPidFile, 'utf8')))
        if (helper.signalCode !== null) expect(supervisorHandle, 'Killed requester cannot account for a missing supervisor.').toBeDefined()
        if (existsSync(invocations)) {
          expect(commandHandle).toBeDefined()
          expect(descendantHandle).toBeDefined()
        }
        if (commandHandle) expect(processes.observeProcess(commandHandle).state).toBe('stopped')
        if (descendantHandle) {
          const observation = processes.observeProcess(descendantHandle)
          if (mode === 'abort-before-handles' && !cleanupObservedLiveDescendant) {
            expect(observation.state).toBe('running')
            cleanupObservedLiveDescendant = true
            writeFileSync(releaseDescendant, 'cleanup observed the live descendant')
          }
          expect(observation.state).toBe('stopped')
        }
        if (supervisorHandle) expect(processes.observeProcess(supervisorHandle).state).toBe('stopped')
      }, { timeout: 5000, interval: 50 })
      retainDirectory = false
    }
    if (mode === 'abort-before-handles') {
      expect(observedEarlyExit).toBe(true)
      const observedBeforeCleanupReturned = cleanupObservedLiveDescendant
      // Rescue also stops the fixture if the cleanup-under-test skipped its live descendant.
      writeFileSync(releaseDescendant, 'rescue cleanup')
      const descendant = processes.describeProcess(Number(readFileSync(descendantPidFile, 'utf8')))
      const original = observeCheck(observationInput)
      await vi.waitFor(() => {
        expect(processes.observeProcess(descendant).state).toBe('stopped')
        expect(processes.observeProcess(original.supervisor!.handle).state).toBe('stopped')
        if (original.command) expect(processes.observeProcess(original.command.handle).state).toBe('stopped')
      }, { timeout: 8000, interval: 50 })
      expect(observedBeforeCleanupReturned).toBe(true)
    }
  }, 30_000)

  it('recovers the actual result after the requesting helper crashes without executing the command again', async () => {
    const startedFile = join(directory, 'started.json')
    const continueFile = join(directory, 'continue-command')
    const doneFile = join(directory, 'finished-command')
    const counter = join(directory, 'once')
    setup(`
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(counter)}, 'run\\n');
      fs.writeFileSync(${JSON.stringify(startedFile)}, JSON.stringify({ pid: process.pid, parent: process.ppid }));
      setInterval(() => {
        if (fs.existsSync(${JSON.stringify(continueFile)})) {
          fs.writeFileSync(${JSON.stringify(doneFile)}, 'actual-result');
          process.exit(0);
        }
      }, 50);
      setTimeout(() => process.exit(2), 20000);
    `, 20_000)
    const input = request('survives-requester')
    const inputFile = join(directory, 'request.json')
    writeFileSync(inputFile, JSON.stringify(input))
    const artifacts = new ExecutionArtifacts(storage, executionId)
    const loader = new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url).href
    const fixture = fileURLToPath(new URL('./__fixtures__/check-worker.ts', import.meta.url))
    const helper = spawn(process.execPath, ['--import', loader, fixture, inputFile], { windowsHide: true, stdio: 'ignore' })
    const terminal = new Promise<void>((resolve, reject) => {
      helper.on('close', () => resolve())
      helper.on('error', reject)
    })
    let commandHandle: ReturnType<typeof processes.describeProcess> | undefined
    let supervisorHandle: ReturnType<typeof processes.describeProcess> | undefined
    try {
      await vi.waitFor(() => expect(existsSync(startedFile)).toBe(true), { timeout: 12_000, interval: 50 })
      const started = JSON.parse(readFileSync(startedFile, 'utf8')) as { pid: number; parent: number }
      commandHandle = processes.describeProcess(started.pid)
      supervisorHandle = processes.describeProcess(started.parent)
      expect(processes.observeProcess(commandHandle).state).toBe('running')
      await expect(launchCheckSupervisor(input)).rejects.toThrow(/supervisor exited/i)
      expect(readFileSync(counter, 'utf8')).toBe('run\n')
      helper.kill('SIGKILL')
      await terminal
      expect(() => send({
        action: 'begin_operation', operation_id: 'premature-writer', kind: 'write', actor: 'primary',
        delegated: false, step_id: 'code', scope: ['source.txt'], purpose: 'Must await the original command',
      })).toThrow(/unresolved/i)
      writeFileSync(continueFile, 'continue')
      await vi.waitFor(() => expect(artifacts.getReceipt(input.operation_id)).toBeDefined(), { timeout: 8000, interval: 50 })
      expect(readFileSync(doneFile, 'utf8')).toBe('actual-result')
      expect(state().checks).toHaveLength(0)
      const result = recoverCheck(input)
      expect(result.outcome).toBe('passed')
      expect((await runCheck(input)).artifact).toBe(result.artifact)
      expect(readFileSync(counter, 'utf8')).toBe('run\n')
      expect(state().checks).toHaveLength(1)
    }
    finally {
      writeFileSync(continueFile, 'continue')
      if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL')
      await terminal
      for (const handle of [commandHandle, supervisorHandle]) {
        if (handle) await vi.waitFor(() => expect(processes.observeProcess(handle).state).toBe('stopped'), { timeout: 8000, interval: 50 })
      }
    }
  }, 35_000)

  it('does not re-execute a claimed operation when all receipt pointers are lost', async () => {
    const counter = join(directory, 'must-remain-once')
    setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n')`)
    const input = request('lost-pointers')
    await expect(runCheck(input, async (reserved) => {
      await executeReservedCheck(reserved)
      throw new Error('fixture requester failed before reconciliation')
    })).rejects.toThrow(/fixture requester/)
    expect(state().operations.at(-1)?.status).toBe('running')
    const key = createHash('sha256').update(input.operation_id).digest('hex')
    for (const prefix of ['', 'process-', 'supervisor-']) {
      rmSync(join(storage, 'executions', executionId, 'receipts', `${prefix}${key}.json`))
    }
    await expect(executeReservedCheck(input)).rejects.toThrow(/supervisor|claimed/i)
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
    expect(state().checks).toHaveLength(0)
  }, 20_000)

  it('retries initial dispatch after launch failure without reserving or executing twice', async () => {
    const counter = join(directory, 'only-after-launch')
    setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n')`)
    const input = request('dispatch-retry')
    await expect(runCheck(input, async () => {
      throw new Error('fixture failed before spawning supervisor')
    })).rejects.toThrow(/before spawning/)
    expect(existsSync(counter)).toBe(false)
    expect(state().operations).toHaveLength(1)
    expect(observeCheck({
      directory: storage, todo_id: todoId, execution_id: executionId, operation_id: input.operation_id,
    }).initial_dispatch_retryable).toBe(true)
    expect((await runCheck(input)).outcome).toBe('passed')
    expect((await runCheck(input)).outcome).toBe('passed')
    expect(state().operations).toHaveLength(1)
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
  }, 20_000)

  it('does not dispatch an unclaimed operation after its liveness is explicitly marked unknown', async () => {
    const counter = join(directory, 'must-not-dispatch')
    setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n')`)
    const input = request('unknown-before-claim')
    await expect(runCheck(input, async () => { throw new Error('fixture launch failed') })).rejects.toThrow(/launch failed/)
    send({ action: 'mark_unknown', operation_id: input.operation_id, reason: 'External host state cannot be established.' })
    expect(observeCheck({
      directory: storage, todo_id: todoId, execution_id: executionId, operation_id: input.operation_id,
    }).initial_dispatch_retryable).toBe(false)
    await expect(runCheck(input)).rejects.toThrow(/no durable receipt.*unknown/i)
    expect(existsSync(counter)).toBe(false)
  }, 15_000)

  it('rejects a wrong-machine supervisor without leaving a claim that blocks valid dispatch', async () => {
    const counter = join(directory, 'only-on-correct-machine')
    setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n')`)
    const input = request('machine-retry')
    await expect(runCheck(input, async (reserved) => {
      const describe = processes.describeProcess
      const spy = vi.spyOn(processes, 'describeProcess').mockImplementation((pid) => {
        const identity = describe(pid)
        return { ...identity, machine: { ...identity.machine, hostname: `${identity.machine.hostname}-other` } }
      })
      try { await executeReservedCheck(reserved) }
      finally { spy.mockRestore() }
    })).rejects.toThrow(/machine/i)
    expect(existsSync(counter)).toBe(false)
    expect(new ExecutionArtifacts(storage, executionId).getReceipt(input.operation_id, 'supervisor')).toBeUndefined()
    expect(state().operations.at(-1)?.supervisor).toBeNull()
    expect((await runCheck(input)).outcome).toBe('passed')
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
  }, 20_000)

  it('does not start commands when files changed after yield', async () => {
    const counter = join(directory, 'never-started')
    setup(`require('node:fs').writeFileSync(${JSON.stringify(counter)}, 'started')`)
    writeFileSync(join(repo, 'source.txt'), 'changed before check')
    const result = await runCheck(request('drift'))
    expect(result.outcome).toBe('blocked')
    expect(result.receipt.process).toBeNull()
    expect(() => readFileSync(counter)).toThrow()
    expect(workflowReadiness(state(), reference()).ready).toBe(false)
  }, 15_000)

  it('records drift during command execution as stale instead of passing', async () => {
    setup("require('node:fs').writeFileSync('source.txt', 'changed during test')")
    const result = await runCheck(request('mutating'))
    expect(result.receipt.process?.exit_code).toBe(0)
    expect(result.outcome).toBe('stale')
    expect(state().checks.at(-1)?.outcome).toBe('stale')
    expect(state().yield).toBeNull()
  }, 15_000)

  it('passes literal argv without shell expansion and redacts common secrets from output', async () => {
    const literal = 'spaces & echo injected; $HOME "quote"'
    setup("console.log(process.argv[2]); console.error('Authorization: Bearer fixture-token')", 2000, ['check.cjs', literal])
    const result = await runCheck(request('argv'))
    expect(result.outcome).toBe('passed')
    expect(result.receipt.process?.stdout.trim()).toBe(literal)
    expect(result.receipt.process?.stderr).toContain('[REDACTED]')
    expect(JSON.stringify(result.receipt)).not.toContain('fixture-token')
  }, 15_000)

  it('bounds excessive output and keeps interrupted process occupancy unknown', async () => {
    setup("console.log('x'.repeat(32_000)); setInterval(() => {}, 100)")
    const result = await runCheck(request('bounded'))
    expect(result.outcome).toBe('blocked')
    expect(result.receipt.process?.output_limited).toBe(true)
    expect(Buffer.byteLength(result.receipt.process!.stdout + result.receipt.process!.stderr)).toBeLessThanOrEqual(4096)
    expect(state().operations.at(-1)?.status).toBe('unknown')
  }, 15_000)

  it('does not replay a reserved operation whose durable receipt is missing', async () => {
    const counter = join(directory, 'must-not-execute')
    setup(`require('node:fs').writeFileSync(${JSON.stringify(counter)}, 'started')`)
    const input = request('interrupted')
    store.applyWorkflow(todoId, executionId, {
      request_id: input.request_id, expected_revision: input.expected_revision,
      command: {
        action: 'begin_check', operation_id: input.operation_id, acceptance_id: input.acceptance_id,
        actor: input.actor, candidate: state().yield!.candidate,
      },
    })
    await expect(runCheck(input)).rejects.toThrow(/no durable receipt.*unknown/i)
    expect(() => readFileSync(counter)).toThrow()
    expect(state().operations).toHaveLength(1)
  }, 15_000)

  it('refuses direct supervision of a legacy command that already ran without a receipt', async () => {
    const counter = join(directory, 'legacy-command-runs')
    setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n')`)
    const input = request('legacy-direct')
    store.applyWorkflow(todoId, executionId, {
      request_id: input.request_id, expected_revision: input.expected_revision,
      command: {
        action: 'begin_check', operation_id: input.operation_id, acceptance_id: input.acceptance_id,
        actor: input.actor, candidate: state().yield!.candidate, runner: processes.describeProcess(process.pid),
      },
    })
    execFileSync(process.execPath, ['check.cjs'], { cwd: repo, windowsHide: true, stdio: 'pipe' })
    await expect(executeReservedCheck(input)).rejects.toThrow(/supervisor|dispatch|legacy/i)
    await expect(runCheck(input)).rejects.toThrow(/no durable receipt.*unknown/i)
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
    expect(new ExecutionArtifacts(storage, executionId).getReceipt(input.operation_id, 'supervisor')).toBeUndefined()
  }, 15_000)

  it('executes only once when two actual helper processes receive the same request', async () => {
    const counter = join(directory, 'one-invocation')
    setup(`require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n'); setTimeout(() => {}, 200)`)
    const inputFile = join(directory, 'request.json')
    writeFileSync(inputFile, JSON.stringify(request('shared-operation')))
    const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url))
    const fixture = fileURLToPath(new URL('./__fixtures__/check-worker.ts', import.meta.url))
    const invoke = () => new Promise<{ code: number | null; output: string; error: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [tsx, fixture, inputFile], { windowsHide: true })
      let output = ''
      let error = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { error += chunk })
      child.on('error', reject)
      child.on('close', code => resolve({ code, output, error }))
    })
    const results = await Promise.all([invoke(), invoke()])
    expect(results.some(result => result.code === 0), JSON.stringify(results)).toBe(true)
    for (const result of results) {
      expect(result.error).toBe('')
      if (result.code !== 0) expect(JSON.parse(result.output).error).toMatch(/no durable receipt.*unknown|supervisor exited.*observe/i)
    }
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
    expect(state().operations).toHaveLength(1)
    expect(state().checks).toHaveLength(1)
  }, 25_000)
})
