import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoStore } from '../storage/todo-store.js'
import { ExecutionArtifacts } from './artifacts.js'
import { runLocalCommand } from './local.js'
import type { WorkflowPlanInput } from './contracts.js'
import { fixtureProjectDirectory, saveFixtureProjectConfig } from './__fixtures__/repository.js'

describe('isolated delegated candidate integration', () => {
  let home: string
  let main: string
  let child: string
  let dataRoot: string
  let store: TodoStore
  let todoId: string
  let executionId: string
  let serial: number
  const storagePath = () => fixtureProjectDirectory(dataRoot, 'fixture/repo')
  const state = () => store.resolveItemById(todoId)!.item.executions[0]!.workflow!
  const call = (action: string, input: Record<string, unknown> = {}) => runLocalCommand({
    action, repo: { platform: 'github', instance: 'https://github.com', path: 'fixture/repo' },
    data_root: dataRoot, todo_id: todoId, execution_id: executionId,
    ...input,
  })
  const mutate = (action: string, input: Record<string, unknown> = {}) => call(action, {
    request_id: `request-${++serial}`, expected_revision: state()?.revision ?? 0, actor: 'primary', ...input,
  })
  const host = { provider: 'codex-subagent', task_id: 'fixture-child-1' }
  const plan: WorkflowPlanInput = {
    goal: 'Sum returns the actual arithmetic sum', completion_scope: 'task', remaining_scope: [], non_goals: ['Publish or modify Git metadata'],
    scope: ['src'], risk: 'normal',
    steps: [{ id: 'fix', title: 'Fix sum', scope: ['src'], depends_on: [], acceptance_ids: ['sum'] }],
    acceptance: [{
      id: 'sum', description: 'Invoke the integrated function and verify nonempty and empty input',
      kind: 'command', required: true, independent: false,
      command: {
        executable: process.execPath,
        argv: ['-e', "const a=require('node:assert/strict'),sum=require('./src/sum.cjs');a.equal(sum([2,3]),5);a.equal(sum([]),0)"],
        timeout_ms: 2000, max_output_bytes: 4096,
      },
    }],
  }
  const prepare = () => mutate('delegate-prepare', {
    operation_id: 'delegate', step_id: 'fix', scope: ['src'], purpose: 'Repair sum in an isolated checkout',
    workspace: child, token: 'fixture-launch-token', provider: host.provider,
    tool: 'multi_agent_v1.spawn_agent', brief: 'Repair sum.cjs only. Do not spawn descendants or modify Git metadata.',
  })
  it('does not return another launch brief on replay after a stop request', async () => {
    const original = {
      request_id: 'original-prepare', expected_revision: state().revision, actor: 'primary',
      operation_id: 'delegate', step_id: 'fix', scope: ['src'], purpose: 'Repair sum in an isolated checkout',
      workspace: child, token: 'fixture-launch-token', provider: host.provider,
      tool: 'multi_agent_v1.spawn_agent', brief: 'Repair sum.cjs only.',
    }
    await call('delegate-prepare', original)
    const operation = structuredClone(state().operations[0])
    await call('apply', { request_id: 'pause', expected_revision: state().revision, command: {
      action: 'request_control', control_id: 'pause', kind: 'pause', decision: 'fixture:user-pause', note: 'Do not launch.'
    } })
    await expect(call('delegate-prepare', original)).rejects.toThrow(/control|pause/i)
    expect(state().operations[0]).toEqual(operation)
    await attach()
    expect(state().operations[0]?.delegation?.host).toEqual(host)
  }, 20_000)
  const attach = () => mutate('delegate-attach', {
    operation_id: 'delegate', handle: host, locator: 'fixture:spawn-result',
    raw: { agent_id: host.task_id },
  })
  const observe = (status = 'terminal', pending: string[] = [], observedAt = new Date().toISOString()) => mutate('delegate-observe', {
    operation_id: 'delegate', handle: host, tool: 'multi_agent_v1.wait_agent',
    locator: 'fixture:wait-result', observed_at: observedAt, status,
    raw: { status: { [host.task_id]: { completed: 'Fixture changes are ready for review.' } } },
    quiescence: {
      statement: 'Fixture writer has stopped; no descendant was launched.',
      locator: 'fixture:descendant-audit', descendants: [], unaccounted: pending,
    },
  })
  const collect = () => mutate('delegate-collect', { operation_id: 'delegate' })
  const review = (result: unknown) => mutate('delegate-review', {
    operation_id: 'delegate', result, locator: 'fixture:owner-diff-review',
    note: 'Reviewed exact source diff, scope and target baseline.',
  })
  const finish = (decision = 'accepted') => mutate('delegate-finish', {
    operation_id: 'delegate', decision, note: 'Owner reconciled the real target and source files.',
  })
  const repair = () => writeFileSync(join(child, 'src', 'sum.cjs'),
    'module.exports = values => values.reduce((sum, value) => sum + value, 0)\n')
  const returned = async () => {
    await prepare()
    await attach()
    repair()
    await observe()
    return collect()
  }
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=nonexistent-hooks', '-c', 'commit.gpgSign=false', ...args,
  ], { cwd: main, windowsHide: true, stdio: 'pipe' })

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-delegation-'))
    main = join(home, 'main')
    child = join(home, 'child')
    dataRoot = join(home, 'data')
    mkdirSync(join(main, 'src'), { recursive: true })
    git('init', '--quiet', '--initial-branch=fixture')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'core.autocrlf', 'false')
    git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git')
    writeFileSync(join(main, 'src', 'sum.cjs'), 'module.exports = values => values.reduce((sum, value) => sum + value, 1)\n')
    writeFileSync(join(main, 'notes.txt'), 'Initial user document\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'Isolated fixture')
    git('worktree', 'add', '--quiet', '--detach', child, 'HEAD')
    writeFileSync(join(main, 'notes.txt'), 'Existing uncommitted user document\n')
    copyFileSync(join(main, 'notes.txt'), join(child, 'notes.txt'))
    saveFixtureProjectConfig(storagePath(), 'fixture/repo')
    store = new TodoStore(storagePath())
    todoId = store.add({ ref: 'delegation', title: 'Delegated sum fix', type: 'bug' }).id!
    executionId = store.activateExecution(0).execution.id
    serial = 0
    await call('apply', {
      request_id: 'plan', expected_revision: 0, command: { action: 'propose_plan', plan_id: 'plan', plan },
    })
    await call('apply', {
      request_id: 'confirm', expected_revision: state().revision,
      command: { action: 'confirm_plan', plan_id: 'plan', digest: state().plans[0]!.digest, confirmation: 'fixture:user-plan' },
    })
    await call('bind', { request_id: 'bind', expected_revision: state().revision, attempt_id: 'attempt', owner: 'primary', workspace: main })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    const owned = relative(resolve(tmpdir()), resolve(home))
    if (!owned.startsWith('contribbot-delegation-') || owned.includes(sep)) throw new Error('Unsafe delegation fixture cleanup path.')
    rmSync(home, { recursive: true, force: true })
  })

  it('captures a real child diff, requires exact review/integration, and checks the integrated behavior afresh', async () => {
    const result = await returned()
    expect(result.changes).toMatchObject([{ path: 'src/sum.cjs', before: { data: expect.stringContaining(', 1)') }, after: { data: expect.stringContaining(', 0)') } }])
    expect(readFileSync(join(main, 'src', 'sum.cjs'), 'utf8')).toContain(', 1)')
    expect(state().operations[0]!.status).toBe('returned')
    await expect(finish()).rejects.toThrow(/review|integrat/i)
    await review(result.result)
    await expect(finish()).rejects.toThrow(/integrat|match|delta/i)
    copyFileSync(join(child, 'src', 'sum.cjs'), join(main, 'src', 'sum.cjs'))
    await finish()
    expect(state().operations[0]!.status).toBe('accepted')
    expect(readFileSync(join(main, 'notes.txt'), 'utf8')).toBe('Existing uncommitted user document\n')
    expect(state().checks).toHaveLength(0)
    await mutate('yield', { observed_operations: ['delegate'], note: 'Integration is stopped; child is terminal.' })
    expect((await call('inspect')).readiness).toMatchObject({ ready: false })
    const checked = await mutate('check', { acceptance_id: 'sum', operation_id: 'main-check', actor: 'local-runner' })
    expect(checked.outcome).toBe('passed')
    expect((await call('inspect')).readiness).toMatchObject({ ready: true })
    const delegation = state().operations[0]!.delegation!
    for (const id of [delegation.launch, delegation.attachment, delegation.observation!.receipt,
      delegation.result!.receipt, delegation.review!.receipt, delegation.integration!.receipt]) {
      const path = join(storagePath(), 'executions', executionId, 'artifacts', `${id}.json`)
      const original = readFileSync(path)
      rmSync(path)
      expect((await call('inspect')).readiness).toMatchObject({ ready: false })
      writeFileSync(path, original)
    }
    expect((await call('inspect')).readiness).toMatchObject({ ready: true })
  }, 45_000)

  it('does not turn a completed host task or free-text receipt into accepted code', async () => {
    await returned()
    for (const command of [
      { action: 'return_operation', operation_id: 'delegate', receipt: 'looks done', note: 'done', process_stopped: true },
      { action: 'adopt_operation', operation_id: 'delegate', actor: 'primary', decision: 'accepted', note: 'passed' },
    ]) {
      await expect(call('apply', { request_id: `bypass-${command.action}`, expected_revision: state().revision, command }))
        .rejects.toThrow(/delegat|local|candidate/i)
    }
    await expect(mutate('yield', { observed_operations: ['delegate'], note: 'Cannot yield returned work.' })).rejects.toThrow(/unresolved/i)
    expect(state().checks).toHaveLength(0)
  }, 25_000)

  it('retains unknown occupancy when a host or a descendant cannot be accounted for', async () => {
    await prepare()
    await expect(collect()).rejects.toThrow(/host|terminal|observ/i)
    await attach()
    repair()
    await observe('unknown')
    await expect(collect()).rejects.toThrow(/terminal|unknown|observ/i)
    await observe('terminal', ['unqueryable-background-task'])
    await expect(collect()).rejects.toThrow(/descendant|unaccounted|quiescen/i)
    await expect(call('apply', {
      request_id: 'unsafe-writer', expected_revision: state().revision,
      command: { action: 'begin_operation', operation_id: 'writer', actor: 'primary', delegated: false, kind: 'write', step_id: 'fix', scope: ['src'], purpose: 'Must not race child' },
    })).rejects.toThrow(/unresolved/i)
  }, 25_000)

  it('lists out-of-scope untracked changes without filtering them into an acceptable patch', async () => {
    await prepare()
    await attach()
    repair()
    writeFileSync(join(child, 'outside.txt'), 'Unauthorized candidate addition\n')
    await observe()
    const result = await collect()
    expect(result.violations).toContain('outside.txt')
    await expect(review(result.result)).rejects.toThrow(/scope|outside/i)
    await finish('rejected')
    expect(state().operations[0]!.status).toBe('rejected')
    expect(readFileSync(join(main, 'src', 'sum.cjs'), 'utf8')).toContain(', 1)')
  }, 25_000)

  it('rejects source drift after review and does not adopt the unreviewed candidate', async () => {
    const result = await returned()
    await review(result.result)
    repair()
    writeFileSync(join(child, 'src', 'new.cjs'), 'module.exports = 42\n')
    copyFileSync(join(child, 'src', 'sum.cjs'), join(main, 'src', 'sum.cjs'))
    await expect(finish()).rejects.toThrow(/source|child|candidate|changed/i)
    expect(state().operations[0]!.status).toBe('returned')
  }, 25_000)

  it('refuses a changed target baseline instead of overwriting a user edit', async () => {
    const result = await returned()
    writeFileSync(join(main, 'notes.txt'), 'User edited while the child was running\n')
    await expect(review(result.result)).rejects.toThrow(/target|baseline|changed/i)
    expect(readFileSync(join(main, 'notes.txt'), 'utf8')).toBe('User edited while the child was running\n')
  }, 25_000)

  it('captures additions and deletions and verifies both in the target before acceptance', async () => {
    await prepare()
    await attach()
    rmSync(join(child, 'src', 'sum.cjs'))
    writeFileSync(join(child, 'src', 'replacement.cjs'), 'module.exports = 5\n')
    await observe()
    const result = await collect()
    expect(result.changes).toMatchObject([
      { path: 'src/replacement.cjs', before: null, after: { data: 'module.exports = 5\n' } },
      { path: 'src/sum.cjs', before: { data: expect.any(String) }, after: null },
    ])
    await review(result.result)
    copyFileSync(join(child, 'src', 'replacement.cjs'), join(main, 'src', 'replacement.cjs'))
    await expect(finish()).rejects.toThrow(/integrat|match|delta/i)
    rmSync(join(main, 'src', 'sum.cjs'))
    await finish()
    expect(state().operations[0]!.status).toBe('accepted')
    expect(state().checks).toHaveLength(0)
  }, 25_000)

  it.each(['main-first', 'child-first'])('prevents competing workspace writers when reserved %s', async order => {
    if (order === 'main-first') await prepare()
    const other = store.add({ ref: 'other', title: 'Other Todo', type: 'feature' })
    const otherExecution = store.activateExecution(store.resolveItemById(other.id!)!.storeIndex).execution.id
    const otherCall = (action: string, input: Record<string, unknown>) => call(action, { ...input, todo_id: other.id, execution_id: otherExecution })
    await otherCall('apply', { request_id: 'other-plan', expected_revision: 0, command: { action: 'propose_plan', plan_id: 'p', plan } })
    const otherState = () => store.resolveItemById(other.id!)!.item.executions[0]!.workflow!
    await otherCall('apply', { request_id: 'other-confirm', expected_revision: 1, command: { action: 'confirm_plan', plan_id: 'p', digest: otherState().plans[0]!.digest, confirmation: 'fixture:user' } })
    await otherCall('bind', { request_id: 'other-bind', expected_revision: 2, workspace: child, attempt_id: 'a', owner: 'other' })
    const write = () => otherCall('apply', {
      request_id: 'other-write', expected_revision: 3,
      command: { action: 'begin_operation', operation_id: 'conflict', actor: 'other', kind: 'write', delegated: false, step_id: 'fix', scope: ['src'], purpose: 'Must be rejected' },
    })
    if (order === 'main-first') await expect(write()).rejects.toThrow(/occup|workspace/i)
    else {
      await write()
      await expect(prepare()).rejects.toThrow(/occup|workspace/i)
      expect(state().operations).toHaveLength(0)
    }
  }, 20_000)

  it('replays exact successful requests without recapturing changed workspaces or creating a second assignment', async () => {
    const request = { request_id: 'launch', expected_revision: state().revision, actor: 'primary', operation_id: 'delegate',
      step_id: 'fix', scope: ['src'], purpose: 'Repair sum', workspace: child, token: 'launch-once',
      provider: host.provider, tool: 'multi_agent_v1.spawn_agent', brief: 'Repair sum only.' }
    await call('delegate-prepare', request)
    const attachRequest = { request_id: 'attach', expected_revision: state().revision, actor: 'primary',
      operation_id: 'delegate', handle: host, locator: 'fixture:spawn', raw: { agent_id: host.task_id } }
    await call('delegate-attach', attachRequest)
    await call('delegate-attach', { ...attachRequest, expected_revision: state().revision })
    repair()
    await observe()
    const collected = await collect()
    const reviewRequest = { request_id: 'review', expected_revision: state().revision, actor: 'primary',
      operation_id: 'delegate', result: collected.result, locator: 'fixture:review', note: 'Actual diff reviewed.' }
    await call('delegate-review', reviewRequest)
    copyFileSync(join(child, 'src', 'sum.cjs'), join(main, 'src', 'sum.cjs'))
    const finishRequest = { request_id: 'finish', expected_revision: state().revision, actor: 'primary',
      operation_id: 'delegate', decision: 'accepted', note: 'Integrated.' }
    await call('delegate-finish', finishRequest)
    const revision = state().revision
    writeFileSync(join(main, 'notes.txt'), 'A later user edit must survive replay\n')
    await call('delegate-prepare', request)
    await call('delegate-review', reviewRequest)
    await call('delegate-finish', { ...finishRequest, expected_revision: revision })
    expect(state().revision).toBe(revision)
    expect(state().operations).toHaveLength(1)
    expect(readFileSync(join(main, 'notes.txt'), 'utf8')).toBe('A later user edit must survive replay\n')
    await expect(call('delegate-review', { ...reviewRequest, note: 'Changed meaning' })).rejects.toThrow(/conflict|reuse/i)
  }, 30_000)

  it('recovers a published candidate after state persistence failed without silently recollecting a different result', async () => {
    await prepare()
    await attach()
    repair()
    await observe()
    const injected = vi.spyOn(TodoStore.prototype, 'applyWorkflow').mockImplementationOnce(() => {
      throw new Error('Injected state persistence failure')
    })
    await expect(collect()).rejects.toThrow(/Injected/)
    injected.mockRestore()
    const artifacts = new ExecutionArtifacts(storagePath(), executionId)
    const original = artifacts.getReceipt('delegate')!
    await observe('terminal', [], new Date(Date.now() + 1000).toISOString())
    const result = await collect()
    expect(result.result).toBe(original.digest)
    expect(state().operations[0]!.delegation!.result!.receipt).toBe(original.digest)
  }, 20_000)

  it('requires the original attachment artifact even when a later host observation claims completion', async () => {
    await prepare()
    await attach()
    repair()
    await observe()
    const attachment = state().operations[0]!.delegation!.attachment
    rmSync(join(storagePath(), 'executions', executionId, 'artifacts', `${attachment}.json`))
    await expect(collect()).rejects.toThrow(/artifact|ENOENT|attachment/i)
    expect(state().operations[0]!.delegation!.result).toBeNull()
  }, 15_000)

  it('does not let delayed terminal evidence erase a newer running observation', async () => {
    await prepare()
    await attach()
    repair()
    const now = Date.now()
    await observe('running', [], new Date(now).toISOString())
    await expect(observe('terminal', [], new Date(now - 1000).toISOString())).rejects.toThrow(/older|order|stale|observation/i)
    await expect(collect()).rejects.toThrow(/terminal|quiescen/i)
    expect(state().operations[0]!.status).toBe('unknown')
  }, 15_000)

  it('requires a fresh observation after explicit uncertainty instead of reusing the earlier terminal report', async () => {
    await prepare()
    await attach()
    repair()
    await observe('terminal', [], new Date(Date.now() - 1000).toISOString())
    await call('apply', { request_id: 'lost-host', expected_revision: state().revision,
      command: { action: 'mark_unknown', operation_id: 'delegate', reason: 'Host task may have resumed; query it again.' } })
    await expect(collect()).rejects.toThrow(/unknown|observation|quiescen/i)
    await observe('terminal', [], new Date(Date.now() + 1000).toISOString())
    await collect()
    expect(state().operations[0]!.status).toBe('returned')
  }, 20_000)

  it('rejects mismatched providers, task handles and owners without changing the original assignment', async () => {
    await prepare()
    await expect(mutate('delegate-attach', { operation_id: 'delegate',
      handle: { ...host, provider: 'other-provider' }, locator: 'wrong', raw: {} })).rejects.toThrow(/provider/i)
    await attach()
    const revision = state().revision
    await expect(mutate('delegate-observe', {
      operation_id: 'delegate', handle: { ...host, task_id: 'other-task' }, tool: 'fixture:wait',
      locator: 'wrong', observed_at: new Date().toISOString(), status: 'terminal', raw: {},
      quiescence: { statement: 'Different task stopped.', locator: 'wrong', descendants: [], unaccounted: [] },
    })).rejects.toThrow(/host task/i)
    await expect(mutate('delegate-attach', {
      operation_id: 'delegate', handle: host, locator: 'wrong-owner', raw: {}, actor: 'other-owner',
    })).rejects.toThrow(/owner/i)
    expect(state().revision).toBe(revision)
    expect(state().operations[0]!.delegation!.host).toEqual(host)
  }, 15_000)

  it('refuses to dispatch from a baseline that drops existing user content', async () => {
    writeFileSync(join(child, 'notes.txt'), 'Overwritten user change\n')
    await expect(prepare()).rejects.toThrow(/baseline|existing material/i)
    expect(state().operations).toHaveLength(0)
    expect(readFileSync(join(main, 'notes.txt'), 'utf8')).toBe('Existing uncommitted user document\n')
  }, 15_000)

  it('does not accept changes to the child Git index as a code-only candidate', async () => {
    await prepare()
    await attach()
    repair()
    git('-C', child, 'add', 'src/sum.cjs')
    await observe()
    const result = await collect()
    expect(result.violations).toContain('<git-metadata>')
    await expect(review(result.result)).rejects.toThrow(/scope|git-metadata/i)
    await finish('rejected')
    expect(readFileSync(join(main, 'src/sum.cjs'), 'utf8')).toContain(', 1)')
  }, 20_000)
})
