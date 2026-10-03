import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoStore } from '../storage/todo-store.js'
import { runLocalCommand } from './local.js'
import { ExecutionArtifacts } from './artifacts.js'
import type { WorkflowPlanInput } from './contracts.js'
import { captureCandidate } from './candidate.js'
import { finalizeClosure, prepareClosure } from './closure.js'
import { stringify } from 'yaml'
import { projectDirectory } from '../utils/repository-ref.js'
import { RepoConfig } from '../storage/repo-config.js'

const machine = vi.hoisted(() => ({ hostname: null as string | null }))
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>()
  return { ...os, hostname: () => machine.hostname ?? os.hostname() }
})

describe('local helper user-facing workflow', () => {
  let directory: string
  let workspace: string
  let dataRoot: string
  let store: TodoStore
  let todoId: string
  let executionId: string
  const state = () => store.list()[0]!.executions[0]!.workflow!
  const storagePath = () => projectDirectory({
    platform: 'github', instance: 'https://github.com', path: 'fixture/repo',
  }, dataRoot)
  const call = (action: string, payload: Record<string, unknown>) => runLocalCommand({
    action, repo: { platform: 'github', instance: 'https://github.com', path: 'fixture/repo' },
    data_root: dataRoot, ...payload,
  })
  const identity = () => ({ todo_id: todoId, execution_id: executionId })
  const relocation = () => ({
    ...identity(), request_id: 'relocate', expected_revision: state().revision,
    from_attempt: 'attempt', attempt_id: 'relocated', owner: 'primary', workspace,
    decision: 'fixture:user-approved-relocation', plan_digest: state().plans[0]!.digest,
  })
  const plan: WorkflowPlanInput = {
    goal: 'Review the document', completion_scope: 'task', remaining_scope: [], non_goals: [], scope: ['.'], risk: 'normal',
    steps: [{ id: 'review', title: 'Review', scope: ['.'], depends_on: [], acceptance_ids: ['manual'] }],
    acceptance: [{ id: 'manual', description: 'User approves the delivered document', kind: 'manual', independent: false, required: true }],
  }
  const prepare = async () => {
    await call('apply', { ...identity(), request_id: 'propose', expected_revision: 0, command: { action: 'propose_plan', plan_id: 'p', plan } })
    await call('apply', {
      ...identity(), request_id: 'confirm', expected_revision: 1,
      command: { action: 'confirm_plan', plan_id: 'p', digest: state().plans[0]!.digest, confirmation: 'user-plan' },
    })
  }
  const acceptedReport = async () => {
    await prepare()
    await call('bind', { ...identity(), request_id: 'bind', expected_revision: 2, attempt_id: 'attempt', owner: 'primary', workspace })
    await call('yield', { ...identity(), request_id: 'yield', expected_revision: 3, actor: 'primary', observed_operations: [], note: 'No writer remains.' })
    await call('report', {
      ...identity(), request_id: 'manual', expected_revision: 4, operation_id: 'manual',
      plan_id: state().plan_id, attempt_id: state().attempt_id, epoch: state().epoch, candidate: state().yield!.candidate,
      observed_at: new Date().toISOString(),
      acceptance_id: 'manual', actor: 'user', source: 'user', outcome: 'passed',
      locator: 'user-acceptance-turn', summary: 'User inspected and accepted the document.',
    })
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'contribbot-local-'))
    workspace = join(directory, 'workspace')
    dataRoot = join(directory, 'data-root')
    mkdirSync(workspace)
    const git = (...args: string[]) => execFileSync('git', [
      '-c', 'core.hooksPath=nonexistent-hooks', '-c', 'commit.gpgSign=false', ...args,
    ], { cwd: workspace, windowsHide: true, stdio: 'pipe' })
    git('init', '--quiet', '--initial-branch=fixture')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git')
    writeFileSync(join(workspace, 'README.md'), 'Delivered document')
    git('add', '.')
    git('commit', '--quiet', '-m', 'fixture')
    const storage = storagePath()
    new RepoConfig(storage).save({
      schema_version: 3,
      repository: { platform: 'github', instance: 'https://github.com', path: 'fixture/repo' },
      lifecycle: { status: 'active' },
      parent: { status: 'unknown' },
      tracking: { status: 'pending' },
    })
    store = new TodoStore(storage)
    todoId = store.add({ ref: 'document', title: 'Document', type: 'docs' }).id!
    executionId = store.activateExecution(0).execution.id
  })
  afterEach(() => { machine.hostname = null; rmSync(directory, { recursive: true, force: true }) })

  const stop = async (kind: 'pause' | 'cancel' = 'pause') => call('apply', {
    ...identity(), request_id: `request-${kind}`, expected_revision: state()?.revision ?? 0,
    command: { action: 'request_control', control_id: kind, kind, decision: `user:${kind}`, note: 'User explicitly stopped this work.' },
  })
  const settle = () => call('settle-pause', {
    ...identity(), request_id: 'settle', expected_revision: state().revision, control_id: 'pause', actor: 'primary',
  })

  it('pauses and resumes unbound design work without creating an attempt or another execution', async () => {
    await stop()
    expect(store.list()[0]?.status).toBe('active')
    expect((await call('context', identity())).control).toMatchObject({ settled: false, dispatch_allowed: false })
    await settle()
    expect(store.list()[0]?.status).toBe('paused')
    const epoch = state().epoch
    await call('resume', identity())
    expect(store.list()[0]?.status).toBe('paused')
    await call('continue', { ...identity(), request_id: 'continue', expected_revision: state().revision,
      control_id: 'pause', actor: 'primary', decision: 'user:continue' })
    expect(store.list()[0]?.status).toBe('active')
    expect(state().epoch).toBe(epoch + 1)
    expect(state().attempts).toEqual([])
    expect(store.list()[0]?.executions).toHaveLength(1)
    expect(state().control?.requests).toHaveLength(1)
  })

  it('safely resumes the same bound attempt while keeping old checks historical', async () => {
    await acceptedReport()
    const original = structuredClone(state().checks)
    await stop()
    await settle()
    expect(store.list()[0]?.status).toBe('paused')
    expect(() => store.update(0, { status: 'active' })).toThrow(/control|pause/i)
    expect(() => store.activateExecution(0)).toThrow(/control|pause/i)
    writeFileSync(join(workspace, 'README.md'), 'Newer files edited while paused')
    await call('continue', { ...identity(), request_id: 'continue', expected_revision: state().revision,
      control_id: 'pause', actor: 'primary', decision: 'user:continue' })
    expect(state().attempt_id).toBe('attempt')
    expect(state().checks).toEqual(original)
    expect(state().yield).toBeNull()
    expect((await call('inspect', identity())).readiness).toMatchObject({ ready: false })
  }, 20_000)

  it('records intent despite an unavailable original machine and keeps unsafe settlement blocked', async () => {
    await acceptedReport()
    machine.hostname = 'different-machine'
    await stop()
    expect(state().control?.active_id).toBe('pause')
    await expect(settle()).rejects.toThrow(/machine|host/i)
    expect(store.list()[0]?.status).toBe('active')
    expect(state().closure).toBeNull()
  }, 20_000)

  it('does not reuse pre-resume checks if persisted epoch is corrupted backwards', async () => {
    await acceptedReport()
    await stop()
    await settle()
    const epoch = state().epoch
    await call('continue', { ...identity(), request_id: 'continue', expected_revision: state().revision,
      control_id: 'pause', actor: 'primary', decision: 'user:continue' })
    const todos = store.list()
    todos[0]!.executions[0]!.workflow!.epoch = epoch
    writeFileSync(join(storagePath(), 'todos.yaml'), stringify({ todos }))
    await call('yield', { ...identity(), request_id: 'after-corruption', expected_revision: state().revision,
      actor: 'primary', observed_operations: ['manual'], note: 'No writers remain.' })
    expect((await call('inspect', identity())).readiness).toMatchObject({ ready: false, gaps: ['control:history'] })
  }, 20_000)

  it('withdraws a reversible local closure under the exact stop request, then settles pause', async () => {
    await acceptedReport()
    const directory = storagePath()
    prepareClosure({ directory, ...identity(), closure_id: 'original-close', expected_revision: state().revision,
      mode: 'verified', decision: 'user:old-complete', note: 'Originally finishing', acknowledged_gaps: [], target: { kind: 'local' } })
    await stop()
    await expect(settle()).rejects.toThrow(/pending|closure/i)
    const withdrawal = { ...identity(), request_id: 'withdraw-close', expected_revision: state().revision,
      control_id: 'pause', closure_id: 'original-close', actor: 'primary', note: 'User paused before local finalization.' }
    await call('cancel-close', withdrawal)
    expect(state().closing_id).toBeNull()
    expect(state().closings[0]?.state).toBe('cancelled')
    expect(state().closure).toBeNull()
    await settle()
    const revision = state().revision
    await call('cancel-close', withdrawal)
    expect(state().revision).toBe(revision)
    expect(store.get(0)?.status).toBe('paused')
  }, 20_000)
  it('closes an explicit cancellation locally without requiring success or archiving', async () => {
    await stop('cancel')
    const result = await call('close', { ...identity(), closure_id: 'cancel-close', expected_revision: state().revision,
      mode: 'stopped', decision: 'user:cancel', note: 'Keep the partial work.', acknowledged_gaps: [], target: { kind: 'local' } })
    expect(result.todo).toMatchObject({ status: 'cancelled' })
    expect(result.archived).toBe(false)
    expect(store.listArchived()).toEqual([])
    expect(store.list()[0]!.executions[0]!.workflow!.control?.active_id).toBeNull()
    const reopened = store.reopen(todoId)
    expect(reopened.item.status).toBe('backlog')
    expect(store.activateExecution(reopened.storeIndex).execution.id).not.toBe(executionId)
  })

  it.each(['prepare', 'finalize'])('keeps unbound cancellation pending at %s when its pause history receipt is missing', async boundary => {
    await stop()
    await settle()
    const receipt = state().control!.events.find(event => event.kind === 'paused')!.verification!
    await call('continue', { ...identity(), request_id: 'continue', expected_revision: state().revision,
      control_id: 'pause', actor: 'primary', decision: 'user:continue' })
    await stop('cancel')
    const finish = { directory: storagePath(), ...identity(), closure_id: 'unbound-cancel',
      expected_revision: state().revision, mode: 'stopped', decision: 'user:cancel', note: 'Retain partial design.',
      acknowledged_gaps: [], target: { kind: 'local' } }
    if (boundary === 'finalize') prepareClosure(finish)
    rmSync(join(storagePath(), 'executions', executionId, 'artifacts', `${receipt}.json`))
    expect(() => (boundary === 'prepare' ? prepareClosure : finalizeClosure)(finish)).toThrow(/accounting|receipt|ENOENT/i)
    expect(store.get(0)!.status).toBe('active')
    expect(state().closure).toBeNull()
  })

  it('rejects closure withdrawal by a superseded control or a different owner', async () => {
    await acceptedReport()
    prepareClosure({ directory: storagePath(), ...identity(), closure_id: 'original',
      expected_revision: state().revision, mode: 'verified', decision: 'user:complete',
      note: 'Original close', acknowledged_gaps: [], target: { kind: 'local' } })
    await stop()
    await stop('cancel')
    const request = { ...identity(), request_id: 'withdraw', expected_revision: state().revision,
      control_id: 'pause', closure_id: 'original', actor: 'primary', note: 'Withdraw reservation only.' }
    await expect(call('cancel-close', request)).rejects.toThrow(/current control/i)
    await expect(call('cancel-close', { ...request, control_id: 'cancel', actor: 'other' })).rejects.toThrow(/owner/i)
    expect(state().closing_id).toBe('original')
    await call('cancel-close', { ...request, control_id: 'cancel' })
    expect(state().closing_id).toBeNull()
    expect(state().control?.active_id).toBe('cancel')
    expect(store.get(0)?.status).toBe('active')
  }, 20_000)

  it('does not imply a writable workflow revision before an execution exists', async () => {
    const todo = store.add({ ref: 'not-activated', title: 'Not yet active', type: 'feature' })
    const context = await call('context', { todo_id: todo.id })
    expect(context.execution).toBeNull()
    expect(context.workflow_revision).toBeNull()
    expect(store.resolveItemFromAll(todo.id!)!.executions).toEqual([])
  })

  it('refuses missing or mismatched project config before reading a Todo', async () => {
    const configPath = join(storagePath(), 'config.yaml')
    rmSync(configPath)
    await expect(call('context', identity())).rejects.toThrow(/Initialize.*config/i)
    writeFileSync(configPath, [
      'schema_version: 3', 'repository:', '  platform: github',
      '  instance: https://github.com', '  path: fixture/other',
      'lifecycle:', '  status: active', 'parent:', '  status: unknown',
      'tracking:', '  status: pending', '',
    ].join('\n'))
    await expect(call('context', identity())).rejects.toThrow(/identity.*directory/i)
  })

  it('binds verified repository, captures yield, records explicit user acceptance and closes', async () => {
    await acceptedReport()
    const result = await call('close', {
      ...identity(), closure_id: 'close', expected_revision: state().revision, mode: 'verified',
      decision: 'user-close-turn', note: 'Complete document task', acknowledged_gaps: [], target: { kind: 'local' },
    })
    expect(result.schema_version).toBe(1)
    expect(result.archived).toBe(false)
    expect(result.todo).toMatchObject({ status: 'done' })
    expect(store.listArchived()).toEqual([])
    expect(store.list()[0]!.executions[0]!.workflow!.closure!.mode).toBe('verified')
  }, 20_000)

  it.each(['receipt', 'manifest'] as const)('does not advertise delivery readiness when a report %s is missing', async (missing) => {
    await acceptedReport()
    const storage = storagePath()
    const check = state().checks[0]!
    const artifacts = new ExecutionArtifacts(storage, executionId)
    const report = artifacts.get(check.receipt) as { manifest: string }
    rmSync(join(storage, 'executions', executionId, 'artifacts', `${missing === 'receipt' ? check.receipt : report.manifest}.json`))
    const result = await call('inspect', identity())
    expect(result.readiness).toMatchObject({ ready: false, gaps: ['artifact:manual'] })
    await expect(call('close', {
      ...identity(), closure_id: 'close', expected_revision: state().revision, mode: 'verified',
      decision: 'user-close-turn', note: 'Finish', acknowledged_gaps: [], target: { kind: 'local' },
    })).rejects.toThrow(/artifact/i)
    expect(store.listArchived()).toEqual([])
  }, 20_000)

  it('replays a successful binding without replacing its baseline after later edits', async () => {
    await prepare()
    const request = { ...identity(), request_id: 'bind', expected_revision: 2, attempt_id: 'attempt', owner: 'primary', workspace }
    await call('bind', request)
    const baseline = state().attempts[0]!.workspace.baseline
    writeFileSync(join(workspace, 'README.md'), 'Later work')
    await expect(call('bind', request)).resolves.toMatchObject({ workflow: { revision: 3 } })
    expect(state().attempts).toHaveLength(1)
    expect(state().attempts[0]!.workspace.baseline).toBe(baseline)
    await expect(call('bind', { ...request, owner: 'other' })).rejects.toThrow(/reuse|different|owner/i)
  }, 20_000)

  it('rejects a workspace belonging to another repository instead of trusting the provided path', async () => {
    await prepare()
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/elsewhere/unrelated.git'], { cwd: workspace, windowsHide: true })
    await expect(call('bind', { ...identity(), request_id: 'bind', expected_revision: 2, attempt_id: 'attempt', owner: 'primary', workspace }))
      .rejects.toThrow(/repository|origin/i)
    expect(state().attempt_id).toBeNull()
  }, 10_000)

  it('does not expose internal result or closure transitions as generic host commands', async () => {
    await prepare()
    await expect(call('apply', {
      ...identity(), request_id: 'fake-result', expected_revision: 2,
      command: { action: 'complete_check', operation_id: 'missing', source: 'local_runner' },
    })).rejects.toThrow(/local|internal|action/i)
    await expect(call('apply', {
      ...identity(), request_id: 'fake-close', expected_revision: 2,
      command: { action: 'finish_closure', closure_id: 'missing' },
    })).rejects.toThrow(/local|internal|action/i)
    await expect(call('apply', {
      ...identity(), request_id: 'fake-reconcile-close', expected_revision: 2,
      command: { action: 'reconcile_closure', closure_id: 'missing' },
    })).rejects.toThrow(/local|internal|action/i)
  })

  it('reads a structured context through the real CLI from an unrelated cwd', async () => {
    await prepare()
    const input = join(directory, 'request.json')
    writeFileSync(input, JSON.stringify({
      ...identity(), repo: { platform: 'github', instance: 'https://github.com', path: 'fixture/repo' },
    }))
    const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url))
    const cli = fileURLToPath(new URL('../../cli/execution.ts', import.meta.url))
    const result = spawnSync(process.execPath, [tsx, cli, 'context', '--data-root', dataRoot, '--request', input], {
      cwd: directory, windowsHide: true, encoding: 'utf8',
    })
    expect(result.status, result.stderr + result.stdout).toBe(0)
    const data = JSON.parse(result.stdout)
    expect(data.schema_version).toBe(1)
    expect(data.todo.id).toBe(todoId)
    expect(data.execution.workflow.plans[0].content.goal).toBe(plan.goal)
    expect(data.recovery).toBeInstanceOf(Array)
  })

  it('does not inspect or close another machine using a same-named local directory', async () => {
    await acceptedReport()
    machine.hostname = 'a-different-fixture-machine'
    await expect(call('inspect', identity())).rejects.toThrow(/machine|hostname/i)
    await expect(call('close', {
      ...identity(), closure_id: 'close', expected_revision: state().revision, mode: 'verified',
      decision: 'user-close', note: 'No wrong-host completion', acknowledged_gaps: [], target: { kind: 'local' },
    })).rejects.toThrow(/machine|hostname/i)
    expect(store.listArchived()).toEqual([])
    expect(state().closure).toBeNull()
  }, 20_000)

  it('explicitly relocates settled work to a new attempt without inheriting the previous pass', async () => {
    await acceptedReport()
    machine.hostname = 'renamed-fixture-machine'
    const request = { ...identity(), request_id: 'relocate', expected_revision: state().revision,
      from_attempt: 'attempt', attempt_id: 'relocated', owner: 'primary', workspace, decision: 'user-approved-host-change',
      plan_digest: state().plans[0]!.digest }
    await call('relocate', request)
    expect(state().attempt_id).toBe('relocated')
    expect(state().attempts).toHaveLength(2)
    expect(state().yield).toBeNull()
    await expect(call('bind', { ...identity(), request_id: 'old-bind', expected_revision: state().revision,
      attempt_id: 'attempt', owner: 'primary', workspace })).rejects.toThrow(/machine|hostname/i)
    writeFileSync(join(workspace, 'README.md'), 'A later edit must not rewrite the relocation baseline')
    await call('relocate', request)
    expect(state().attempts).toHaveLength(2)
    await call('yield', { ...identity(), request_id: 'new-yield', expected_revision: state().revision,
      actor: 'primary', observed_operations: [], note: 'New attempt yielded, old work is settled.' })
    expect((await call('inspect', identity())).readiness).toMatchObject({ ready: false, missing: ['manual'] })
  }, 25_000)

  it('cannot relocate to erase an unknown writer', async () => {
    await acceptedReport()
    await call('apply', { ...identity(), request_id: 'write', expected_revision: state().revision,
      command: { action: 'begin_operation', operation_id: 'writer', actor: 'primary', delegated: false,
        kind: 'write', step_id: 'review', scope: ['.'], purpose: 'Outstanding work' } })
    await call('apply', { ...identity(), request_id: 'lost', expected_revision: state().revision,
      command: { action: 'mark_unknown', operation_id: 'writer', reason: 'Original host cannot be queried' } })
    const before = state()
    machine.hostname = 'renamed-fixture-machine'
    await expect(call('relocate', { ...identity(), request_id: 'relocate', expected_revision: state().revision,
      from_attempt: 'attempt', attempt_id: 'unsafe', owner: 'primary', workspace, decision: 'User requested relocation, not unsafe replay',
      plan_digest: state().plans[0]!.digest }))
      .rejects.toThrow('Unresolved operations must be reconciled before relocation.')
    expect(state().attempt_id).toBe('attempt')
    expect(state().operations.find(item => item.id === 'writer')?.status).toBe('unknown')
    expect(state()).toEqual(before)
    expect(store.listArchived()).toEqual([])
  }, 20_000)

  it('reads a historical machine-less binding without treating it as local verification', async () => {
    await prepare()
    const { digest, root, git_dir, common_dir } = captureCandidate(workspace)
    store.applyWorkflow(todoId, executionId, {
      request_id: 'historical-bind', expected_revision: state().revision,
      command: { action: 'start_attempt', attempt_id: 'attempt', owner: 'primary',
        workspace: { repo: { platform: 'github', instance: 'https://github.com', path: 'fixture/repo' },
          root, git_dir, common_dir, baseline: digest } },
    })
    const before = state()
    expect(await call('context', identity())).toMatchObject({
      workspace_observation: 'not_observed', readiness: null,
      execution: { workflow: { attempt_id: 'attempt' } },
    })
    await expect(call('inspect', identity())).rejects.toThrow()
    await expect(call('bind', { ...identity(), request_id: 'bind-again', expected_revision: state().revision,
      attempt_id: 'new-bind', owner: 'primary', workspace })).rejects.toThrow()
    expect(state()).toEqual(before)
    await call('relocate', relocation())
    expect(state().attempts[0]).toEqual(before.attempts[0])
    expect(state().attempts[1]!.workspace.machine).toBeDefined()
    expect(state().yield).toBeNull()
    expect((await call('inspect', identity())).readiness).toMatchObject({ ready: false, missing: ['manual'] })
    expect(store.listArchived()).toEqual([])
  }, 20_000)

  it('cannot relocate around a prepared closure or silently rebind another machine', async () => {
    await acceptedReport()
    const beforeBind = state()
    machine.hostname = 'a-different-fixture-machine'
    await expect(call('bind', { ...identity(), request_id: 'new-bind', expected_revision: state().revision,
      attempt_id: 'new-bind', owner: 'primary', workspace })).rejects.toThrow()
    expect(state()).toEqual(beforeBind)
    machine.hostname = null
    prepareClosure({
      ...identity(), directory: storagePath(), closure_id: 'pending',
      expected_revision: state().revision, mode: 'verified', acknowledged_gaps: [],
      decision: 'fixture:close', note: 'Prepared but not yet finalized', target: { kind: 'local' },
    })
    const beforeRelocation = state()
    await expect(call('relocate', relocation())).rejects.toThrow()
    expect(state()).toEqual(beforeRelocation)
    expect(state().closing_id).toBe('pending')
    expect(store.listArchived()).toEqual([])
  }, 20_000)

  it('requires the original owner, current attempt, exact plan and canonical repository for relocation', async () => {
    await prepare()
    await call('bind', { ...identity(), request_id: 'bind', expected_revision: state().revision,
      attempt_id: 'attempt', owner: 'primary', workspace })
    const before = state()
    for (const change of [{ owner: 'other' }, { from_attempt: 'not-current' }, { plan_digest: '0'.repeat(64) }]) {
      await expect(call('relocate', { ...relocation(), ...change })).rejects.toThrow()
      expect(state()).toEqual(before)
    }
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/elsewhere/unrelated.git'], { cwd: workspace, windowsHide: true })
    await expect(call('relocate', relocation())).rejects.toThrow()
    expect(state()).toEqual(before)
  }, 20_000)

  it.each(['receipt', 'manifest'] as const)('cannot verify a relocated candidate when its %s is lost', async missing => {
    await acceptedReport()
    await call('relocate', relocation())
    await call('yield', { ...identity(), request_id: 'new-yield', expected_revision: state().revision,
      actor: 'primary', observed_operations: [], note: 'Relocated attempt has no writers.' })
    await call('report', {
      ...identity(), request_id: 'new-report', expected_revision: state().revision, operation_id: 'new-report',
      plan_id: state().plan_id, attempt_id: state().attempt_id, epoch: state().epoch, candidate: state().yield!.candidate,
      observed_at: new Date().toISOString(),
      acceptance_id: 'manual', actor: 'user', source: 'user', outcome: 'passed',
      locator: 'fixture:new-user-acceptance', summary: 'Fixture user accepts this attempt.',
    })
    expect((await call('inspect', identity())).readiness).toMatchObject({ ready: true, gaps: [] })
    const storage = storagePath()
    const receipt = state().attempts[1]!.relocation!.receipt
    const artifacts = new ExecutionArtifacts(storage, executionId)
    const record = artifacts.get(receipt) as { manifest: string }
    rmSync(join(storage, 'executions', executionId, 'artifacts', `${missing === 'receipt' ? receipt : record.manifest}.json`))
    expect((await call('inspect', identity())).readiness).toMatchObject({
      ready: false,
      gaps: missing === 'manifest' ? ['artifact:manual', 'relocation:relocated'] : ['relocation:relocated'],
    })
    await expect(call('close', {
      ...identity(), closure_id: 'close-relocated', expected_revision: state().revision, mode: 'verified',
      decision: 'fixture:close', note: 'No lost relocation evidence', acknowledged_gaps: [], target: { kind: 'local' },
    })).rejects.toThrow()
    expect(store.listArchived()).toEqual([])
    expect(state().closure).toBeNull()
  }, 30_000)
})
