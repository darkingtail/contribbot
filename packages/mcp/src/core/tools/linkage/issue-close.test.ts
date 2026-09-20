import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore } from '../../storage/todo-store.js'
import { getContribDir } from '../../utils/config.js'
import { currentTodoExecution } from '../../storage/todo-store.js'
import { issueClose } from './issue-close.js'
import { execFileSync } from 'node:child_process'
import { captureCandidate } from '../../execution/candidate.js'
import { runCheck } from '../../execution/checks.js'
import { planDigest } from '../../execution/workflow.js'
import type { WorkflowPlanInput, WorkflowRequest } from '../../execution/contracts.js'
import type { LinkedClosure } from './issue-close.js'
import { localMachine } from '../../execution/processes.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../../../mcp/server.js'
import { closeManaged, finalizeClosure, prepareClosure } from '../../execution/closure.js'
import { runLocalCommand } from '../../execution/local.js'
import { ExecutionArtifacts } from '../../execution/artifacts.js'
import * as journals from '../../storage/issue-close-journal.js'
import * as accounting from '../../storage/issue-close-accounting.js'
import { verifyClosureReconciliation } from '../../execution/closure-reconciliation.js'
import { stringify } from 'yaml'
import { settleControl } from '../../execution/control.js'

const machine = vi.hoisted(() => ({ hostname: null as string | null }))
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>()
  return { ...os, hostname: () => machine.hostname ?? os.hostname() }
})

const github = vi.hoisted(() => ({
  closeIssue: vi.fn(),
  createComment: vi.fn(),
  getIssue: vi.fn(),
  getIssueComments: vi.fn(),
}))

vi.mock('../../clients/github.js', async original => ({
  ...await original<typeof import('../../clients/github.js')>(), ...github,
}))

vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockResolvedValue({ owner: 'owner', name: 'repo' }),
}))

describe('issueClose', () => {
  let home: string
  let client: Client | undefined
  let server: ReturnType<typeof createServer> | undefined

  async function publicClose(args: Record<string, unknown>) {
    if (!client) {
      client = new Client({ name: 'isolated-close-test', version: '1' })
      server = createServer()
      const [a, b] = InMemoryTransport.createLinkedPair()
      await Promise.all([client.connect(a), server.connect(b)])
    }
    return client.callTool({ name: 'issue_close', arguments: { repo: 'owner/repo', issue_number: 42, ...args } })
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'issue-close-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    github.closeIssue.mockReset().mockResolvedValue({ state: 'closed' })
    github.createComment.mockReset().mockResolvedValue({ id: 800, body: '' })
    github.getIssue.mockReset().mockResolvedValue({ state: 'open' })
    github.getIssueComments.mockReset().mockResolvedValue([])
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await client?.close()
    await server?.close()
    client = undefined
    server = undefined
    machine.hostname = null
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  async function managedFixture(scope: 'task' | 'stage' = 'task') {
    const directory = getContribDir('owner', 'repo')
    const store = new TodoStore(directory)
    const todo = store.add({ ref: 'managed-linked', title: 'Managed linked task', type: 'feature' })
    const execution = store.activateExecution(0).execution
    const workspace = join(home, 'workspace')
    mkdirSync(workspace)
    const git = (...args: string[]) => execFileSync('git', [
      '-c', 'core.hooksPath=nonexistent-hooks', '-c', 'commit.gpgSign=false', ...args,
    ], { cwd: workspace, windowsHide: true, stdio: 'pipe' })
    git('init', '--quiet', '--initial-branch=fixture')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(workspace, 'source.txt'), 'candidate')
    git('add', '.')
    git('commit', '--quiet', '-m', 'fixture')
    const plan: WorkflowPlanInput = {
      goal: 'Verified change', completion_scope: scope,
      remaining_scope: scope === 'stage' ? ['Implement the remaining workflow'] : [], scope: ['.'], non_goals: [], risk: 'normal',
      steps: [{ id: 's', title: 'Implement', scope: ['.'], depends_on: [], acceptance_ids: ['test'] }],
      acceptance: [{
        id: 'test', kind: 'command', description: 'Verify source contents', independent: false, required: true,
        command: {
          executable: process.execPath,
          argv: ['-e', "if(require('node:fs').readFileSync('source.txt','utf8')!=='candidate')process.exit(1)"],
          timeout_ms: 2000, max_output_bytes: 4096,
        },
      }],
    }
    store.applyWorkflow(todo.id!, execution.id, { request_id: 'p', expected_revision: 0, command: { action: 'propose_plan', plan_id: 'p', plan } })
    store.applyWorkflow(todo.id!, execution.id, {
      request_id: 'c', expected_revision: 1, command: { action: 'confirm_plan', plan_id: 'p', digest: planDigest(plan), confirmation: 'user-plan' },
    })
    const { digest, root, git_dir, common_dir } = captureCandidate(workspace)
    store.applyWorkflow(todo.id!, execution.id, {
      request_id: 'a', expected_revision: 2,
      command: { action: 'start_attempt', attempt_id: 'a', owner: 'primary', workspace: { repo: 'owner/repo', root, git_dir, common_dir, baseline: digest, machine: localMachine() } },
    })
    store.applyWorkflow(todo.id!, execution.id, {
      request_id: 'y', expected_revision: 3,
      command: { action: 'yield', actor: 'primary', candidate: { digest, root, git_dir, common_dir }, observed_operations: [], note: 'Stopped writes.' },
    })
    const checked = await runCheck({
      directory, todo_id: todo.id!, execution_id: execution.id, request_id: 'check',
      operation_id: 'check', acceptance_id: 'test', actor: 'runner', expected_revision: 4,
    })
    expect(checked.outcome, JSON.stringify(checked.receipt)).toBe('passed')
    const completion: LinkedClosure = {
      execution_id: execution.id, closure_id: 'linked-close', mode: 'verified',
      expected_revision: store.get(0)!.executions[0]!.workflow!.revision,
      acknowledged_gaps: [], decision: 'user-close-issue-and-task', note: 'Linked issue delivery',
    }
    return { directory, store, todoId: todo.id!, workspace, completion }
  }

  it('refuses a missing required delivery before linked Issue effects even when gaps are acknowledged', async () => {
    const { store, todoId, completion, workspace } = await managedFixture()
    const state = () => store.get(0)!.executions[0]!.workflow!
    const original = state()
    const plan: WorkflowPlanInput = {
      ...original.plans[0]!.content,
      acceptance: [...original.plans[0]!.content.acceptance, {
        id: 'review', description: 'Inspect report content', required: true, kind: 'manual', independent: false,
      }],
      deliverables: [{
        id: 'report', description: 'Required file', required: true, acceptance_ids: ['review'],
        target: { kind: 'file', path: 'report.md' },
      }],
    }
    const send = (request_id: string, command: WorkflowRequest['command']) => store.applyWorkflow(todoId, completion.execution_id, {
      request_id, expected_revision: state().revision, command,
    })
    send('delivery-plan', { action: 'propose_plan', plan_id: 'delivery', plan })
    send('delivery-confirm', { action: 'confirm_plan', plan_id: 'delivery', digest: planDigest(plan), confirmation: 'fixture:exact-file-delivery' })
    send('delivery-bind', { action: 'start_attempt', attempt_id: 'delivery', owner: 'primary', workspace: original.attempts[0]!.workspace })
    const { digest, root, git_dir, common_dir } = captureCandidate(workspace)
    send('delivery-yield', { action: 'yield', actor: 'primary', candidate: { digest, root, git_dir, common_dir },
      observed_operations: [], note: 'New attempt settled' })
    for (const mode of ['verified', 'with_gaps'] as const) {
      const result = await publicClose({ todo_item: todoId, comment: 'Must not post', completion: {
        ...completion, closure_id: `delivery-${mode}`, expected_revision: state().revision, mode,
        acknowledged_gaps: ['delivery:report', 'acceptance:review', 'acceptance:test'],
      } })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.structuredContent)).toContain('delivery:report')
    }
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(github.createComment).not.toHaveBeenCalled()
    expect(store.get(0)!.status).toBe('active')
    expect(state().closure).toBeNull()
  }, 30_000)

  function recoveryFor(fixture: Awaited<ReturnType<typeof managedFixture>>, requestId = 'continue-locally') {
    return {
      action: 'reconcile-close', repo: 'owner/repo', data_root: join(home, '.contribbot'),
      todo_id: fixture.todoId, execution_id: fixture.completion.execution_id, closure_id: fixture.completion.closure_id,
      request_id: requestId, expected_revision: fixture.store.get(0)!.executions[0]!.workflow!.revision, actor: 'primary',
      decision: 'fixture:user-keep-issue-closed-and-continue-local-work',
      report: {
        source: 'host_report', actor: 'fixture-controller', locator: 'fixture:owned-github-callback',
        observed_at: new Date().toISOString(), reviewed_candidate: captureCandidate(fixture.workspace).digest,
        raw: 'The awaited fake GitHub callback returned; all file writes were synchronous and made by this fixture.',
        quiescence_basis: 'The fixture owns every callback and created no other writers or background tasks.',
        changes_review: 'Read and retained the fixture change in kept.txt.', unresolved: [] as string[],
      },
    }
  }

  function requestControl(fixture: Awaited<ReturnType<typeof managedFixture>>, kind: 'pause' | 'cancel') {
    const state = fixture.store.get(0)!.executions[0]!.workflow!
    fixture.store.applyWorkflow(fixture.todoId, fixture.completion.execution_id, {
      request_id: kind, expected_revision: state.revision,
      command: { action: 'request_control', control_id: kind, kind,
        decision: `user:${kind}`, note: 'Retain remote facts; settle the explicit local stop after accounting.' },
    })
  }

  const requestCancellation = (fixture: Awaited<ReturnType<typeof managedFixture>>) => requestControl(fixture, 'cancel')

  async function cancelledBeforeDispatch(kind: 'pause' | 'cancel' = 'cancel') {
    const fixture = await managedFixture()
    github.getIssueComments.mockImplementationOnce(async () => { requestControl(fixture, kind); return [] })
    await expect(issueClose(42, 'Finishing', fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(/control/i)
    return fixture
  }

  function cancellationFor(fixture: Awaited<ReturnType<typeof managedFixture>>) {
    return { ...recoveryFor(fixture, 'cancel-original-close'), control_id: 'cancel', decision: 'user:cancel' }
  }

  function pauseFor(fixture: Awaited<ReturnType<typeof managedFixture>>) {
    return { ...recoveryFor(fixture, 'pause-original-close'), control_id: 'pause', decision: 'user:pause' }
  }

  it.each(['before-dispatch', 'after-comment', 'after-close'] as const)(
    'settles explicit pause %s and resumes without redispatching the original Issue close', async timing => {
      const fixture = await managedFixture()
      if (timing === 'before-dispatch') github.getIssueComments.mockImplementationOnce(async () => {
        requestControl(fixture, 'pause')
        return []
      })
      if (timing === 'after-comment') github.createComment.mockImplementationOnce(async () => {
        requestControl(fixture, 'pause')
        return { id: 800, body: 'Finishing' }
      })
      if (timing === 'after-close') github.closeIssue.mockImplementationOnce(async () => {
        requestControl(fixture, 'pause')
        return { state: 'closed' }
      })
      await expect(issueClose(42, 'Finishing', fixture.todoId, 'owner/repo', fixture.completion))
        .rejects.toThrow(/control|pause/i)
      const state = () => fixture.store.get(0)!.executions[0]!.workflow!
      const before = state()
      github.getIssue.mockResolvedValue({ state: timing === 'after-close' ? 'closed' : 'open' })
      const input = pauseFor(fixture)
      const result = await runLocalCommand(input)
      expect(result.verification).toBe('not_verified')
      expect(state().closing_id).toBeNull()
      expect(state().control?.active_id).toBe('pause')
      expect(state().epoch).toBeGreaterThan(before.epoch)
      expect(state().yield).toBeNull()
      expect(state().checks).toEqual(before.checks)
      expect(state().closure).toBeNull()
      expect(fixture.store.get(0)!.status).toBe('active')
      const artifacts = new ExecutionArtifacts(fixture.directory, fixture.completion.execution_id)
      expect(artifacts.get(result.reconciliation_receipt as string)).toMatchObject({
        version: 3, control: { kind: 'pause' }, remote: { kind: 'pause_observation' },
      })
      expect(JSON.stringify(result.limitations)).toMatch(/settle-pause/i)
      const common = { repo: 'owner/repo', data_root: join(home, '.contribbot'),
        todo_id: fixture.todoId, execution_id: fixture.completion.execution_id, actor: 'primary', control_id: 'pause' }
      await expect(runLocalCommand({ action: 'settle-pause', ...common, request_id: 'no-yield',
        expected_revision: state().revision })).rejects.toThrow(/yield/i)
      const { control_id: _control, ...yieldIdentity } = common
      await runLocalCommand({ action: 'yield', ...yieldIdentity, request_id: 'pause-yield',
        expected_revision: state().revision, observed_operations: ['check'], note: 'Fixture callbacks all returned.' })
      await runLocalCommand({ action: 'settle-pause', ...common, request_id: 'settle',
        expected_revision: state().revision })
      expect(fixture.store.get(0)!.status).toBe('paused')
      const pausedEpoch = state().epoch
      const reads = github.getIssue.mock.calls.length
      await runLocalCommand({ action: 'continue', ...common, request_id: 'continue',
        expected_revision: state().revision, decision: 'user:continue-work-only' })
      expect(fixture.store.get(0)!.status).toBe('active')
      expect(fixture.store.get(0)!.executions).toHaveLength(1)
      expect(state().attempt_id).toBe(before.attempt_id)
      expect(state().epoch).toBeGreaterThan(pausedEpoch)
      expect(state().yield).toBeNull()
      expect(state().checks).toEqual(before.checks)
      await runLocalCommand(input)
      await expect(issueClose(42, 'Finishing', fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow()
      expect(github.getIssue).toHaveBeenCalledTimes(reads)
      await runLocalCommand({ action: 'yield', ...yieldIdentity, request_id: 'continue-yield',
        expected_revision: state().revision, observed_operations: ['check'], note: 'Resumed fixture remains idle.' })
      expect(() => prepareClosure({ directory: fixture.directory, todo_id: fixture.todoId, ...fixture.completion,
        closure_id: 'new-local-close', expected_revision: state().revision, target: { kind: 'local' },
      })).toThrow(/acceptance|gap/i)
      expect(state().closing_id).toBeNull()
      expect(state().closure).toBeNull()
      expect(fixture.store.listArchived()).toEqual([])
      expect(github.createComment).toHaveBeenCalledTimes(timing === 'before-dispatch' ? 0 : 1)
      expect(github.closeIssue).toHaveBeenCalledTimes(timing === 'after-close' ? 1 : 0)
    }, 40_000,
  )

  it.each([
    ['open', 'file'], ['closed', 'file'], ['open', 'dispatch'], ['closed', 'dispatch'],
  ])('does not recreate lost provenance on public retry when Issue readback is %s and %s is missing', async (remoteState, missing) => {
    const fixture = await managedFixture()
    github.closeIssue.mockRejectedValueOnce(new Error('Unknown original request'))
    await expect(issueClose(42, undefined, fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(/Unknown/)
    const path = journals.issueCloseReceiptPath(fixture.directory, 'owner', 'repo', 42, fixture.todoId, fixture.completion.execution_id)
    if (missing === 'file') rmSync(path)
    else {
      const receipt = JSON.parse(readFileSync(path, 'utf8'))
      delete receipt.dispatch
      writeFileSync(path, JSON.stringify(receipt))
    }
    const original = existsSync(path) ? readFileSync(path, 'utf8') : null
    github.getIssue.mockResolvedValue({ state: remoteState })
    const before = fixture.store.list()
    const reads = github.getIssue.mock.calls.length
    await expect(issueClose(42, undefined, fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(/provenance|journal/i)
    expect(existsSync(path) ? readFileSync(path, 'utf8') : null).toBe(original)
    expect(fixture.store.list()).toEqual(before)
    expect(github.getIssue).toHaveBeenCalledTimes(reads)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
  }, 25_000)

  it('retains uncertainty after interruption between preparation and initial journal publication', async () => {
    const fixture = await managedFixture()
    const fault = vi.spyOn(journals, 'writeIssueCloseReceipt').mockImplementationOnce(() => {
      throw new Error('fixture: initial publication failed')
    })
    await expect(issueClose(42, undefined, fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(/publication failed/)
    fault.mockRestore()
    const before = fixture.store.list()
    await expect(issueClose(42, undefined, fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(/provenance/i)
    expect(fixture.store.list()).toEqual(before)
    expect(github.getIssue).not.toHaveBeenCalled()
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(github.createComment).not.toHaveBeenCalled()
  }, 25_000)

  it('does not turn a visible comment marker into a returned original request result', async () => {
    const fixture = await managedFixture()
    github.createComment.mockRejectedValueOnce(new Error('Unknown comment response'))
    await expect(issueClose(42, 'Finishing', fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(/Unknown/)
    github.getIssueComments.mockResolvedValue([{ id: 800, body: github.createComment.mock.calls[0]![3] }])
    const reads = github.getIssueComments.mock.calls.length
    await expect(issueClose(42, 'Finishing', fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(/unknown/i)
    expect(github.getIssueComments).toHaveBeenCalledTimes(reads)
    expect(github.createComment).toHaveBeenCalledTimes(1)
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(fixture.store.get(0)!.executions[0]!.workflow!.closing_id).toBe(fixture.completion.closure_id)
  }, 25_000)

  it('recovers a saved successful comment without requiring its marker to remain visible', async () => {
    const fixture = await managedFixture()
    const write = journals.writeIssueCloseReceipt
    const fault = vi.spyOn(journals, 'writeIssueCloseReceipt').mockImplementation((path, receipt) => {
      if (receipt.dispatch?.effects.some(effect => effect.kind === 'close')) throw new Error('fixture: close admission not saved')
      return write(path, receipt)
    })
    await expect(issueClose(42, 'Finishing', fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(/not saved/)
    fault.mockRestore()
    expect(github.createComment).toHaveBeenCalledTimes(1)
    expect(github.closeIssue).not.toHaveBeenCalled()
    github.getIssueComments.mockResolvedValue([])
    github.closeIssue.mockImplementationOnce(async () => { requestCancellation(fixture); return { state: 'closed' } })
    await expect(issueClose(42, 'Finishing', fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(/control|cancel/i)
    expect(github.createComment).toHaveBeenCalledTimes(1)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    await runLocalCommand(cancellationFor(fixture))
    expect(fixture.store.get(0)!.status).toBe('active')
  }, 30_000)

  it.each([false, true])('does not launder a new unknown admission through normal continuation (journal removed: %s)', async removed => {
    const fixture = await managedFixture()
    github.closeIssue.mockRejectedValueOnce(new Error('Unknown admitted request'))
    await expect(issueClose(42, undefined, fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(/Unknown/)
    if (removed) rmSync(journals.issueCloseReceiptPath(fixture.directory, 'owner', 'repo', 42, fixture.todoId, fixture.completion.execution_id))
    github.getIssue.mockResolvedValue({ state: 'closed' })
    const before = fixture.store.list()
    await expect(runLocalCommand(recoveryFor(fixture))).rejects.toThrow(/unknown|unresolved|provenance/i)
    expect(fixture.store.list()).toEqual(before)
    requestCancellation(fixture)
    await expect(runLocalCommand(cancellationFor(fixture))).rejects.toThrow(/unknown|unresolved|provenance/i)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(fixture.store.get(0)!.executions[0]!.workflow!.closing_id).toBe(fixture.completion.closure_id)
  }, 25_000)

  it.each((['cancel', 'pause'] as const).flatMap(control =>
    (['missing', 'legacy-open', 'legacy-closed', 'unknown-admission'] as const).map(kind => [control, kind] as const)))(
    'retains %s when original dispatch provenance is %s', async (control, kind) => {
      const fixture = kind === 'unknown-admission' ? await managedFixture() : await cancelledBeforeDispatch(control)
      if (kind === 'unknown-admission') {
        github.closeIssue.mockRejectedValueOnce(new Error('Unknown remote result'))
        await expect(issueClose(42, undefined, fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(/Unknown/)
        requestControl(fixture, control)
      }
      const path = journals.issueCloseReceiptPath(fixture.directory, 'owner', 'repo', 42, fixture.todoId, fixture.completion.execution_id)
      if (kind === 'missing') rmSync(path)
      else if (kind.startsWith('legacy')) {
        const value = JSON.parse(readFileSync(path, 'utf8'))
        delete value.dispatch
        if (kind === 'legacy-closed') {
          value.state = 'closed'
          value.remoteClosedAt = new Date().toISOString()
        }
        writeFileSync(path, JSON.stringify(value))
      }
      github.getIssue.mockResolvedValue({ state: 'closed' })
      const before = fixture.store.list()
      await expect(runLocalCommand(control === 'pause' ? pauseFor(fixture) : cancellationFor(fixture))).rejects.toThrow(/unknown|provenance/i)
      expect(fixture.store.list()).toEqual(before)
      expect(fixture.store.listArchived()).toEqual([])
      expect(github.closeIssue).toHaveBeenCalledTimes(kind === 'unknown-admission' ? 1 : 0)
      expect(github.createComment).not.toHaveBeenCalled()
      const context = await runLocalCommand({
        action: 'context', repo: 'owner/repo', data_root: join(home, '.contribbot'), todo_id: fixture.todoId,
      })
      expect(context.issue_close_accounting).toBeTruthy()
    }, 25_000,
  )

  it.each(['cancel', 'pause'] as const)('rejects wrong %s identities, decisions, reports, revision and machine without releasing the reservation', async control => {
    const fixture = await cancelledBeforeDispatch(control)
    const input = control === 'pause' ? pauseFor(fixture) : cancellationFor(fixture)
    github.getIssue.mockResolvedValue({ state: 'closed' })
    const before = fixture.store.list()
    const reads = github.getIssue.mock.calls.length
    for (const patch of [
      { control_id: 'another' }, { control_id: undefined }, { decision: 'user:complete' }, { actor: 'other' },
      { expected_revision: input.expected_revision - 1 }, { closure_id: 'other' }, { execution_id: 'other' },
      { report: { ...input.report, unresolved: ['original writer still active'] } },
      { report: { ...input.report, observed_at: '2000-01-01T00:00:00.000Z' } },
      { report: { ...input.report, reviewed_candidate: '0'.repeat(64) } },
    ]) {
      await expect(runLocalCommand({ ...input, ...patch })).rejects.toThrow()
      expect(fixture.store.list()).toEqual(before)
    }
    machine.hostname = 'other-machine'
    await expect(runLocalCommand(input)).rejects.toThrow(/machine|host/i)
    expect(fixture.store.list()).toEqual(before)
    expect(github.getIssue).toHaveBeenCalledTimes(reads)
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(github.createComment).not.toHaveBeenCalled()
  }, 30_000)

  it.each((['cancel', 'pause'] as const).flatMap(control =>
    (['before-save', 'after-save'] as const).map(boundary => [control, boundary] as const)))(
    'replays %s reconciliation after interruption %s', async (control, boundary) => {
    const fixture = await cancelledBeforeDispatch(control)
    const input = control === 'pause' ? pauseFor(fixture) : cancellationFor(fixture)
    const original = TodoStore.prototype.applyWorkflow
    const fault = vi.spyOn(TodoStore.prototype, 'applyWorkflow').mockImplementation(function (this: TodoStore, ...args) {
      if ((args[2] as WorkflowRequest).command.action !== 'reconcile_closure') return original.apply(this, args)
      if (boundary === 'after-save') original.apply(this, args)
      throw new Error(`fixture: ${boundary}`)
    })
    await expect(runLocalCommand(input)).rejects.toThrow(boundary)
    fault.mockRestore()
    const artifacts = new ExecutionArtifacts(fixture.directory, input.execution_id)
    const saved = artifacts.getReceipt(JSON.stringify([input.closure_id, input.request_id]), 'closure-reconciliation')!
    const recordPath = join(fixture.directory, 'executions', input.execution_id, 'artifacts', `${saved.digest}.json`)
    const originalBytes = readFileSync(recordPath)
    expect(JSON.parse(originalBytes.toString()).version).toBe(control === 'pause' ? 3 : 2)
    const reads = github.getIssue.mock.calls.length
    const result = await runLocalCommand(input)
    expect(result.reconciliation_receipt).toBe(saved.digest)
    expect(readFileSync(recordPath)).toEqual(originalBytes)
    expect(github.getIssue).toHaveBeenCalledTimes(reads)
    await expect(runLocalCommand({ ...input, decision: 'other-decision' })).rejects.toThrow(/conflicting/i)
    const state = fixture.store.get(0)!.executions[0]!.workflow!
    expect(state.closing_id).toBeNull()
    expect(state.control?.active_id).toBe(control)
    expect(verifyClosureReconciliation(fixture.directory, fixture.todoId, input.execution_id, state, state.closings[0]!))
      .toBe(saved.digest)
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(github.createComment).not.toHaveBeenCalled()
  }, 30_000)

  it.each(['cancel', 'pause'] as const)('preserves historical closed facts during %s independently from an Issue that is now open', async control => {
    const fixture = await managedFixture()
    github.closeIssue.mockImplementationOnce(async () => { requestControl(fixture, control); return { state: 'closed' } })
    await expect(issueClose(42, undefined, fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(/control|cancel/i)
    github.getIssue.mockResolvedValue({ state: 'open' })
    github.getIssueComments.mockResolvedValue([{ id: 900, body: 'Reopened by maintainer' }])
    const result = await runLocalCommand(control === 'pause' ? pauseFor(fixture) : cancellationFor(fixture))
    const artifacts = new ExecutionArtifacts(fixture.directory, fixture.completion.execution_id)
    const record = artifacts.get(result.reconciliation_receipt as string) as {
      historical_receipt: string; remote: { receipt: string }
    }
    expect(artifacts.get(record.historical_receipt)).toMatchObject({ state: 'closed' })
    expect(artifacts.get(record.remote.receipt)).toMatchObject({ state: 'open', comments: [{ id: 900, body: 'Reopened by maintainer' }] })
    expect(fixture.store.get(0)!.status).toBe('active')
    expect(fixture.store.listArchived()).toEqual([])
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(github.createComment).not.toHaveBeenCalled()
  }, 25_000)

  it.each(['admission', 'response'] as const)('retains the correct Issue effect facts when %s persistence fails', async boundary => {
    const fixture = await managedFixture()
    const write = journals.writeIssueCloseReceipt
    const fault = vi.spyOn(journals, 'writeIssueCloseReceipt').mockImplementation((path, receipt) => {
      if (receipt.dispatch?.effects.some(effect => boundary === 'admission' ? !effect.result : effect.result)) {
        throw new Error(`fixture: ${boundary}`)
      }
      return write(path, receipt)
    })
    await expect(issueClose(42, undefined, fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(boundary)
    fault.mockRestore()
    requestCancellation(fixture)
    if (boundary === 'admission') await runLocalCommand(cancellationFor(fixture))
    else await expect(runLocalCommand(cancellationFor(fixture))).rejects.toThrow(/unknown/i)
    expect(github.closeIssue).toHaveBeenCalledTimes(boundary === 'admission' ? 0 : 1)
    expect(github.createComment).not.toHaveBeenCalled()
    expect(fixture.store.get(0)!.status).toBe('active')
  }, 25_000)

  it.each((['cancel', 'pause'] as const).flatMap(control =>
    (['publication-failure', 'candidate-drift', 'journal-drift'] as const).map(fault => [control, fault] as const)))(
    'keeps the %s reservation on %s during receipt publication', async (control, faultKind) => {
      const fixture = await cancelledBeforeDispatch(control)
      const input = control === 'pause' ? pauseFor(fixture) : cancellationFor(fixture)
      const before = fixture.store.list()
      const put = ExecutionArtifacts.prototype.putReceipt
      const fault = vi.spyOn(ExecutionArtifacts.prototype, 'putReceipt').mockImplementation(function (this: ExecutionArtifacts, ...args) {
        if (args[2] !== 'closure-reconciliation') return put.apply(this, args)
        if (faultKind === 'publication-failure') throw new Error('fixture: publication failure')
        const digest = put.apply(this, args)
        if (faultKind === 'candidate-drift') writeFileSync(join(fixture.workspace, 'later.txt'), 'concurrent write')
        else {
          const path = journals.issueCloseReceiptPath(fixture.directory, 'owner', 'repo', 42, fixture.todoId, input.execution_id)
          const value = JSON.parse(readFileSync(path, 'utf8'))
          value.startedAt = '2000-01-01T00:00:00.000Z'
          writeFileSync(path, JSON.stringify(value))
        }
        return digest
      })
      await expect(runLocalCommand(input)).rejects.toThrow(/publication|changed/i)
      fault.mockRestore()
      expect(fixture.store.list()).toEqual(before)
      expect(github.closeIssue).not.toHaveBeenCalled()
      expect(github.createComment).not.toHaveBeenCalled()
    }, 25_000,
  )

  it.each(['cancel', 'pause'] as const)('waits for an admitted publisher during %s and requires fresh accounting after its late result', async control => {
    const fixture = await managedFixture()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    github.closeIssue.mockImplementationOnce(async () => { entered(); await gate; return { state: 'closed' } })
    const publisher = issueClose(42, undefined, fixture.todoId, 'owner/repo', fixture.completion).catch(error => error)
    await started
    requestControl(fixture, control)
    let settled = false
    const recovery = runLocalCommand(control === 'pause' ? pauseFor(fixture) : cancellationFor(fixture)).then(
      result => { settled = true; return result }, error => { settled = true; return error },
    )
    await new Promise(resolve => setTimeout(resolve, 75))
    expect(settled).toBe(false)
    expect(fixture.store.get(0)!.executions[0]!.workflow!.closing_id).toBe(fixture.completion.closure_id)
    release()
    expect(await publisher).toBeInstanceOf(Error)
    expect(await recovery).toBeInstanceOf(Error)
    const path = journals.issueCloseReceiptPath(fixture.directory, 'owner', 'repo', 42, fixture.todoId, fixture.completion.execution_id)
    expect(JSON.parse(readFileSync(path, 'utf8')).dispatch.effects[0]).toMatchObject({
      kind: 'close', result: { kind: 'close', state: 'closed' },
    })
    await runLocalCommand(control === 'pause' ? pauseFor(fixture) : cancellationFor(fixture))
    expect(fixture.store.get(0)!.status).toBe('active')
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(github.createComment).not.toHaveBeenCalled()
  }, 30_000)

  it.each(['settle-pause', 'continue'] as const)('requires intact pause reconciliation evidence before %s', async action => {
    const fixture = await cancelledBeforeDispatch('pause')
    const result = await runLocalCommand(pauseFor(fixture))
    const state = () => fixture.store.get(0)!.executions[0]!.workflow!
    const identity = { repo: 'owner/repo', data_root: join(home, '.contribbot'),
      todo_id: fixture.todoId, execution_id: fixture.completion.execution_id, actor: 'primary' }
    await runLocalCommand({ action: 'yield', ...identity, request_id: 'fresh-yield',
      expected_revision: state().revision, observed_operations: ['check'], note: 'Original calls all returned.' })
    if (action === 'continue') await runLocalCommand({ action: 'settle-pause', ...identity,
      control_id: 'pause', request_id: 'settled', expected_revision: state().revision })
    const path = join(fixture.directory, 'executions', fixture.completion.execution_id,
      'artifacts', `${result.reconciliation_receipt}.json`)
    const original = readFileSync(path)
    rmSync(path)
    const before = fixture.store.list()
    const input = { action, ...identity, control_id: 'pause', request_id: 'control',
      expected_revision: state().revision, ...(action === 'continue' ? { decision: 'user:continue-work-only' } : {}) }
    await expect(runLocalCommand(input)).rejects.toThrow(/accounting/i)
    expect(fixture.store.list()).toEqual(before)
    writeFileSync(path, original)
    await runLocalCommand(input)
    expect(fixture.store.get(0)!.status).toBe(action === 'continue' ? 'active' : 'paused')
    expect(fixture.store.listArchived()).toEqual([])
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(github.createComment).not.toHaveBeenCalled()
  }, 30_000)

  it('refuses a superseded pause record and reconciles only the later explicit cancellation', async () => {
    const fixture = await cancelledBeforeDispatch('pause')
    const input = pauseFor(fixture)
    github.getIssueComments.mockImplementationOnce(async () => {
      requestCancellation(fixture)
      return []
    })
    await expect(runLocalCommand(input)).rejects.toThrow(/changed/i)
    const state = () => fixture.store.get(0)!.executions[0]!.workflow!
    expect(state().closing_id).toBe(fixture.completion.closure_id)
    expect(state().control?.active_id).toBe('cancel')
    await expect(runLocalCommand({ ...input, expected_revision: state().revision })).rejects.toThrow(/control/i)
    await runLocalCommand(cancellationFor(fixture))
    expect(state().closing_id).toBeNull()
    expect(state().control?.active_id).toBe('cancel')
    expect(fixture.store.get(0)!.status).toBe('active')
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(github.createComment).not.toHaveBeenCalled()
  }, 30_000)

  it('keeps a newer explicit Issue close when replaying an old pause after continuation', async () => {
    const fixture = await cancelledBeforeDispatch('pause')
    const input = pauseFor(fixture)
    await runLocalCommand(input)
    const state = () => fixture.store.get(0)!.executions[0]!.workflow!
    const identity = { repo: 'owner/repo', data_root: join(home, '.contribbot'),
      todo_id: fixture.todoId, execution_id: fixture.completion.execution_id, actor: 'primary' }
    await runLocalCommand({ action: 'yield', ...identity, request_id: 'pause-yield', expected_revision: state().revision,
      observed_operations: ['check'], note: 'Fixture is idle.' })
    await runLocalCommand({ action: 'settle-pause', ...identity, request_id: 'settle', control_id: 'pause',
      expected_revision: state().revision })
    await runLocalCommand({ action: 'continue', ...identity, request_id: 'continue', control_id: 'pause',
      expected_revision: state().revision, decision: 'user:continue-work-only' })
    expect(github.closeIssue).not.toHaveBeenCalled()
    await runLocalCommand({ action: 'yield', ...identity, request_id: 'new-yield', expected_revision: state().revision,
      observed_operations: ['check'], note: 'Resumed fixture is idle.' })
    github.closeIssue.mockRejectedValueOnce(new Error('fixture: new close response unknown'))
    await expect(issueClose(42, undefined, fixture.todoId, 'owner/repo', {
      ...fixture.completion, closure_id: 'explicit-new-close', expected_revision: state().revision,
      mode: 'with_gaps', acknowledged_gaps: ['acceptance:test'], decision: 'user:new-close-with-test-gap',
    })).rejects.toThrow(/new close response unknown/)
    const path = journals.issueCloseReceiptPath(fixture.directory, 'owner', 'repo', 42, fixture.todoId, input.execution_id)
    const before = readFileSync(path)
    await runLocalCommand(input)
    expect(readFileSync(path)).toEqual(before)
    expect(state().closing_id).toBe('explicit-new-close')
    expect(fixture.store.get(0)!.status).toBe('active')
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(github.createComment).not.toHaveBeenCalled()
  }, 40_000)

  it('requires intact cancellation-specific evidence at stopped finalization', async () => {
    const fixture = await cancelledBeforeDispatch()
    const recovery = await runLocalCommand(cancellationFor(fixture))
    const state = () => fixture.store.get(0)!.executions[0]!.workflow!
    await runLocalCommand({
      action: 'yield', repo: 'owner/repo', data_root: join(home, '.contribbot'), todo_id: fixture.todoId,
      execution_id: fixture.completion.execution_id, request_id: 'cancel-yield', expected_revision: state().revision,
      actor: 'primary', observed_operations: ['check'], note: 'Fixture callbacks settled.',
    })
    const finish = { directory: fixture.directory, todo_id: fixture.todoId, ...fixture.completion,
      closure_id: 'local-stop', expected_revision: state().revision, mode: 'stopped' as const,
      decision: 'user:cancel', target: { kind: 'local' as const } }
    prepareClosure(finish)
    const path = join(fixture.directory, 'executions', fixture.completion.execution_id,
      'artifacts', `${recovery.reconciliation_receipt}.json`)
    const original = readFileSync(path)
    rmSync(path)
    expect(() => finalizeClosure(finish)).toThrow(/accounting/i)
    expect(fixture.store.get(0)!.status).toBe('active')
    writeFileSync(path, original)
    expect(finalizeClosure(finish).status).toBe('cancelled')
    expect(fixture.store.listArchived()).toEqual([])
  }, 30_000)

  it.each(['before-dispatch', 'after-comment', 'after-close'] as const)(
    'settles explicit cancellation %s without completing, archiving or repeating Issue effects', async timing => {
      const fixture = await managedFixture()
      if (timing === 'before-dispatch') github.getIssueComments.mockImplementationOnce(async () => {
        requestCancellation(fixture)
        return []
      })
      if (timing === 'after-comment') github.createComment.mockImplementationOnce(async () => {
        requestCancellation(fixture)
        return { id: 800, body: 'Finishing' }
      })
      if (timing === 'after-close') github.closeIssue.mockImplementationOnce(async () => {
        requestCancellation(fixture)
        return { state: 'closed' }
      })
      await expect(issueClose(42, 'Finishing', fixture.todoId, 'owner/repo', fixture.completion))
        .rejects.toThrow(/control|stop|cancel/i)
      const state = () => fixture.store.get(0)!.executions[0]!.workflow!
      const before = state()
      github.getIssue.mockResolvedValue({ state: timing === 'after-close' ? 'closed' : 'open' })
      const recovery = { ...recoveryFor(fixture, 'cancel-original-close'), control_id: 'cancel', decision: 'user:cancel' }
      const result = await runLocalCommand(recovery)
      expect(result.verification).toBe('not_verified')
      expect(state().closing_id).toBeNull()
      expect(state().control?.active_id).toBe('cancel')
      expect(state().closure).toBeNull()
      expect(state().checks).toEqual(before.checks)
      expect(state().yield).toBeNull()
      expect(fixture.store.get(0)!.status).toBe('active')
      await runLocalCommand(recovery)
      await expect(issueClose(42, 'Finishing', fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow()
      await runLocalCommand({
        action: 'yield', repo: 'owner/repo', data_root: join(home, '.contribbot'), todo_id: fixture.todoId,
        execution_id: fixture.completion.execution_id, request_id: 'cancel-yield', expected_revision: state().revision,
        actor: 'primary', observed_operations: ['check'], note: 'Original callbacks and all writers accounted for.',
      })
      const finish = {
        action: 'close', repo: 'owner/repo', data_root: join(home, '.contribbot'), todo_id: fixture.todoId,
        ...fixture.completion, closure_id: 'cancel-local', expected_revision: state().revision,
        mode: 'stopped', decision: 'user:cancel', target: { kind: 'local' },
      }
      await runLocalCommand(finish)
      expect(fixture.store.get(0)!.status).toBe('cancelled')
      expect(fixture.store.listArchived()).toEqual([])
      expect(state().closure?.mode).toBe('stopped')
      await runLocalCommand(finish)
      await runLocalCommand(recovery)
      expect(github.createComment).toHaveBeenCalledTimes(timing === 'before-dispatch' ? 0 : 1)
      expect(github.closeIssue).toHaveBeenCalledTimes(timing === 'after-close' ? 1 : 0)
    }, 30_000,
  )

  it.each(['before-comment', 'during-close'])('preserves stop intent and remote facts when it arrives %s', async timing => {
    const fixture = await managedFixture()
    const stop = () => {
      const state = fixture.store.get(0)!.executions[0]!.workflow!
      fixture.store.applyWorkflow(fixture.todoId, fixture.completion.execution_id, {
        request_id: 'cancel', expected_revision: state.revision,
        command: { action: 'request_control', control_id: 'cancel', kind: 'cancel',
          decision: 'user:cancel', note: 'Stop local work; do not invent a remote outcome.' },
      })
    }
    if (timing === 'before-comment') github.getIssueComments.mockImplementation(async () => { stop(); return [] })
    else github.closeIssue.mockImplementation(async () => { stop(); return { state: 'closed' } })
    await expect(issueClose(42, timing === 'before-comment' ? 'Finishing' : undefined, fixture.todoId, 'owner/repo', fixture.completion))
      .rejects.toThrow(/control|stop|cancel/i)
    const state = fixture.store.get(0)!.executions[0]!.workflow!
    expect(state.control?.active_id).toBe('cancel')
    expect(state.closure).toBeNull()
    expect(state.closing_id).toBe(fixture.completion.closure_id)
    expect(fixture.store.listArchived()).toEqual([])
    expect(github.createComment).not.toHaveBeenCalled()
    expect(github.closeIssue).toHaveBeenCalledTimes(timing === 'during-close' ? 1 : 0)
    if (timing === 'during-close') expect(state.closings[0]?.remote_receipt).toBeTruthy()
  }, 30_000)

  async function driftedFixture() {
    const fixture = await managedFixture()
    github.closeIssue.mockImplementation(async () => {
      writeFileSync(join(fixture.workspace, 'kept.txt'), 'kept')
      return { state: 'closed' }
    })
    await expect(issueClose(42, undefined, fixture.todoId, 'owner/repo', fixture.completion))
      .rejects.toThrow(/closed successfully.*candidate/is)
    return fixture
  }

  it('retains genuine pre-ledger continuation history without rewriting its immutable version 1 record', async () => {
    const fixture = await driftedFixture()
    const todos = fixture.store.list()
    const closing = todos[0]!.executions[0]!.workflow!.closings[0]!
    delete closing.issue_dispatch
    closing.remote_receipt = null
    writeFileSync(join(fixture.directory, 'todos.yaml'), stringify({ todos }))
    const path = journals.issueCloseReceiptPath(fixture.directory, 'owner', 'repo', 42, fixture.todoId, fixture.completion.execution_id)
    const journal = JSON.parse(readFileSync(path, 'utf8'))
    delete journal.dispatch
    writeFileSync(path, JSON.stringify(journal))
    const request = recoveryFor(fixture)
    const result = await runLocalCommand(request)
    const artifactPath = join(fixture.directory, 'executions', fixture.completion.execution_id,
      'artifacts', `${result.reconciliation_receipt}.json`)
    const original = readFileSync(artifactPath)
    const record = JSON.parse(original.toString())
    expect(record.version).toBe(1)
    expect(record.original).not.toHaveProperty('issue_dispatch')
    expect(record.journal).not.toHaveProperty('dispatch')
    expect((await runLocalCommand(request)).reconciliation_receipt).toBe(result.reconciliation_receipt)
    expect(readFileSync(artifactPath)).toEqual(original)
    requestControl(fixture, 'pause')
    const paused = fixture.store.list()
    expect((await runLocalCommand(request)).reconciliation_receipt).toBe(result.reconciliation_receipt)
    expect(fixture.store.list()).toEqual(paused)
    expect(readFileSync(artifactPath)).toEqual(original)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
  }, 25_000)

  it('reads unchanged v2 cancellation history after explicitly continuing and later requesting pause', async () => {
    const fixture = await cancelledBeforeDispatch()
    const input = cancellationFor(fixture)
    const result = await runLocalCommand(input)
    const path = join(fixture.directory, 'executions', fixture.completion.execution_id,
      'artifacts', `${result.reconciliation_receipt}.json`)
    const bytes = readFileSync(path)
    expect(JSON.parse(bytes.toString())).toMatchObject({ version: 2, control: { kind: 'cancel' } })
    await runLocalCommand({ action: 'continue', repo: 'owner/repo', data_root: join(home, '.contribbot'),
      todo_id: fixture.todoId, execution_id: fixture.completion.execution_id, actor: 'primary',
      request_id: 'continue-cancel', control_id: 'cancel', decision: 'user:withdraw-cancel-and-continue',
      expected_revision: fixture.store.get(0)!.executions[0]!.workflow!.revision })
    requestControl(fixture, 'pause')
    const before = fixture.store.list()
    const reads = github.getIssue.mock.calls.length
    expect((await runLocalCommand(input)).reconciliation_receipt).toBe(result.reconciliation_receipt)
    expect(fixture.store.list()).toEqual(before)
    expect(readFileSync(path)).toEqual(bytes)
    expect(github.getIssue).toHaveBeenCalledTimes(reads)
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(github.createComment).not.toHaveBeenCalled()
  }, 30_000)

  it.each(['before-prepare', 'before-finalize'] as const)(
    'does not waive missing original-operation accounting during stopped closure %s', async boundary => {
      const fixture = await driftedFixture()
      const recovery = await runLocalCommand(recoveryFor(fixture))
      requestCancellation(fixture)
      const state = () => fixture.store.get(0)!.executions[0]!.workflow!
      await runLocalCommand({
        action: 'yield', repo: 'owner/repo', data_root: join(home, '.contribbot'), todo_id: fixture.todoId,
        execution_id: fixture.completion.execution_id, request_id: 'cancel-yield', expected_revision: state().revision,
        actor: 'primary', observed_operations: ['check'], note: 'All original callbacks accounted for.',
      })
      const finish = {
        directory: fixture.directory, todo_id: fixture.todoId, ...fixture.completion,
        closure_id: 'cancel-local', expected_revision: state().revision,
        mode: 'stopped' as const, decision: 'user:cancel', target: { kind: 'local' as const },
      }
      if (boundary === 'before-finalize') prepareClosure(finish)
      const artifact = join(fixture.directory, 'executions', fixture.completion.execution_id,
        'artifacts', `${recovery.reconciliation_receipt}.json`)
      rmSync(artifact)
      expect(() => boundary === 'before-prepare' ? closeManaged(finish) : finalizeClosure(finish))
        .toThrow(/accounting|closure-reconciliation/i)
      expect(fixture.store.get(0)!.status).toBe('active')
      expect(fixture.store.listArchived()).toEqual([])
      expect(state().closure).toBeNull()
    }, 30_000,
  )

  it('rejects a reopened managed Todo before legacy Issue effects without a new execution', async () => {
    const fixture = await managedFixture()
    requestCancellation(fixture)
    closeManaged({
      ...fixture.completion, directory: fixture.directory, todo_id: fixture.todoId,
      expected_revision: fixture.store.get(0)!.executions[0]!.workflow!.revision,
      mode: 'stopped', decision: 'user:cancel', target: { kind: 'local' },
    })
    fixture.store.reopen(fixture.todoId)
    const before = fixture.store.list()
    await expect(issueClose(42, 'Do not post', fixture.todoId, 'owner/repo')).rejects.toThrow(/managed/i)
    expect(github.getIssue).not.toHaveBeenCalled()
    expect(github.getIssueComments).not.toHaveBeenCalled()
    expect(github.createComment).not.toHaveBeenCalled()
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(fixture.store.list()).toEqual(before)
  }, 20_000)

  it('rejects stage-only whole-task completion before any Issue request or local reservation', async () => {
    const { store, todoId, completion } = await managedFixture('stage')
    const before = store.list()
    for (const mode of ['verified', 'with_gaps'] as const) {
      const result = await publicClose({ todo_item: todoId, completion: { ...completion, mode }, comment: 'Must not post' })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).toMatch(/stage|coverage/i)
    }
    expect(github.getIssue).not.toHaveBeenCalled()
    expect(github.getIssueComments).not.toHaveBeenCalled()
    expect(github.createComment).not.toHaveBeenCalled()
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(store.list()).toEqual(before)
  }, 20_000)

  it('recovers a historical undeclared prepared closure without repeating remote effects', async () => {
    const { directory, store, todoId, workspace, completion } = await managedFixture()
    github.closeIssue.mockImplementation(async () => {
      writeFileSync(join(workspace, 'interruption.txt'), 'Fixture interruption')
      return { state: 'closed' }
    })
    await expect(issueClose(42, 'Finish', todoId, 'owner/repo', completion)).rejects.toThrow(/closed successfully.*candidate/is)
    const todos = store.list()
    const plan = todos[0]!.executions[0]!.workflow!.plans[0]!
    delete plan.content.completion_scope
    delete plan.content.remaining_scope
    plan.digest = planDigest(plan.content)
    writeFileSync(join(directory, 'todos.yaml'), stringify({ todos }))
    rmSync(join(workspace, 'interruption.txt'))
    await issueClose(42, 'Finish', todoId, 'owner/repo', completion)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(github.createComment).toHaveBeenCalledTimes(1)
    expect(store.get(0)!.status).toBe('done')
    expect(store.get(0)!.executions[0]!.workflow!.plans[0]!.content).not.toHaveProperty('completion_scope')
    expect(store.get(0)!.executions[0]!.workflow!.plans[0]!.digest).toBe(plan.digest)
    expect(store.listArchived()).toEqual([])
  }, 25_000)

  it('closes managed Todo only after preflight and preserves remote receipt across local drift', async () => {
    const { store, todoId, workspace, completion } = await managedFixture()
    github.closeIssue.mockImplementation(async () => {
      writeFileSync(join(workspace, 'later.txt'), 'unexpected external write')
      return { state: 'closed' }
    })
    await expect(issueClose(42, 'Finish', todoId, 'owner/repo', completion)).rejects.toThrow(/closed successfully.*candidate/is)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(github.createComment).toHaveBeenCalledTimes(1)
    expect(store.listArchived()).toEqual([])
    expect(store.list()[0]!.executions[0]!.workflow!.closing_id).toBe('linked-close')
    await expect(issueClose(42, 'Finish', todoId, 'owner/repo', completion)).rejects.toThrow(/candidate/i)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(github.createComment).toHaveBeenCalledTimes(1)
    rmSync(join(workspace, 'later.txt'))
    await issueClose(42, 'Finish', todoId, 'owner/repo', completion)
    expect(store.list()[0]!.executions[0]!.workflow!.closure?.mode).toBe('verified')
    expect(store.listArchived()).toEqual([])
  }, 25_000)

  it('keeps legitimate post-close files, explicitly resumes local work and requires fresh checks without repeating GitHub effects', async () => {
    const { directory, store, todoId, workspace, completion } = await managedFixture()
    github.closeIssue.mockImplementation(async () => {
      writeFileSync(join(workspace, 'kept.txt'), 'legitimate user change')
      return { state: 'closed' }
    })
    const args = { todo_item: todoId, completion, comment: 'Approved closure' }
    expect((await publicClose(args)).isError).toBe(true)
    const before = store.get(0)!.executions[0]!.workflow!
    const candidate = captureCandidate(workspace)
    const recovery = {
      action: 'reconcile-close', repo: 'owner/repo', data_root: join(home, '.contribbot'),
      todo_id: todoId, execution_id: completion.execution_id, closure_id: completion.closure_id,
      request_id: 'keep-and-continue', expected_revision: before.revision, actor: 'primary',
      decision: 'fixture:user-keep-remote-closed-and-continue-locally',
      report: {
        source: 'host_report', actor: 'fixture-controller', locator: 'fixture:owned-file-writer',
        observed_at: new Date().toISOString(), reviewed_candidate: candidate.digest,
        raw: 'The fake GitHub callback synchronously wrote kept.txt and has returned; the fixture owns all writers.',
        quiescence_basis: 'Callback has returned, no other writes or subprocesses were started.',
        changes_review: 'Inspected kept.txt and retained its actual content.', unresolved: [],
      },
    }
    const result = await runLocalCommand(recovery)
    expect(result.verification).toBe('not_verified')
    expect(readFileSync(join(workspace, 'kept.txt'), 'utf8')).toBe('legitimate user change')
    const state = () => store.get(0)!.executions[0]!.workflow!
    expect(state().closing_id).toBeNull()
    expect(state().closings[0]!.state).toBe('reconciled')
    expect(state().checks).toEqual(before.checks)
    expect(state().yield).toBeNull()
    expect(state().epoch).toBeGreaterThan(before.epoch)
    expect(store.listArchived()).toEqual([])
    const requestsBefore = github.getIssue.mock.calls.length
    expect((await publicClose(args)).isError).toBe(true)
    expect(github.getIssue).toHaveBeenCalledTimes(requestsBefore)
    await runLocalCommand(recovery)
    const after = captureCandidate(workspace)
    store.applyWorkflow(todoId, completion.execution_id, {
      request_id: 'fresh-yield', expected_revision: state().revision, command: {
        action: 'yield', actor: 'primary', observed_operations: ['check'], note: 'Fixture writers are stopped.',
        candidate: { digest: after.digest, root: after.root, git_dir: after.git_dir, common_dir: after.common_dir },
      },
    })
    const finish = { directory, todo_id: todoId, ...completion, closure_id: 'local-finish',
      expected_revision: state().revision, decision: 'fixture:user-local-completion', target: { kind: 'local' as const } }
    expect(() => closeManaged(finish)).toThrow(/acceptance|gap/i)
    const check = await runCheck({
      directory, todo_id: todoId, execution_id: completion.execution_id, request_id: 'fresh-check',
      operation_id: 'fresh-check', acceptance_id: 'test', actor: 'runner', expected_revision: state().revision,
    })
    expect(check.outcome, JSON.stringify(check.receipt)).toBe('passed')
    const artifactPath = join(directory, 'executions', completion.execution_id, 'artifacts', `${result.reconciliation_receipt}.json`)
    const originalArtifact = readFileSync(artifactPath)
    rmSync(artifactPath)
    expect(() => closeManaged({ ...finish, closure_id: 'missing-audit', expected_revision: state().revision }))
      .toThrow(/closure-reconciliation/i)
    expect(store.listArchived()).toEqual([])
    writeFileSync(artifactPath, originalArtifact)
    closeManaged({ ...finish, closure_id: 'verified-local-finish', expected_revision: state().revision })
    expect(store.list()[0]!.status).toBe('done')
    expect(store.listArchived()).toHaveLength(0)
    expect(readFileSync(join(workspace, 'kept.txt'), 'utf8')).toBe('legitimate user change')
    expect(github.createComment).toHaveBeenCalledTimes(1)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
  }, 35_000)

  it.each(['attachment', 'journal'] as const)('recovers a missing %s without comments or another public effect', async missing => {
    const fixture = await managedFixture()
    github.closeIssue.mockImplementation(async () => {
      writeFileSync(join(fixture.workspace, 'kept.txt'), 'kept')
      return { state: 'closed' }
    })
    const apply = TodoStore.prototype.applyWorkflow
    const write = journals.writeIssueCloseReceipt
    const fault = missing === 'attachment'
      ? vi.spyOn(TodoStore.prototype, 'applyWorkflow').mockImplementation(function (this: TodoStore, ...args) {
        if ((args[2] as WorkflowRequest).command.action === 'closure_remote_receipt') throw new Error('fixture: interrupted before attaching remote receipt')
        return apply.apply(this, args)
      })
      : vi.spyOn(journals, 'writeIssueCloseReceipt').mockImplementation((path, receipt) => {
        if (receipt.state === 'closed') throw new Error('fixture: interrupted before closed journal publication')
        return write(path, receipt)
      })
    await expect(issueClose(42, undefined, fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(/fixture|journal/i)
    fault.mockRestore()
    const before = fixture.store.get(0)!.executions[0]!.workflow!
    expect(before.closings[0]!.remote_receipt).toBeNull()
    github.getIssue.mockResolvedValue({ state: 'closed' })
    const reads = github.getIssue.mock.calls.length
    const result = await runLocalCommand(recoveryFor(fixture))
    const artifacts = new ExecutionArtifacts(fixture.directory, fixture.completion.execution_id)
    const record = artifacts.get(result.reconciliation_receipt as string) as { remote: { kind: string; receipt: string } }
    expect(record.remote.kind).toBe(missing === 'journal' ? 'observed_closed' : 'recorded_closed')
    expect(github.getIssue).toHaveBeenCalledTimes(reads + (missing === 'journal' ? 1 : 0))
    if (missing === 'journal') {
      expect(artifacts.get(record.remote.receipt)).toMatchObject({
        kind: 'observed_closed', source: 'github:getIssue', state: 'closed',
      })
    }
    const after = fixture.store.get(0)!.executions[0]!.workflow!
    expect(after.checks).toEqual(before.checks)
    expect(after.closure).toBeNull()
    expect(result.verification).toBe('not_verified')
    expect(github.createComment).not.toHaveBeenCalled()
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
  }, 25_000)

  it('refuses unknown remote state and incomplete, stale, wrong-owner or wrong-candidate accounting without releasing closing', async () => {
    const fixture = await driftedFixture()
    const input = recoveryFor(fixture)
    const before = fixture.store.list()
    const reads = github.getIssue.mock.calls.length
    for (const changed of [
      { actor: 'other-owner' }, { expected_revision: input.expected_revision - 1 },
      { report: { ...input.report, unresolved: ['Original HTTP request has not been accounted for.'] } },
      { report: { ...input.report, reviewed_candidate: '0'.repeat(64) } },
      { report: { ...input.report, observed_at: '2000-01-01T00:00:00.000Z' } },
      { report: { ...input.report, changes_review: undefined } },
    ]) {
      await expect(runLocalCommand({ ...input, ...changed })).rejects.toThrow()
      expect(fixture.store.list()).toEqual(before)
    }
    expect(github.getIssue).toHaveBeenCalledTimes(reads)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(github.createComment).not.toHaveBeenCalled()
  }, 25_000)

  it('does not observe a pending Issue request as closed when GitHub reports open', async () => {
    const fixture = await managedFixture()
    github.closeIssue.mockRejectedValue(new Error('fixture: connection lost, no final receipt'))
    await expect(issueClose(42, undefined, fixture.todoId, 'owner/repo', fixture.completion)).rejects.toThrow(/connection lost/)
    const before = fixture.store.list()
    await expect(runLocalCommand(recoveryFor(fixture))).rejects.toThrow(/unknown|not observed closed/i)
    expect(fixture.store.list()).toEqual(before)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(github.createComment).not.toHaveBeenCalled()
  }, 25_000)

  it.each(['before-save', 'after-save'] as const)('retries interruption %s using the same immutable record without repeating GitHub effects', async boundary => {
    const fixture = await driftedFixture()
    const input = recoveryFor(fixture)
    const original = TodoStore.prototype.applyWorkflow
    const fault = vi.spyOn(TodoStore.prototype, 'applyWorkflow').mockImplementation(function (this: TodoStore, ...args) {
      if ((args[2] as WorkflowRequest).command.action !== 'reconcile_closure') return original.apply(this, args)
      if (boundary === 'after-save') original.apply(this, args)
      throw new Error(`fixture: ${boundary}`)
    })
    await expect(runLocalCommand(input)).rejects.toThrow(boundary)
    fault.mockRestore()
    const key = JSON.stringify([input.closure_id, input.request_id])
    const artifacts = new ExecutionArtifacts(fixture.directory, input.execution_id)
    const published = artifacts.getReceipt(key, 'closure-reconciliation')!
    const journalPath = journals.issueCloseReceiptPath(fixture.directory, 'owner', 'repo', 42, fixture.todoId, input.execution_id)
    expect(existsSync(journalPath)).toBe(true)
    const reads = github.getIssue.mock.calls.length
    const result = await runLocalCommand(input)
    expect(result.reconciliation_receipt).toBe(published.digest)
    expect(existsSync(journalPath)).toBe(false)
    const state = fixture.store.get(0)!.executions[0]!.workflow!
    expect(state.closings[0]!.state).toBe('reconciled')
    expect(state.closure).toBeNull()
    expect(verifyClosureReconciliation(fixture.directory, fixture.todoId, input.execution_id, state, state.closings[0]!))
      .toBe(published.digest)
    await expect(runLocalCommand({ ...input, decision: 'another decision' })).rejects.toThrow(/conflicting/i)
    expect(github.getIssue).toHaveBeenCalledTimes(reads)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(github.createComment).not.toHaveBeenCalled()
  }, 25_000)

  it('retains closing when files change during audit publication and requires newly reviewed content', async () => {
    const fixture = await driftedFixture()
    const input = recoveryFor(fixture)
    const before = fixture.store.list()
    const original = ExecutionArtifacts.prototype.putReceipt
    const drift = vi.spyOn(ExecutionArtifacts.prototype, 'putReceipt').mockImplementation(function (this: ExecutionArtifacts, ...args) {
      const receipt = original.apply(this, args)
      if (args[2] === 'closure-reconciliation') writeFileSync(join(fixture.workspace, 'later.txt'), 'concurrent change')
      return receipt
    })
    await expect(runLocalCommand(input)).rejects.toThrow(/changed during closure reconciliation/i)
    drift.mockRestore()
    expect(fixture.store.list()).toEqual(before)
    await expect(runLocalCommand(input)).rejects.toThrow(/candidate|review/i)
    const next = recoveryFor(fixture, 'review-later-file')
    next.report.changes_review = 'Fixture controller read kept.txt and later.txt and retained both.'
    await runLocalCommand(next)
    expect(readFileSync(join(fixture.workspace, 'later.txt'), 'utf8')).toBe('concurrent change')
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
  }, 25_000)

  it('serializes reconciliation behind a live publisher and rejects the revision made stale by that publisher', async () => {
    const fixture = await managedFixture()
    let released!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { released = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    github.closeIssue.mockImplementation(async () => {
      entered()
      await gate
      writeFileSync(join(fixture.workspace, 'kept.txt'), 'kept')
      return { state: 'closed' }
    })
    const closing = issueClose(42, undefined, fixture.todoId, 'owner/repo', fixture.completion).catch(error => error)
    await started
    const input = recoveryFor(fixture)
    let settled = false
    const recovery = runLocalCommand(input).then(
      value => { settled = true; return value },
      error => { settled = true; return error as Error },
    )
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(settled).toBe(false)
    }
    finally { released() }
    expect(await closing).toBeInstanceOf(Error)
    const failure = await recovery
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/revision/)
    expect(fixture.store.get(0)!.executions[0]!.workflow!.closing_id).toBe(input.closure_id)
    await runLocalCommand(recoveryFor(fixture, 'after-publisher-returned'))
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
  }, 25_000)

  it('does not delete a newer linked closure journal when retrying an earlier successful reconciliation', async () => {
    const fixture = await driftedFixture()
    const input = recoveryFor(fixture)
    await runLocalCommand(input)
    const state = () => fixture.store.get(0)!.executions[0]!.workflow!
    const candidate = captureCandidate(fixture.workspace)
    fixture.store.applyWorkflow(fixture.todoId, input.execution_id, {
      request_id: 'new-yield', expected_revision: state().revision,
      command: { action: 'yield', actor: 'primary', observed_operations: ['check'], note: 'Fixture is idle.',
        candidate: { digest: candidate.digest, root: candidate.root, git_dir: candidate.git_dir, common_dir: candidate.common_dir } },
    })
    github.closeIssue.mockRejectedValue(new Error('fixture: later close interrupted'))
    await expect(issueClose(42, undefined, fixture.todoId, 'owner/repo', {
      ...fixture.completion, closure_id: 'new-public-intent', expected_revision: state().revision,
      mode: 'with_gaps', acknowledged_gaps: ['acceptance:test'], decision: 'fixture:explicit-new-public-request-with-gaps',
    })).rejects.toThrow(/later close interrupted/)
    const path = journals.issueCloseReceiptPath(fixture.directory, 'owner', 'repo', 42, fixture.todoId, input.execution_id)
    const before = readFileSync(path, 'utf8')
    expect(JSON.parse(before).closureId).toBe('new-public-intent')
    await runLocalCommand(input)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(state().closing_id).toBe('new-public-intent')
    expect(github.closeIssue).toHaveBeenCalledTimes(2)
  }, 25_000)

  it('rejects completion without an exact Todo instead of silently closing only GitHub', async () => {
    const completion: LinkedClosure = {
      execution_id: 'execution', closure_id: 'finish', expected_revision: 0, mode: 'verified',
      acknowledged_gaps: [], decision: 'user-close-both', note: 'Close both, not just GitHub',
    }
    await expect(issueClose(42, 'Must not post', undefined, 'owner/repo', completion)).rejects.toThrow(/todo|identity/i)
    expect(github.getIssue).not.toHaveBeenCalled()
    expect(github.createComment).not.toHaveBeenCalled()
    expect(github.closeIssue).not.toHaveBeenCalled()
  })

  it('uses the public MCP closure to recover remote success without repeating side effects', async () => {
    const { store, todoId, workspace, completion } = await managedFixture()
    github.closeIssue.mockImplementation(async () => {
      writeFileSync(join(workspace, 'drift.txt'), 'External change after preflight')
      return { state: 'closed' }
    })
    const args = { todo_item: todoId, completion, comment: 'Approved comment' }
    const partial = await publicClose(args)
    expect(partial.isError).toBe(true)
    expect(partial.structuredContent).toMatchObject({
      schema_version: 1, todo_id: todoId, execution_id: completion.execution_id, closure: null,
      error: { code: 'closure_error' },
      recovery: { closure_id: completion.closure_id, closing_state: 'prepared', remote_receipt: expect.stringMatching(/^[a-f0-9]{64}$/) },
    })
    expect(store.listArchived()).toEqual([])
    const before = store.list()
    expect((await publicClose(args)).isError).toBe(true)
    expect(store.list()).toEqual(before)
    rmSync(join(workspace, 'drift.txt'))
    const result = await publicClose(args)
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      todo_id: todoId, execution_id: completion.execution_id, closure: { id: completion.closure_id, mode: 'verified' },
    })
    expect((await publicClose(args)).isError).not.toBe(true)
    expect(store.list()[0]!.status).toBe('done')
    expect(store.listArchived()).toHaveLength(0)
    expect(github.getIssue).toHaveBeenCalledTimes(1)
    expect(github.createComment).toHaveBeenCalledTimes(1)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('does not let a public prepared retry on another machine perform any GitHub operation', async () => {
    const { store, todoId, completion } = await managedFixture()
    github.getIssue.mockRejectedValueOnce(new Error('Fixture remote read interrupted'))
    const args = { todo_item: todoId, completion, comment: 'Must not publish on another machine' }
    expect((await publicClose(args)).isError).toBe(true)
    const before = store.list()
    expect(before[0]!.executions[0]!.workflow!.closings[0]!.state).toBe('prepared')
    github.getIssue.mockClear()
    machine.hostname = 'different-fixture-machine'
    expect((await publicClose(args)).isError).toBe(true)
    expect(github.getIssue).not.toHaveBeenCalled()
    expect(github.getIssueComments).not.toHaveBeenCalled()
    expect(github.createComment).not.toHaveBeenCalled()
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(store.list()).toEqual(before)
    expect(store.listArchived()).toEqual([])
  }, 20_000)

  it.each(['verified', 'with_gaps'] as const)('rechecks newly missing evidence before public %s retries reach GitHub', async mode => {
    const { directory, store, todoId, completion } = await managedFixture()
    github.getIssue.mockRejectedValueOnce(new Error('Fixture remote read interrupted'))
    const args = { todo_item: todoId, completion: { ...completion, mode }, comment: 'Must not publish with unaccepted gaps' }
    expect((await publicClose(args)).isError).toBe(true)
    const before = store.list()
    const workflow = before[0]!.executions[0]!.workflow!
    expect(workflow.closings[0]!.state).toBe('prepared')
    rmSync(join(directory, 'executions', completion.execution_id, 'artifacts', `${workflow.checks[0]!.receipt}.json`))
    github.getIssue.mockClear()
    expect((await publicClose(args)).isError).toBe(true)
    expect({
      reads: github.getIssue.mock.calls.length + github.getIssueComments.mock.calls.length,
      comments: github.createComment.mock.calls.length, closes: github.closeIssue.mock.calls.length,
    }).toEqual({ reads: 0, comments: 0, closes: 0 })
    expect(store.list()).toEqual(before)
    expect(store.listArchived()).toEqual([])
  }, 25_000)

  it.each([false, true])('cleans the original journal around explicit archival (already archived: %s)', async alreadyArchived => {
    const { directory, store, todoId, completion } = await managedFixture()
    const args = { todo_item: todoId, completion }
    expect((await publicClose(args)).isError).not.toBe(true)
    if (alreadyArchived) store.archiveAndDelete(0)
    const journalPath = journals.issueCloseReceiptPath(directory, 'owner', 'repo', 42, todoId, completion.execution_id)
    journals.writeIssueCloseReceipt(journalPath, {
      owner: 'owner', repo: 'repo', issueNumber: 42, todoId, executionId: completion.execution_id,
      lifecycleRevision: 0,
      closureId: completion.closure_id, state: 'closed', startedAt: new Date().toISOString(),
      remoteClosedAt: new Date().toISOString(),
    })
    expect((await publicClose(args)).isError).not.toBe(true)
    const digest = createHash('sha256').update(`owner/repo#42\0${todoId}\0${completion.execution_id}`).digest('hex').slice(0, 24)
    expect(existsSync(journalPath)).toBe(false)
    if (!alreadyArchived) store.archiveAndDelete(0)
    const restored = store.restoreArchivedForActivation(todoId)!
    const next = store.activateExecution(restored.storeIndex).execution
    expect(next.id).not.toBe(completion.execution_id)
    github.getIssue.mockResolvedValue({ state: 'closed' })
    expect((await publicClose({ todo_item: todoId })).isError).not.toBe(true)
    expect(store.list()[0]!.status).toBe('done')
    expect(store.list()[0]!.executions.at(-1)!.id).toBe(next.id)
    expect(store.list()[0]!.executions.at(-1)!.closed_at).not.toBeNull()
    expect(store.listArchived()).toEqual([])
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(existsSync(join(directory, '.operations', `issue-close-${digest}.json`))).toBe(false)
  }, 25_000)

  it('rejects missing, ambiguous or mismatched public completion identities before GitHub effects', async () => {
    const { store, todoId, completion } = await managedFixture()
    const before = store.list()
    for (const args of [
      { completion },
      { completion, todo_item: 'managed-linked' },
      { completion: { ...completion, execution_id: 'another-execution' }, todo_item: todoId },
    ]) {
      const result = await publicClose({ ...args, comment: 'Must not post' })
      expect(result.isError).toBe(true)
      expect(store.list()).toEqual(before)
      expect(store.listArchived()).toEqual([])
    }
    expect(github.getIssue).not.toHaveBeenCalled()
    expect(github.getIssueComments).not.toHaveBeenCalled()
    expect(github.createComment).not.toHaveBeenCalled()
    expect(github.closeIssue).not.toHaveBeenCalled()
  }, 20_000)

  it('does not depend on archive writes or repeat managed effects on retries', async () => {
    const { directory, store, todoId, completion } = await managedFixture()
    mkdirSync(join(directory, 'todos.archive.yaml.tmp'))
    await issueClose(42, 'Approved comment', todoId, 'owner/repo', completion)
    expect(store.list()[0]!.pending_transition).toBeUndefined()
    expect(store.list()[0]!.status).toBe('done')
    await expect(issueClose(42, 'Different comment', todoId, 'owner/repo', completion)).rejects.toThrow(/reuse/i)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    rmSync(join(directory, 'todos.archive.yaml.tmp'), { recursive: true })
    await issueClose(42, 'Approved comment', todoId, 'owner/repo', completion)
    await issueClose(42, 'Approved comment', todoId, 'owner/repo', completion)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(github.createComment).toHaveBeenCalledTimes(1)
    expect(store.listArchived()).toHaveLength(0)
  }, 25_000)
  it('closes the current execution without archiving a linked todo', async () => {
    const store = new TodoStore(getContribDir('owner', 'repo'))
    store.add({ ref: 'linked-todo', title: 'Linked todo', type: 'bug' })
    store.activateExecution(0)

    await issueClose(42, undefined, 'linked-todo', 'owner/repo')

    expect(store.listArchived()).toEqual([])
    expect(store.list()[0]!.executions[0]).toMatchObject({
      phase: 'finish',
      outcome: 'done',
      outcome_note: 'Linked GitHub issue #42 was closed.',
    })
    expect(store.list()[0]!.executions[0]!.closed_at).toBeTruthy()
  })

  it('refuses managed closure before comments or remote close effects', async () => {
    const store = new TodoStore(getContribDir('owner', 'repo'))
    const todo = store.add({ ref: 'managed', title: 'Managed task', type: 'feature' })
    const execution = store.activateExecution(0).execution
    store.applyWorkflow(todo.id!, execution.id, {
      request_id: 'propose', expected_revision: 0,
      command: {
        action: 'propose_plan', plan_id: 'plan',
        plan: {
          goal: 'Actual behavior', completion_scope: 'task', remaining_scope: [], non_goals: [], scope: ['.'], risk: 'normal',
          steps: [{ id: 's', title: 'Implement', scope: ['.'], depends_on: [], acceptance_ids: ['user'] }],
          acceptance: [{ id: 'user', description: 'User acceptance', kind: 'manual', independent: false, required: true }],
        },
      },
    })
    await expect(issueClose(42, 'Premature close', todo.id, 'owner/repo')).rejects.toThrow(/Managed.*preflight/)
    expect(github.getIssue).not.toHaveBeenCalled()
    expect(github.createComment).not.toHaveBeenCalled()
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(store.get(0)!.executions[0]!.closed_at).toBeNull()
  })

  it('keeps the linked todo identity stable while GitHub close is pending', async () => {
    const store = new TodoStore(getContribDir('owner', 'repo'))
    store.add({ ref: '#1', title: 'Earlier', type: 'chore' })
    store.add({ ref: '#2', title: 'Target', type: 'bug' })
    store.activateExecution(1)
    store.add({ ref: '#3', title: 'Following', type: 'feature' })
    const targetId = store.resolveItem('#2')!.item.id!
    const executionId = currentTodoExecution(store.resolveItem('#2')!.item)!.id

    let releaseClose!: () => void
    github.closeIssue.mockReturnValue(new Promise<{ state: string }>(resolve => { releaseClose = () => resolve({ state: 'closed' }) }))
    const closing = issueClose(42, undefined, '2', 'owner/repo')
    await vi.waitFor(() => expect(github.closeIssue).toHaveBeenCalled())
    store.delete(0)
    releaseClose()
    await closing

    const archived = store.list().find(todo => todo.id === targetId)!
    expect(archived.id).toBe(targetId)
    expect(archived.executions[0]).toMatchObject({ id: executionId, outcome: 'done' })
    expect(store.resolveItem('#3')!.item).toMatchObject({ status: 'idea', executions: [] })
  })

  it('does not fall back to a title match when the linked todo disappears', async () => {
    const store = new TodoStore(getContribDir('owner', 'repo'))
    const target = store.add({ ref: '#2', title: 'Target', type: 'bug' })
    store.add({ ref: '#3', title: `Follow up ${target.id}`, type: 'feature' })

    let releaseClose!: () => void
    github.closeIssue.mockReturnValue(new Promise<{ state: string }>(resolve => { releaseClose = () => resolve({ state: 'closed' }) }))
    const closing = issueClose(42, undefined, target.id, 'owner/repo')
    await vi.waitFor(() => expect(github.closeIssue).toHaveBeenCalled())

    const targetIndex = store.resolveItem(target.id!)!.storeIndex
    store.delete(targetIndex)
    releaseClose()

    await expect(closing).rejects.toThrow('changed or was removed')
    expect(store.listArchived()).toEqual([])
    expect(store.resolveItem('#3')!.item.title).toBe(`Follow up ${target.id}`)
  })

  it('reports remote close success and suppresses a duplicate close comment during archive retry', async () => {
    const dir = getContribDir('owner', 'repo')
    const store = new TodoStore(dir)
    const target = store.add({ ref: '#2', title: 'Target', type: 'bug' })
    store.activateExecution(0)
    let postedBody = ''
    github.createComment.mockImplementation(async (_owner, _repo, _issue, body) => {
      postedBody = body
      return { id: 801, body }
    })
    mkdirSync(join(dir, 'todos.yaml.tmp'))

    await expect(issueClose(2, 'Closing now.', target.id, 'owner/repo'))
      .rejects.toThrow(new RegExp(`issue #2 was closed.*todo_item="${target.id}"`, 'is'))

    rmSync(join(dir, 'todos.yaml.tmp'), { recursive: true, force: true })
    github.getIssueComments.mockResolvedValue([{ id: 801, body: postedBody, user: { login: 'maintainer' } }])
    github.createComment.mockClear()
    await issueClose(2, 'Closing now.', target.id, 'owner/repo')

    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(github.createComment).not.toHaveBeenCalled()
    expect(store.list()[0]!.id).toBe(target.id)
    expect(store.list()[0]!.status).toBe('done')
    expect(store.listArchived()).toEqual([])
  })

  it('completes independently of a broken archive destination and does not repeat a successful remote close', async () => {
    const dir = getContribDir('owner', 'repo')
    const store = new TodoStore(dir)
    const target = store.add({ ref: '#3', title: 'Archive write target', type: 'bug' })
    store.activateExecution(0)
    mkdirSync(join(dir, 'todos.archive.yaml.tmp'))

    await issueClose(3, undefined, target.id, 'owner/repo')
    expect(github.closeIssue).toHaveBeenCalledTimes(1)

    rmSync(join(dir, 'todos.archive.yaml.tmp'), { recursive: true, force: true })
    await issueClose(3, undefined, target.id, 'owner/repo')

    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(store.list()[0]!.id).toBe(target.id)
    expect(store.list()[0]!.status).toBe('done')
    expect(store.listArchived()).toEqual([])
  })

  it('rejects an unrelated pending Todo archive before any remote close', async () => {
    const dir = getContribDir('owner', 'repo')
    const store = new TodoStore(dir)
    const target = store.add({ ref: '#4', title: 'Generic archive target', type: 'bug' })
    store.completeTodo(0, 'done', 'Todo completed.')
    mkdirSync(join(dir, 'todos.yaml.tmp'))
    expect(() => store.archiveAndDelete(0)).toThrow()
    rmSync(join(dir, 'todos.yaml.tmp'), { recursive: true, force: true })

    await expect(issueClose(4, undefined, target.id, 'owner/repo'))
      .rejects.toThrow(/pending archival.*todo_archive/is)

    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(store.list()).toHaveLength(1)
  })

  it('rejects a generic pending archive with an execution before remote work', async () => {
    const dir = getContribDir('owner', 'repo')
    const store = new TodoStore(dir)
    const target = store.add({ ref: '#5', title: 'Generic execution archive', type: 'bug' })
    store.activateExecution(0)
    store.completeTodo(0, 'done', 'Todo completed.')
    mkdirSync(join(dir, 'todos.yaml.tmp'))
    expect(() => store.archiveAndDelete(0)).toThrow()
    rmSync(join(dir, 'todos.yaml.tmp'), { recursive: true, force: true })

    await expect(issueClose(5, undefined, target.id, 'owner/repo'))
      .rejects.toThrow(/pending archival.*todo_archive/is)

    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(store.list()).toHaveLength(1)
  })

  it('does not let a newer execution bypass an unresolved close receipt', async () => {
    const dir = getContribDir('owner', 'repo')
    const store = new TodoStore(dir)
    const target = store.add({ ref: '#6', title: 'Execution drift target', type: 'bug' })
    store.activateExecution(0)
    const firstExecutionId = currentTodoExecution(store.resolveItemById(target.id!)!.item)!.id
    let releaseClose!: () => void
    github.closeIssue.mockReturnValue(new Promise<{ state: string }>(resolve => { releaseClose = () => resolve({ state: 'closed' }) }))

    const closing = issueClose(6, undefined, target.id, 'owner/repo')
    await vi.waitFor(() => expect(github.closeIssue).toHaveBeenCalledTimes(1))
    store.completeTodo(0, 'done', 'Completed elsewhere.')
    store.archiveAndDelete(0)
    const restored = store.restoreArchivedForActivation(target.id!)!
    store.activateExecution(restored.storeIndex)
    const secondExecutionId = currentTodoExecution(store.resolveItemById(target.id!)!.item)!.id
    expect(secondExecutionId).not.toBe(firstExecutionId)
    releaseClose()

    await expect(closing).rejects.toThrow(/changed execution/)
    await expect(issueClose(6, undefined, target.id, 'owner/repo'))
      .rejects.toThrow(new RegExp(`${firstExecutionId}.*${secondExecutionId}`, 's'))

    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(currentTodoExecution(store.resolveItemById(target.id!)!.item)!.id).toBe(secondExecutionId)
  })

  it('reconciles a pending journal against a remotely closed issue without closing again', async () => {
    const dir = getContribDir('owner', 'repo')
    const store = new TodoStore(dir)
    const target = store.add({ ref: '#7', title: 'Pending close journal', type: 'bug' })
    store.activateExecution(0)
    const executionId = currentTodoExecution(store.resolveItemById(target.id!)!.item)!.id
    const digest = createHash('sha256')
      .update(`owner/repo#7\0${target.id}\0${executionId}`)
      .digest('hex')
      .slice(0, 24)
    const receiptPath = join(dir, '.operations', `issue-close-${digest}.json`)
    mkdirSync(join(dir, '.operations'), { recursive: true })
    writeFileSync(receiptPath, JSON.stringify({
      owner: 'owner',
      repo: 'repo',
      issueNumber: 7,
      todoId: target.id,
      executionId,
      lifecycleRevision: 0,
      state: 'pending',
      startedAt: '2026-09-17T01:00:00.000Z',
      dispatch: {
        version: 1, initializedAt: '2026-09-17T01:00:00.000Z',
        commentDigest: createHash('sha256').update('').digest('hex'), effects: [],
      },
    }), 'utf-8')
    github.getIssue.mockResolvedValue({ state: 'closed' })

    await issueClose(7, undefined, target.id, 'owner/repo')

    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(store.list()[0]!.id).toBe(target.id)
    expect(store.list()[0]!.status).toBe('done')
    expect(store.listArchived()).toEqual([])
    expect(existsSync(receiptPath)).toBe(false)
  })

  it('cleans a confirmed receipt when the linked todo was already archived', async () => {
    const dir = getContribDir('owner', 'repo')
    const store = new TodoStore(dir)
    const target = store.add({ ref: '#8', title: 'Archived close recovery', type: 'bug' })
    store.activateExecution(0)
    const executionId = currentTodoExecution(store.resolveItemById(target.id!)!.item)!.id
    store.completeTodo(0, 'done', 'Linked GitHub issue #8 was closed.')
    store.archiveAndDelete(0)
    const digest = createHash('sha256')
      .update(`owner/repo#8\0${target.id}\0${executionId}`)
      .digest('hex')
      .slice(0, 24)
    const receiptPath = join(dir, '.operations', `issue-close-${digest}.json`)
    mkdirSync(join(dir, '.operations'), { recursive: true })
    writeFileSync(receiptPath, JSON.stringify({
      owner: 'owner',
      repo: 'repo',
      issueNumber: 8,
      todoId: target.id,
      executionId,
      lifecycleRevision: 0,
      state: 'closed',
      startedAt: '2026-09-17T01:00:00.000Z',
      remoteClosedAt: '2026-09-17T01:00:00.000Z',
      dispatch: {
        version: 1, initializedAt: '2026-09-17T01:00:00.000Z',
        commentDigest: createHash('sha256').update('').digest('hex'), effects: [],
      },
    }), 'utf-8')

    const result = await issueClose(8, undefined, target.id, 'owner/repo')

    expect(result).toMatch(/already archived/i)
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(existsSync(receiptPath)).toBe(false)
    expect(store.listArchived()[0]!.id).toBe(target.id)
  })

  it.each([false, true])('rejects a cancelled Todo before any Issue effect (archived: %s)', async archived => {
    const directory = getContribDir('owner', 'repo')
    const store = new TodoStore(directory)
    const todo = store.add({ ref: '#9', title: 'Cancelled linked task', type: 'bug' })
    store.cancelTodo(todo.id!, 0, 'fixture:user-cancelled')
    if (archived) store.archiveAndDelete(0)
    const before = store.list()
    const history = store.listArchived()
    const file = join(directory, archived ? 'todos.archive.yaml' : 'todos.yaml')
    const bytes = readFileSync(file)

    await expect(issueClose(9, 'Do not post', todo.id, 'owner/repo'))
      .rejects.toThrow(archived ? 'Todo not found' : 'Reopen explicitly')

    expect(github.getIssue).not.toHaveBeenCalled()
    expect(github.getIssueComments).not.toHaveBeenCalled()
    expect(github.createComment).not.toHaveBeenCalled()
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(store.list()).toEqual(before)
    expect(store.listArchived()).toEqual(history)
    expect(readFileSync(file)).toEqual(bytes)
    expect(existsSync(join(directory, '.operations'))).toBe(false)
  })

  it('blocks plain cancellation during admitted Issue close and never repeats its remote effects', async () => {
    const directory = getContribDir('owner', 'repo')
    const store = new TodoStore(directory)
    const todo = store.add({ ref: '#9', title: 'Admitted Issue close', type: 'bug' })
    const path = journals.issueCloseReceiptPath(directory, 'owner', 'repo', 9, todo.id!, null)
    github.getIssue.mockImplementationOnce(async () => {
      expect(journals.readIssueCloseReceipt(path, {
        owner: 'owner', repo: 'repo', issueNumber: 9, todoId: todo.id!, executionId: null,
      })).toMatchObject({ state: 'pending', lifecycleRevision: 0 })
      const before = readFileSync(join(directory, 'todos.yaml'))
      expect(() => store.cancelTodo(todo.id!, 0, 'fixture:cancel-during-issue-close')).toThrow(/issue_close.*accounted/i)
      expect(readFileSync(join(directory, 'todos.yaml'))).toEqual(before)
      expect(store.get(0)!.status).toBe('idea')
      return { state: 'open' }
    })

    await issueClose(9, 'Close exactly once.', todo.id, 'owner/repo')
    const completed = store.list()
    expect(completed[0]).toMatchObject({ id: todo.id, status: 'done', executions: [] })
    expect(completed[0]!.last_cancellation).toBeUndefined()
    expect(existsSync(path)).toBe(false)
    expect(await issueClose(9, 'Close exactly once.', todo.id, 'owner/repo')).toContain('already done locally')
    expect(store.list()).toEqual(completed)
    expect(store.listArchived()).toEqual([])
    expect(github.getIssue).toHaveBeenCalledTimes(1)
    expect(github.createComment).toHaveBeenCalledTimes(1)
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
  })

  function plainAccountingFixture(kind: 'pause' | 'cancel' = 'pause') {
    const directory = getContribDir('owner', 'repo')
    const store = new TodoStore(directory)
    const todo = store.add({ ref: '#12', title: 'Plain original accounting', type: 'bug' })
    const execution = store.activateExecution(0).execution
    const path = journals.issueCloseReceiptPath(directory, 'owner', 'repo', 12, todo.id!, execution.id)
    const state = () => store.get(0)!.executions[0]!.workflow!
    const request = () => store.applyWorkflow(todo.id!, execution.id, {
      request_id: kind, expected_revision: 0,
      command: { action: 'request_control', control_id: kind, kind,
        decision: `fixture:user-${kind}`, note: 'Stop the original plain Issue call.' },
    })
    const settle = () => kind === 'pause'
      ? settleControl('settle_pause', {
          directory, todo_id: todo.id!, execution_id: execution.id, request_id: 'settle',
          expected_revision: state().revision, control_id: kind, actor: 'primary',
        })
      : closeManaged({
          directory, todo_id: todo.id!, execution_id: execution.id, closure_id: 'local-stop',
          expected_revision: state().revision, mode: 'stopped', acknowledged_gaps: [],
          decision: `fixture:user-${kind}`, note: 'Settle the requested cancellation.', target: { kind: 'local' },
        })
    const resume = () => settleControl('resume_control', {
      directory, todo_id: todo.id!, execution_id: execution.id, request_id: 'continue',
      expected_revision: state().revision, control_id: kind, actor: 'primary', decision: 'fixture:user-continue',
    })
    const auditNames = () => existsSync(join(directory, '.operations'))
      ? readdirSync(join(directory, '.operations')).filter(name => /^accounted-issue-close-[a-f0-9]{64}\.json$/.test(name))
      : []
    const effectCounts = () => ({
      read: github.getIssue.mock.calls.length, comments: github.getIssueComments.mock.calls.length,
      post: github.createComment.mock.calls.length, close: github.closeIssue.mock.calls.length,
    })
    const artifactFiles = (path = join(directory, 'executions')): unknown[] => !existsSync(path) ? []
      : readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
          ? artifactFiles(join(path, entry.name)) : [[join(path, entry.name), readFileSync(join(path, entry.name))]])
    const assertBlocked = () => {
      const bytes = readFileSync(join(directory, 'todos.yaml'))
      const artifacts = artifactFiles()
      expect(() => settle()).toThrow(/issue_close.*accounted/i)
      expect(readFileSync(join(directory, 'todos.yaml'))).toEqual(bytes)
      expect(artifactFiles()).toEqual(artifacts)
      expect(() => resume()).toThrow(/issue_close.*accounted/i)
      expect(readFileSync(join(directory, 'todos.yaml'))).toEqual(bytes)
      expect(artifactFiles()).toEqual(artifacts)
    }
    const run = (comment = 'Original close decision.') => issueClose(12, comment, todo.id, 'owner/repo')
    return { directory, store, todo, execution, path, state, request, settle, resume, auditNames, effectCounts, assertBlocked, run }
  }

  it.each((['pause', 'cancel'] as const).flatMap(kind =>
    (['getIssue', 'getIssueComments', 'createComment', 'closeIssue'] as const).map(boundary => ({ kind, boundary })),
  ))('accounts the original plain call only after $kind during $boundary returns', async ({ kind, boundary }) => {
    const fixture = plainAccountingFixture(kind)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered = false
    let controlled: Buffer | undefined
    github[boundary].mockImplementationOnce(async () => {
      fixture.request()
      controlled = readFileSync(join(fixture.directory, 'todos.yaml'))
      fixture.assertBlocked()
      const journal = JSON.parse(readFileSync(fixture.path, 'utf8'))
      expect(journal).toMatchObject({ lifecycleRevision: 0, dispatch: { version: 1 } })
      if (boundary === 'createComment' || boundary === 'closeIssue') {
        expect(journal.dispatch.effects.at(-1)).toMatchObject({ kind: boundary === 'createComment' ? 'comment' : 'close' })
        expect(journal.dispatch.effects.at(-1).result).toBeUndefined()
      }
      entered = true
      await gate
      if (boundary === 'getIssueComments') return []
      return boundary === 'createComment' ? { id: 801, body: '' }
        : { state: boundary === 'getIssue' ? 'open' : 'closed' }
    })
    const closing = fixture.run().then(() => undefined, error => error as Error)
    try {
      await vi.waitFor(() => expect(entered).toBe(true))
      expect(existsSync(fixture.path)).toBe(true)
      expect(fixture.auditNames()).toEqual([])
      fixture.assertBlocked()
    }
    finally { release() }
    const error = await closing
    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toContain('Local pause/cancel remains user-controlled')
    expect(error!.message).toContain('new explicit close decision')
    expect(readFileSync(join(fixture.directory, 'todos.yaml'))).toEqual(controlled)
    expect(fixture.store.get(0)!.executions[0]).toMatchObject({
      id: fixture.execution.id, closed_at: null, workflow: { control: { active_id: kind }, closure: null },
    })
    expect(fixture.store.listArchived()).toEqual([])
    expect(existsSync(fixture.path)).toBe(false)
    expect(fixture.auditNames()).toHaveLength(1)
    const filename = fixture.auditNames()[0]!
    const content = readFileSync(join(fixture.directory, '.operations', filename), 'utf8')
    expect(filename).toBe(`accounted-issue-close-${createHash('sha256').update(content).digest('hex')}.json`)
    const audit = JSON.parse(content)
    expect(audit.control).toEqual(fixture.state().control)
    expect(audit.journalHash).toBe(createHash('sha256').update(audit.journalContent).digest('hex'))
    const journal = JSON.parse(audit.journalContent)
    expect(journal).toMatchObject({
      todoId: fixture.todo.id, executionId: fixture.execution.id, lifecycleRevision: 0,
      dispatch: { commentDigest: createHash('sha256').update('Original close decision.').digest('hex') },
    })
    expect(journal.dispatch.effects).toHaveLength(boundary === 'closeIssue' ? 2 : boundary === 'createComment' ? 1 : 0)
    for (const effect of journal.dispatch.effects) {
      expect(effect.result).toBeDefined()
      expect(effect.returnedAt).toBeDefined()
    }
    expect(github.createComment).toHaveBeenCalledTimes(boundary === 'createComment' || boundary === 'closeIssue' ? 1 : 0)
    expect(github.closeIssue).toHaveBeenCalledTimes(boundary === 'closeIssue' ? 1 : 0)
    expect(() => journals.assertNoPendingIssueClose(fixture.directory, fixture.todo.id!)).not.toThrow()
    fixture.settle()
    expect(fixture.store.get(0)!.status).toBe(kind === 'pause' ? 'paused' : 'cancelled')
    const counts = fixture.effectCounts()
    if (kind === 'pause') fixture.resume()
    await expect(fixture.run()).rejects.toThrow(/Managed|new execution|completion/i)
    expect(fixture.effectCounts()).toEqual(counts)
    expect(readFileSync(join(fixture.directory, '.operations', filename), 'utf8')).toBe(content)
  })

  it.each((['pause', 'cancel'] as const).flatMap(kind =>
    (['getIssue', 'getIssueComments'] as const).map(boundary => ({ kind, boundary })),
  ))('accounts rejected plain $boundary after $kind without admitting any POST', async ({ kind, boundary }) => {
    const fixture = plainAccountingFixture(kind)
    const fixtureToken = `fixture-only-secret-${kind}-${boundary}`
    const failure = new Error(`fixture: ${boundary} failed at https://example.invalid/issue?token=${fixtureToken}`)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered = false
    let controlled: Buffer | undefined
    let originalJournal: Buffer | undefined
    github[boundary].mockImplementationOnce(async () => {
      fixture.request()
      controlled = readFileSync(join(fixture.directory, 'todos.yaml'))
      originalJournal = readFileSync(fixture.path)
      expect(JSON.parse(originalJournal.toString())).toMatchObject({
        todoId: fixture.todo.id, executionId: fixture.execution.id, lifecycleRevision: 0,
        state: 'pending', dispatch: { effects: [] },
      })
      fixture.assertBlocked()
      entered = true
      await gate
      throw failure
    })

    const closing = fixture.run().then(() => undefined, error => error as Error)
    try {
      await vi.waitFor(() => expect(entered).toBe(true))
      expect(existsSync(fixture.path)).toBe(true)
      expect(fixture.auditNames()).toEqual([])
      fixture.assertBlocked()
    }
    finally { release() }
    const error = await closing
    expect(error).toBeInstanceOf(Error)
    expect(readFileSync(join(fixture.directory, 'todos.yaml'))).toEqual(controlled)
    expect(fixture.store.get(0)!.executions[0]).toMatchObject({
      id: fixture.execution.id, closed_at: null, workflow: { control: { active_id: kind }, closure: null },
    })
    expect(fixture.store.listArchived()).toEqual([])
    expect(fixture.effectCounts()).toEqual({
      read: 1, comments: boundary === 'getIssueComments' ? 1 : 0, post: 0, close: 0,
    })

    expect(fixture.auditNames()).toHaveLength(1)
    expect(existsSync(fixture.path)).toBe(false)
    expect(error!.message).toContain('Local pause/cancel remains user-controlled')
    const filename = fixture.auditNames()[0]!
    const auditPath = join(fixture.directory, '.operations', filename)
    const content = readFileSync(auditPath, 'utf8')
    const audit = JSON.parse(content)
    expect(filename).toBe(`accounted-issue-close-${createHash('sha256').update(content).digest('hex')}.json`)
    expect(audit.journalContent).toBe(originalJournal!.toString())
    expect(audit.journalHash).toBe(createHash('sha256').update(audit.journalContent).digest('hex'))
    expect(audit.control).toEqual(fixture.state().control)
    const journal = JSON.parse(audit.journalContent)
    expect(journal).toMatchObject({ state: 'pending', lifecycleRevision: 0, dispatch: { effects: [] } })
    expect(journal.remoteClosedAt).toBeUndefined()
    expect(audit.reads).toHaveLength(boundary === 'getIssue' ? 1 : 2)
    const failedRead = audit.reads.at(-1)
    expect(failedRead).toEqual({
      kind: 'read-failed', method: boundary === 'getIssue' ? 'issue' : 'comments',
      endedAt: expect.any(String),
    })
    expect(new Date(failedRead.endedAt).toISOString()).toBe(failedRead.endedAt)
    expect(Date.parse(failedRead.endedAt)).toBeGreaterThanOrEqual(Date.parse(journal.startedAt))
    expect(Date.parse(failedRead.endedAt)).toBeLessThanOrEqual(Date.parse(audit.accountedAt))
    for (const read of audit.reads) expect(read.state).not.toBe('closed')
    expect(content).not.toContain(failure.message)
    expect(content).not.toContain(fixtureToken)
    expect(content).not.toContain('https://example.invalid')
    expect(readFileSync(join(fixture.directory, 'todos.yaml'), 'utf8')).not.toContain(fixtureToken)
    expect(() => journals.assertNoPendingIssueClose(fixture.directory, fixture.todo.id!)).not.toThrow()

    const counts = fixture.effectCounts()
    await expect(fixture.run()).rejects.toThrow(/Managed|completion/i)
    expect(fixture.effectCounts()).toEqual(counts)
    fixture.settle()
    expect(fixture.store.get(0)!.status).toBe(kind === 'pause' ? 'paused' : 'cancelled')
    expect(fixture.store.listArchived()).toEqual([])
    if (kind === 'pause') fixture.resume()
    await expect(fixture.run()).rejects.toThrow(/Managed|new execution|completion/i)
    expect(fixture.effectCounts()).toEqual(counts)
    expect(readFileSync(auditPath, 'utf8')).toBe(content)
  })

  it.each((['pause', 'cancel'] as const).flatMap(kind =>
    (['getIssue', 'getIssueComments', 'createComment', 'closeIssue'] as const).map(boundary => ({ kind, boundary })),
  ))('accounts exact plain retry after initial GET failure when $kind arrives during $boundary', async ({ kind, boundary }) => {
    const fixture = plainAccountingFixture(kind)
    fixture.store.update(0, { status: 'active' })
    const initialFailure = new Error('fixture: initial GET failed without control')
    github.getIssue.mockRejectedValueOnce(initialFailure)
    await expect(fixture.run()).rejects.toThrow(initialFailure.message)
    expect(fixture.store.get(0)!.status).toBe('active')
    expect(currentTodoExecution(fixture.store.get(0)!)?.id).toBe(fixture.execution.id)
    expect(currentTodoExecution(fixture.store.get(0)!)?.workflow).toBeUndefined()
    expect(fixture.auditNames()).toEqual([])
    expect(fixture.effectCounts()).toEqual({ read: 1, comments: 0, post: 0, close: 0 })
    const initialJournal = readFileSync(fixture.path)
    const original = JSON.parse(initialJournal.toString())
    expect(original).toMatchObject({
      todoId: fixture.todo.id, executionId: fixture.execution.id, lifecycleRevision: 0,
      state: 'pending', dispatch: { effects: [] },
    })

    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered = false
    let controlled: Buffer | undefined
    github[boundary].mockImplementationOnce(async () => {
      const admitted = JSON.parse(readFileSync(fixture.path, 'utf8'))
      expect(admitted).toMatchObject({
        todoId: original.todoId, executionId: original.executionId,
        lifecycleRevision: original.lifecycleRevision, startedAt: original.startedAt,
        dispatch: { initializedAt: original.dispatch.initializedAt, commentDigest: original.dispatch.commentDigest },
      })
      if (boundary === 'getIssue' || boundary === 'getIssueComments') {
        expect(readFileSync(fixture.path)).toEqual(initialJournal)
      }
      else {
        expect(admitted.dispatch.effects.at(-1)).toMatchObject({
          kind: boundary === 'createComment' ? 'comment' : 'close',
        })
        expect(admitted.dispatch.effects.at(-1).result).toBeUndefined()
      }
      fixture.request()
      controlled = readFileSync(join(fixture.directory, 'todos.yaml'))
      fixture.assertBlocked()
      entered = true
      await gate
      if (boundary === 'getIssueComments') return []
      return boundary === 'createComment' ? { id: 801, body: '' }
        : { state: boundary === 'getIssue' ? 'open' : 'closed' }
    })

    const closing = fixture.run().then(() => undefined, error => error as Error)
    try {
      await vi.waitFor(() => expect(entered).toBe(true))
      expect(existsSync(fixture.path)).toBe(true)
      expect(fixture.auditNames()).toEqual([])
      fixture.assertBlocked()
    }
    finally { release() }
    const error = await closing
    expect(error).toBeInstanceOf(Error)
    expect(readFileSync(join(fixture.directory, 'todos.yaml'))).toEqual(controlled)
    expect(fixture.store.get(0)!.executions[0]).toMatchObject({
      id: fixture.execution.id, closed_at: null, workflow: { control: { active_id: kind }, closure: null },
    })
    expect(fixture.store.listArchived()).toEqual([])
    expect(fixture.effectCounts()).toEqual({
      read: 2, comments: boundary === 'getIssue' ? 0 : 1,
      post: boundary === 'createComment' || boundary === 'closeIssue' ? 1 : 0,
      close: boundary === 'closeIssue' ? 1 : 0,
    })

    expect(fixture.auditNames()).toHaveLength(1)
    expect(existsSync(fixture.path)).toBe(false)
    expect(error!.message).toContain('Local pause/cancel remains user-controlled')
    const filename = fixture.auditNames()[0]!
    const auditPath = join(fixture.directory, '.operations', filename)
    const content = readFileSync(auditPath, 'utf8')
    const audit = JSON.parse(content)
    expect(filename).toBe(`accounted-issue-close-${createHash('sha256').update(content).digest('hex')}.json`)
    expect(audit.journalHash).toBe(createHash('sha256').update(audit.journalContent).digest('hex'))
    expect(audit.control).toEqual(fixture.state().control)
    const journal = JSON.parse(audit.journalContent)
    expect(journal).toMatchObject({
      owner: original.owner, repo: original.repo, issueNumber: original.issueNumber,
      todoId: original.todoId, executionId: original.executionId,
      lifecycleRevision: 0, startedAt: original.startedAt,
      state: boundary === 'closeIssue' ? 'closed' : 'pending',
      dispatch: { initializedAt: original.dispatch.initializedAt, commentDigest: original.dispatch.commentDigest },
    })
    const effects = journal.dispatch.effects
    if (boundary === 'closeIssue') {
      expect(effects.map((effect: { result: unknown }) => effect.result)).toEqual([
        { kind: 'comment', id: 800 }, { kind: 'close', state: 'closed' },
      ])
    }
    else if (boundary === 'createComment') {
      expect(effects.map((effect: { result: unknown }) => effect.result)).toEqual([{ kind: 'comment', id: 801 }])
    }
    else expect(effects).toEqual([])
    for (const effect of effects) {
      expect(effect.result).toBeDefined()
      expect(Number.isNaN(Date.parse(effect.returnedAt))).toBe(false)
    }
    expect(() => journals.assertNoPendingIssueClose(fixture.directory, fixture.todo.id!)).not.toThrow()

    const counts = fixture.effectCounts()
    await expect(fixture.run()).rejects.toThrow(/Managed|completion/i)
    expect(fixture.effectCounts()).toEqual(counts)
    fixture.settle()
    expect(fixture.store.get(0)!.status).toBe(kind === 'pause' ? 'paused' : 'cancelled')
    expect(fixture.store.listArchived()).toEqual([])
    if (kind === 'pause') fixture.resume()
    await expect(fixture.run()).rejects.toThrow(/Managed|new execution|completion/i)
    expect(fixture.effectCounts()).toEqual(counts)
    expect(readFileSync(auditPath, 'utf8')).toBe(content)
  })

  it.each((['pause', 'cancel'] as const).flatMap(kind =>
    (['getIssue', 'getIssueComments'] as const).map(boundary => ({ kind, boundary })),
  ))('accounts zero-admission exact retry when $kind follows a failed $boundary', async ({ kind, boundary }) => {
    const fixture = plainAccountingFixture(kind)
    fixture.store.update(0, { status: 'active' })
    const failure = new Error(`fixture: ${boundary} failed before the control request`)
    github[boundary].mockRejectedValueOnce(failure)
    await expect(fixture.run()).rejects.toThrow(failure.message)
    expect(fixture.store.get(0)!.status).toBe('active')
    expect(currentTodoExecution(fixture.store.get(0)!)?.workflow).toBeUndefined()
    expect(fixture.auditNames()).toEqual([])
    expect(fixture.effectCounts()).toEqual({
      read: 1, comments: boundary === 'getIssueComments' ? 1 : 0, post: 0, close: 0,
    })
    const originalJournal = readFileSync(fixture.path)
    const original = JSON.parse(originalJournal.toString())
    expect(original).toMatchObject({
      todoId: fixture.todo.id, executionId: fixture.execution.id, lifecycleRevision: 0,
      state: 'pending', dispatch: { effects: [] },
    })

    fixture.request()
    const controlled = readFileSync(join(fixture.directory, 'todos.yaml'))
    fixture.assertBlocked()
    const counts = fixture.effectCounts()
    await expect(fixture.run()).rejects.toThrow('Local pause/cancel remains user-controlled')
    expect(fixture.effectCounts()).toEqual(counts)
    expect(readFileSync(join(fixture.directory, 'todos.yaml'))).toEqual(controlled)
    expect(fixture.store.get(0)!.executions[0]).toMatchObject({
      id: fixture.execution.id, closed_at: null, workflow: { control: { active_id: kind }, closure: null },
    })
    expect(fixture.store.listArchived()).toEqual([])
    expect(existsSync(fixture.path)).toBe(false)
    expect(fixture.auditNames()).toHaveLength(1)

    const filename = fixture.auditNames()[0]!
    const auditPath = join(fixture.directory, '.operations', filename)
    const content = readFileSync(auditPath, 'utf8')
    const audit = JSON.parse(content)
    expect(filename).toBe(`accounted-issue-close-${createHash('sha256').update(content).digest('hex')}.json`)
    expect(audit).toMatchObject({ basis: 'zero-admission-recovery', reads: [] })
    expect(audit.reads).toEqual([])
    expect(audit.journalContent).toBe(originalJournal.toString())
    expect(audit.journalHash).toBe(createHash('sha256').update(audit.journalContent).digest('hex'))
    expect(audit.control).toEqual(fixture.state().control)
    expect(JSON.parse(audit.journalContent)).toEqual(original)
    expect(original.remoteClosedAt).toBeUndefined()
    expect(content).not.toContain(failure.message)
    expect(() => journals.assertNoPendingIssueClose(fixture.directory, fixture.todo.id!)).not.toThrow()

    await expect(fixture.run()).rejects.toThrow(/Managed|completion/i)
    expect(fixture.effectCounts()).toEqual(counts)
    fixture.settle()
    expect(fixture.store.get(0)!.status).toBe(kind === 'pause' ? 'paused' : 'cancelled')
    expect(fixture.store.listArchived()).toEqual([])
    if (kind === 'pause') fixture.resume()
    await expect(fixture.run()).rejects.toThrow(/Managed|new execution|completion/i)
    expect(fixture.effectCounts()).toEqual(counts)
    expect(readFileSync(auditPath, 'utf8')).toBe(content)
    expect(fixture.auditNames()).toEqual([filename])
  })

  it.each((['createComment', 'closeIssue'] as const).flatMap(boundary =>
    (['rejected', 'invalid'] as const).map(outcome => ({ boundary, outcome })),
  ))(
    'retains $outcome plain $boundary admission after control even when a fresh Issue would report closed', async ({ boundary, outcome }) => {
      const fixture = plainAccountingFixture('cancel')
      github[boundary].mockImplementationOnce(async () => {
        fixture.request()
        fixture.assertBlocked()
        if (outcome === 'rejected') throw new Error('fixture: original response unknown')
        return boundary === 'createComment' ? { body: 'Missing original comment identity' } : { state: 'open' }
      })
      await expect(fixture.run()).rejects.toThrow(/unknown|invalid|expected/i)
      const retained = readFileSync(fixture.path)
      expect(JSON.parse(retained.toString()).dispatch.effects.at(-1).result).toBeUndefined()
      expect(fixture.auditNames()).toEqual([])
      github.getIssue.mockResolvedValue({ state: 'closed' })
      const counts = fixture.effectCounts()
      await expect(fixture.run()).rejects.toThrow(/unknown|accounting/)
      expect(fixture.effectCounts()).toEqual(counts)
      expect(readFileSync(fixture.path)).toEqual(retained)
      fixture.assertBlocked()
    },
  )

  it('retains plain accounting uncertainty when publishing its audit fails', async () => {
    const fixture = plainAccountingFixture()
    const fault = vi.spyOn(accounting, 'publishIssueCloseAccounting').mockImplementationOnce(() => {
      throw new Error('fixture: audit publication failed')
    })
    github.createComment.mockImplementationOnce(async () => { fixture.request(); return { id: 801, body: '' } })
    await expect(fixture.run()).rejects.toThrow('audit publication failed')
    expect(fault).toHaveBeenCalledTimes(1)
    fault.mockRestore()
    const retained = readFileSync(fixture.path)
    expect(JSON.parse(retained.toString()).dispatch.effects).toEqual([
      expect.objectContaining({ kind: 'comment', result: { kind: 'comment', id: 801 }, returnedAt: expect.any(String) }),
    ])
    expect(github.createComment).toHaveBeenCalledTimes(1)
    expect(github.closeIssue).not.toHaveBeenCalled()
    expect(fixture.auditNames()).toEqual([])
    fixture.assertBlocked()
    const counts = fixture.effectCounts()
    await expect(fixture.run()).rejects.toThrow(/accounting.*unavailable/)
    expect(fixture.effectCounts()).toEqual(counts)
    expect(readFileSync(fixture.path)).toEqual(retained)
  })

  it('retains unknown plain results when original response persistence fails', async () => {
    const fixture = plainAccountingFixture('cancel')
    const write = journals.writeIssueCloseReceipt
    const fault = vi.spyOn(journals, 'writeIssueCloseReceipt').mockImplementation((path, receipt) => {
      if (receipt.dispatch?.effects.some(effect => effect.kind === 'close' && effect.result)) {
        throw new Error('fixture: returned response not persisted')
      }
      return write(path, receipt)
    })
    github.closeIssue.mockImplementationOnce(async () => { fixture.request(); return { state: 'closed' } })
    await expect(fixture.run()).rejects.toThrow('returned response not persisted')
    fault.mockRestore()
    const retained = readFileSync(fixture.path)
    const effect = JSON.parse(retained.toString()).dispatch.effects.at(-1)
    expect(effect).toMatchObject({ kind: 'close' })
    expect(effect.result).toBeUndefined()
    expect(fixture.auditNames()).toEqual([])
    const counts = fixture.effectCounts()
    github.getIssue.mockResolvedValue({ state: 'closed' })
    await expect(fixture.run()).rejects.toThrow(/unknown/)
    expect(fixture.effectCounts()).toEqual(counts)
    expect(readFileSync(fixture.path)).toEqual(retained)
    fixture.assertBlocked()
  })

  it('recovers an accounted plain journal deletion failure by exact replay without redispatch', async () => {
    const fixture = plainAccountingFixture('cancel')
    const published = vi.spyOn(accounting, 'publishIssueCloseAccounting')
    const fault = vi.spyOn(accounting, 'removeAccountedIssueClose').mockImplementationOnce(() => {
      throw new Error('fixture: journal deletion failed')
    })
    github.closeIssue.mockImplementationOnce(async () => { fixture.request(); return { state: 'closed' } })
    await expect(fixture.run()).rejects.toThrow('journal deletion failed')
    expect(published).toHaveBeenCalledTimes(1)
    expect(fixture.auditNames()).toHaveLength(1)
    fixture.assertBlocked()
    const retained = readFileSync(fixture.path)
    const filename = fixture.auditNames()[0]!
    const content = readFileSync(join(fixture.directory, '.operations', filename), 'utf8')
    const record = JSON.parse(content)
    expect(record.journalContent).toBe(retained.toString())
    expect(JSON.parse(record.journalContent)).toMatchObject({ lifecycleRevision: 0, state: 'closed' })
    expect(JSON.parse(record.journalContent).dispatch.effects.map((effect: { result: unknown }) => effect.result))
      .toEqual([{ kind: 'comment', id: 800 }, { kind: 'close', state: 'closed' }])
    const counts = fixture.effectCounts()
    fault.mockRestore()
    await expect(fixture.run()).rejects.toThrow(accounting.interruptedIssueCloseMessage({
      record, digest: createHash('sha256').update(content).digest('hex'),
    }))
    expect(published).toHaveBeenCalledTimes(1)
    expect(fixture.effectCounts()).toEqual(counts)
    expect(existsSync(fixture.path)).toBe(false)
    expect(fixture.auditNames()).toEqual([filename])
    expect(readFileSync(join(fixture.directory, '.operations', filename), 'utf8')).toBe(content)
    fixture.settle()
    expect(fixture.store.get(0)!.status).toBe('cancelled')
  })

  it.each(['comment', 'lifecycle', 'startedAt', 'fullJournal'] as const)(
    'does not consume accounted cleanup authority for a changed %s', async mismatch => {
      const fixture = plainAccountingFixture()
      const fault = vi.spyOn(accounting, 'removeAccountedIssueClose').mockImplementationOnce(() => {
        throw new Error('fixture: journal deletion failed')
      })
      github.getIssue.mockImplementationOnce(async () => { fixture.request(); return { state: 'open' } })
      await expect(fixture.run()).rejects.toThrow('journal deletion failed')
      fault.mockRestore()
      expect(JSON.parse(readFileSync(fixture.path, 'utf8')).dispatch.effects).toEqual([])
      if (mismatch !== 'comment') {
        const receipt = JSON.parse(readFileSync(fixture.path, 'utf8'))
        if (mismatch === 'lifecycle') receipt.lifecycleRevision = 1
        if (mismatch === 'startedAt') receipt.startedAt = '2026-01-01T00:00:00.000Z'
        if (mismatch === 'fullJournal') receipt.extraFact = 'not in the immutable accounting'
        writeFileSync(fixture.path, JSON.stringify(receipt, null, 2))
      }
      const retained = readFileSync(fixture.path)
      const counts = fixture.effectCounts()
      await expect(fixture.run(mismatch === 'comment' ? 'Different close decision.' : undefined))
        .rejects.toThrow(/comment|lifecycle|accounting|journal changed/i)
      expect(readFileSync(fixture.path)).toEqual(retained)
      expect(fixture.effectCounts()).toEqual(counts)
      expect(fixture.auditNames()).toHaveLength(1)
      fixture.assertBlocked()
    },
  )

  it('does not use a corrupt audit as authority or treat its namespace as an active journal', async () => {
    const fixture = plainAccountingFixture()
    const fault = vi.spyOn(accounting, 'removeAccountedIssueClose').mockImplementationOnce(() => {
      throw new Error('fixture: journal deletion failed')
    })
    github.createComment.mockImplementationOnce(async () => { fixture.request(); return { id: 801, body: '' } })
    await expect(fixture.run()).rejects.toThrow('journal deletion failed')
    fault.mockRestore()
    const auditPath = join(fixture.directory, '.operations', fixture.auditNames()[0]!)
    const originalAudit = readFileSync(auditPath)
    writeFileSync(auditPath, '{}')
    const retained = readFileSync(fixture.path)
    expect(JSON.parse(retained.toString()).dispatch.effects).toEqual([
      expect.objectContaining({ kind: 'comment', result: { kind: 'comment', id: 801 }, returnedAt: expect.any(String) }),
    ])
    expect(github.createComment).toHaveBeenCalledTimes(1)
    expect(github.closeIssue).not.toHaveBeenCalled()
    const counts = fixture.effectCounts()
    await expect(fixture.run()).rejects.toThrow(/accounting.*unavailable/)
    expect(readFileSync(fixture.path)).toEqual(retained)
    expect(fixture.effectCounts()).toEqual(counts)
    fixture.assertBlocked()
    writeFileSync(auditPath, originalAudit)
    await expect(fixture.run()).rejects.toThrow('Local pause/cancel remains user-controlled')
    writeFileSync(auditPath, '{}')
    expect(() => journals.assertNoPendingIssueClose(fixture.directory, fixture.todo.id!)).not.toThrow()
    fixture.settle()
    expect(fixture.store.get(0)!.status).toBe('paused')
  })

  it('allows only the exact parsed own managed journal, including its supplied comment digest', () => {
    const directory = getContribDir('owner', 'repo')
    const store = new TodoStore(directory)
    const todo = store.add({ ref: '#12', title: 'Exact owned journal guard', type: 'bug' })
    const execution = store.activateExecution(0).execution
    const allowed = {
      owner: 'owner', repo: 'repo', issueNumber: 12, todoId: todo.id!, executionId: execution.id,
      closureId: 'managed-issue-close', lifecycleRevision: 0,
      commentDigest: createHash('sha256').update('Exact close decision.').digest('hex'),
    }
    const path = journals.issueCloseReceiptPath(directory, 'owner', 'repo', 12, todo.id!, execution.id)
    const { commentDigest, ...identity } = allowed
    journals.writeIssueCloseReceipt(path, {
      ...identity, state: 'pending', startedAt: '2026-09-17T01:00:00.000Z',
      dispatch: { version: 1, commentDigest, initializedAt: '2026-09-17T01:00:00.000Z', effects: [] },
    })
    expect(() => journals.assertNoPendingIssueClose(directory, todo.id!, allowed)).not.toThrow()
    // Local stopped, settlement, resume and relocation receive no exception.
    expect(() => journals.assertNoPendingIssueClose(directory, todo.id!)).toThrow(/issue_close.*accounted/)
    for (const mismatch of [
      { owner: 'another-owner' }, { repo: 'another-repo' }, { issueNumber: 13 },
      { todoId: 'another-todo' }, { executionId: 'another-execution' },
      { closureId: 'another-closure' }, { lifecycleRevision: 1 }, { commentDigest: '0'.repeat(64) },
    ]) {
      expect(() => journals.assertNoPendingIssueClose(directory, todo.id!, { ...allowed, ...mismatch }))
        .toThrow(/issue_close.*accounted/)
    }
    const before = readFileSync(path)
    const other = { ...identity, todoId: 'other-todo', issueNumber: 13 }
    const otherPath = journals.issueCloseReceiptPath(directory, 'owner', 'repo', 13, other.todoId, execution.id)
    writeFileSync(otherPath, JSON.stringify(other))
    expect(() => journals.assertNoPendingIssueClose(directory, todo.id!, allowed)).toThrow()
    expect(readFileSync(path)).toEqual(before)
  })

  it.each((['pause', 'cancel'] as const).flatMap(kind =>
    (['getIssue', 'createComment', 'closeIssue'] as const).map(boundary => ({ kind, boundary })),
  ))('fences local $kind settlement until original plain $boundary returns', async ({ kind, boundary }) => {
    const directory = getContribDir('owner', 'repo')
    const store = new TodoStore(directory)
    const todo = store.add({ ref: '#12', title: 'Plain Issue control settlement gate', type: 'bug' })
    const execution = store.activateExecution(0).execution
    const path = journals.issueCloseReceiptPath(directory, 'owner', 'repo', 12, todo.id!, execution.id)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered = false
    let settlementError: unknown
    let beforeSettlement: Buffer | undefined
    let afterSettlement: Buffer | undefined
    let beforeJournal: Buffer | undefined
    let afterJournal: Buffer | undefined
    github[boundary].mockImplementationOnce(async () => {
      store.applyWorkflow(todo.id!, execution.id, {
        request_id: kind, expected_revision: 0,
        command: { action: 'request_control', control_id: kind, kind,
          decision: `fixture:user-${kind}`, note: 'Stop the original still-awaited Issue call.' },
      })
      beforeSettlement = readFileSync(join(directory, 'todos.yaml'))
      beforeJournal = readFileSync(path)
      try {
        const expected_revision = store.get(0)!.executions[0]!.workflow!.revision
        if (kind === 'pause') {
          settleControl('settle_pause', {
            directory, todo_id: todo.id!, execution_id: execution.id, request_id: 'settle',
            expected_revision, control_id: kind, actor: 'primary',
          })
        }
        else {
          closeManaged({
            directory, todo_id: todo.id!, execution_id: execution.id, closure_id: 'local-stop',
            expected_revision, mode: 'stopped', acknowledged_gaps: [], decision: `fixture:user-${kind}`,
            note: 'Settle the requested cancellation.', target: { kind: 'local' },
          })
        }
      }
      catch (error) { settlementError = error }
      afterSettlement = readFileSync(join(directory, 'todos.yaml'))
      afterJournal = readFileSync(path)
      entered = true
      await gate
      return boundary === 'createComment' ? { id: 801, body: '' }
        : { state: boundary === 'getIssue' ? 'open' : 'closed' }
    })
    const closing = issueClose(12, 'Original close decision.', todo.id, 'owner/repo')
      .then(() => undefined, error => error as Error)
    try {
      await vi.waitFor(() => expect(entered).toBe(true))
      expect(existsSync(path)).toBe(true)
      expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveProperty('lifecycleRevision', 0)
    }
    finally { release() }
    await closing
    expect(settlementError, 'A retained Issue journal must fence local settlement while the original call is awaiting.')
      .toBeInstanceOf(Error)
    expect((settlementError as Error).message).toMatch(/issue_close.*accounted/i)
    expect(afterSettlement).toEqual(beforeSettlement)
    expect(afterJournal).toEqual(beforeJournal)
    expect(github.createComment).toHaveBeenCalledTimes(boundary === 'createComment' || boundary === 'closeIssue' ? 1 : 0)
    expect(github.closeIssue).toHaveBeenCalledTimes(boundary === 'closeIssue' ? 1 : 0)
  })

  it.each(['getIssue', 'closeIssue'] as const)(
    'rejects a stale unstarted lifecycle completed and reopened during %s, including retry', async boundary => {
      const directory = getContribDir('owner', 'repo')
      const store = new TodoStore(directory)
      const todo = store.add({ ref: '#13', title: 'Unstarted lifecycle race', type: 'bug' })
      expect(todo.executions).toEqual([])
      const path = journals.issueCloseReceiptPath(directory, 'owner', 'repo', 13, todo.id!, null)
      let reopened: Buffer | undefined
      github[boundary].mockImplementationOnce(async () => {
        await Promise.resolve()
        expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
          todoId: todo.id, executionId: null, state: 'pending', lifecycleRevision: 0,
        })
        store.completeTodo(0, 'done', 'Completed independently during the old Issue request.')
        store.reopen(todo.id!)
        expect(store.get(0)).toMatchObject({
          id: todo.id, status: 'backlog', lifecycle_revision: 1, executions: [],
        })
        reopened = readFileSync(join(directory, 'todos.yaml'))
        return { state: boundary === 'getIssue' ? 'open' : 'closed' }
      })

      const error = await issueClose(13, 'Original lifecycle only.', todo.id, 'owner/repo')
        .then(() => undefined, error => error)
      expect.soft(error).toBeInstanceOf(Error)
      expect.soft(reopened).toBeDefined()
      expect.soft(readFileSync(join(directory, 'todos.yaml'))).toEqual(reopened)
      expect.soft(store.get(0)).toMatchObject({
        id: todo.id, status: 'backlog', lifecycle_revision: 1, executions: [],
      })
      expect.soft(github.createComment).toHaveBeenCalledTimes(boundary === 'getIssue' ? 0 : 1)
      expect.soft(github.closeIssue).toHaveBeenCalledTimes(boundary === 'getIssue' ? 0 : 1)
      expect.soft(existsSync(path)).toBe(true)
      const retained = existsSync(path) ? readFileSync(path) : undefined
      if (retained) expect.soft(JSON.parse(retained.toString())).toMatchObject({
        todoId: todo.id, executionId: null, lifecycleRevision: 0,
        state: boundary === 'getIssue' ? 'pending' : 'closed',
      })

      github.getIssue.mockClear()
      github.getIssueComments.mockClear()
      github.createComment.mockClear()
      github.closeIssue.mockClear()
      await expect.soft(issueClose(13, 'Original lifecycle only.', todo.id, 'owner/repo')).rejects.toThrow()
      expect.soft(github.getIssue).not.toHaveBeenCalled()
      expect.soft(github.getIssueComments).not.toHaveBeenCalled()
      expect.soft(github.createComment).not.toHaveBeenCalled()
      expect.soft(github.closeIssue).not.toHaveBeenCalled()
      expect.soft(readFileSync(join(directory, 'todos.yaml'))).toEqual(reopened)
      expect.soft(existsSync(path)).toBe(true)
      if (existsSync(path)) {
        expect.soft(readFileSync(path)).toEqual(retained)
        expect.soft(JSON.parse(readFileSync(path, 'utf8'))).toHaveProperty('lifecycleRevision', 0)
      }
      expect(store.listArchived()).toEqual([])
    },
  )

  it('serializes concurrent close attempts so only one remote close can run', async () => {
    const store = new TodoStore(getContribDir('owner', 'repo'))
    const target = store.add({ ref: '#9', title: 'Concurrent close', type: 'bug' })
    let releaseClose!: () => void
    github.closeIssue.mockReturnValue(new Promise<{ state: string }>(resolve => { releaseClose = () => resolve({ state: 'closed' }) }))

    const first = issueClose(9, undefined, target.id, 'owner/repo')
    await vi.waitFor(() => expect(github.closeIssue).toHaveBeenCalledTimes(1))
    const second = issueClose(9, undefined, target.id, 'owner/repo')
    await new Promise(resolve => setTimeout(resolve, 75))
    expect(github.closeIssue).toHaveBeenCalledTimes(1)

    releaseClose()
    await first
    await expect(second).resolves.toContain('already done locally')
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
  })

  it('skips an unlinked close when GitHub already reports the issue closed', async () => {
    github.getIssue.mockResolvedValue({ state: 'closed' })

    const result = await issueClose(10, undefined, undefined, 'owner/repo')

    expect(result).toMatch(/already closed/i)
    expect(github.closeIssue).not.toHaveBeenCalled()
  })

  it('rechecks GitHub after serializing concurrent unlinked close attempts', async () => {
    let state = 'open'
    let releaseClose!: () => void
    github.getIssue.mockImplementation(async () => ({ state }))
    github.closeIssue.mockImplementation(async () => {
      await new Promise<void>(resolve => { releaseClose = resolve })
      state = 'closed'
    })

    const first = issueClose(11, undefined, undefined, 'owner/repo')
    await vi.waitFor(() => expect(github.closeIssue).toHaveBeenCalledTimes(1))
    const second = issueClose(11, undefined, undefined, 'owner/repo')
    await new Promise(resolve => setTimeout(resolve, 75))
    expect(github.closeIssue).toHaveBeenCalledTimes(1)

    releaseClose()
    await Promise.all([first, second])
    expect(github.closeIssue).toHaveBeenCalledTimes(1)
    expect(github.getIssue).toHaveBeenCalledTimes(2)
  })
})
