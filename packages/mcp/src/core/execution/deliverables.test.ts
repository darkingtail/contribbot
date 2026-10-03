import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TodoStore } from '../storage/todo-store.js'
import { ExecutionArtifacts } from './artifacts.js'
import { captureCandidate } from './candidate.js'
import { prepareClosure, finalizeClosure } from './closure.js'
import type { WorkflowPlanInput } from './contracts.js'
import { runLocalCommand } from './local.js'
import { planDigest } from './workflow.js'
import { verifyReadiness } from './verification.js'
import { fixtureProjectDirectory, fixtureRepository, saveFixtureProjectConfig } from './__fixtures__/repository.js'

const acceptance = { id: 'review', description: 'Inspect the delivered content', kind: 'manual' as const, required: true, independent: false }
const legacyPlan: WorkflowPlanInput = {
  goal: 'Deliver a report', completion_scope: 'task', remaining_scope: [], non_goals: [], scope: ['.'], risk: 'normal',
  steps: [{ id: 'write', title: 'Write report', scope: ['.'], depends_on: [], acceptance_ids: ['review'] }],
  acceptance: [acceptance],
}
const fileDelivery = {
  id: 'report', description: 'Reviewed report', required: true, acceptance_ids: ['review'],
  target: { kind: 'file' as const, path: 'report.md' },
}
const filePlan = () => ({ ...structuredClone(legacyPlan), deliverables: [structuredClone(fileDelivery)] })

describe('plan-bound local delivery declarations', () => {
  it('binds declarations to the confirmed digest, while leaving legacy input untouched', () => {
    const before = structuredClone(legacyPlan)
    expect(planDigest(filePlan())).not.toBe(planDigest(legacyPlan))
    expect(planDigest({ ...filePlan(), deliverables: [{ ...fileDelivery, required: false }] })).not.toBe(planDigest(filePlan()))
    expect(legacyPlan).toEqual(before)
    expect(legacyPlan).not.toHaveProperty('deliverables')
    expect(planDigest({ ...legacyPlan, deliverables: [] })).not.toBe(planDigest(legacyPlan))
  })

  it('rejects duplicate ids, duplicate or unknown references and targets outside the plan scope', () => {
    expect(() => planDigest({ ...filePlan(), deliverables: [fileDelivery, fileDelivery] })).toThrow(/duplicate.*deliver/i)
    expect(() => planDigest({ ...filePlan(), deliverables: [{ ...fileDelivery, acceptance_ids: ['review', 'review'] }] })).toThrow(/duplicate/i)
    expect(() => planDigest({ ...filePlan(), deliverables: [{ ...fileDelivery, acceptance_ids: ['absent'] }] })).toThrow(/unknown.*acceptance/i)
    expect(() => planDigest({
      ...filePlan(), scope: ['src'],
      steps: [{ ...legacyPlan.steps[0]!, scope: ['src'] }],
    })).toThrow(/delivery.*scope/i)
  })

  it.each(['.', '../report.md', '/report.md', 'D:/report.md', 'dir\\report.md', 'dir//report.md'])('rejects unsafe file target %s', path => {
    expect(() => planDigest({ ...filePlan(), deliverables: [{ ...fileDelivery, target: { kind: 'file', path } }] })).toThrow()
  })

  it('requires a required content review for file delivery but permits command-checked workspace delivery', () => {
    expect(() => planDigest({ ...filePlan(), acceptance: [{ ...acceptance, required: false }, {
      ...acceptance, id: 'other',
    }] })).toThrow(/required.*acceptance|manual|review/i)
    const commandPlan = {
      ...filePlan(), acceptance: [{
        ...acceptance, kind: 'command', command: { executable: 'node', argv: ['test.cjs'], timeout_ms: 1000, max_output_bytes: 4096 },
      }],
    }
    expect(() => planDigest(commandPlan)).toThrow(/manual|review/i)
    expect(() => planDigest({ ...commandPlan, deliverables: [{ ...fileDelivery, target: { kind: 'workspace' } }] })).not.toThrow()
  })

  it('rejects unsupported remote targets and caller-provided satisfaction flags', () => {
    expect(() => planDigest({ ...filePlan(), deliverables: [{ ...fileDelivery, target: { kind: 'pr', repo: 'fixture/repo', number: 1 } }] })).toThrow()
    expect(() => planDigest({ ...filePlan(), deliverables: [{ ...fileDelivery, satisfied: true }] })).toThrow()
  })
})

describe('delivery verification against actual candidates and report receipts', () => {
  let home: string
  let workspace: string
  let directory: string
  let store: TodoStore
  let todoId: string
  let executionId: string
  let serial: number
  const state = () => store.get(0)!.executions[0]!.workflow!
  const local = (action: string, payload: Record<string, unknown> = {}) => runLocalCommand({
    action, repo: fixtureRepository('fixture/delivery'), data_root: join(home, 'data'),
    todo_id: todoId, execution_id: executionId, ...payload,
  })
  const mutation = () => ({ request_id: `fixture-${++serial}`, expected_revision: state()?.revision ?? 0 })
  const yieldFiles = () => local('yield', {
    ...mutation(), actor: 'builder',
    observed_operations: state().operations.filter(operation => operation.attempt_id === state().attempt_id).map(operation => operation.id),
    note: 'Fixture writers stopped.',
  })
  const report = (id = 'review', outcome = 'passed') => local('report', {
    ...mutation(), operation_id: `report-${serial}`, acceptance_id: id,
    plan_id: state().plan_id, attempt_id: state().attempt_id, epoch: state().epoch, candidate: state().yield!.candidate,
    actor: 'fixture-user', source: 'user', observed_at: new Date().toISOString(), outcome,
    locator: 'fixture:explicit-user-observation', summary: `Fixture ${id} observation`,
  })
  const setup = async (plan: WorkflowPlanInput = filePlan()) => {
    await local('apply', { ...mutation(), command: { action: 'propose_plan', plan_id: 'plan', plan } })
    await local('apply', { ...mutation(), command: {
      action: 'confirm_plan', plan_id: 'plan', digest: state().plans[0]!.digest, confirmation: 'fixture:exact-deliveries-confirmed',
    } })
    await local('bind', { ...mutation(), attempt_id: 'attempt', owner: 'builder', workspace })
    await yieldFiles()
  }
  const closure = (mode = 'verified', acknowledged_gaps: string[] = []) => ({
    directory, todo_id: todoId, execution_id: executionId, closure_id: `close-${++serial}`,
    expected_revision: state().revision, mode, acknowledged_gaps,
    decision: 'fixture:explicit-whole-task-decision', note: 'Fixture completion', target: { kind: 'local' },
  })
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-delivery-'))
    workspace = join(home, 'workspace')
    directory = fixtureProjectDirectory(join(home, 'data'), 'fixture/delivery')
    mkdirSync(workspace)
    const git = (...args: string[]) => execFileSync('git', [
      '-c', 'core.hooksPath=nonexistent-hooks', '-c', 'commit.gpgSign=false', ...args,
    ], { cwd: workspace, windowsHide: true, stdio: 'pipe' })
    git('init', '--quiet', '--initial-branch=fixture')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('remote', 'add', 'origin', 'https://github.com/fixture/delivery.git')
    writeFileSync(join(workspace, 'source.txt'), 'existing code')
    writeFileSync(join(workspace, '.gitignore'), 'ignored.md\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'fixture')
    saveFixtureProjectConfig(directory, 'fixture/delivery')
    store = new TodoStore(directory)
    todoId = store.add({ ref: 'delivery', title: 'Deliver a report', type: 'docs' }).id!
    executionId = store.activateExecution(0).execution.id
    serial = 0
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('blocks missing required files even with a passed report or acknowledged verification gaps', async () => {
    await setup()
    await report()
    const inspected = await local('inspect')
    expect(inspected.readiness).toMatchObject({
      ready: false, gaps: ['delivery:report'],
      deliveries: [{ id: 'report', endpoint: 'missing', acceptance: [{ id: 'review', outcome: 'passed' }] }],
    })
    for (const mode of ['verified', 'with_gaps']) {
      expect(() => prepareClosure(closure(mode, ['delivery:report']))).toThrow(/delivery.*report|report.*delivery/i)
    }
    expect(store.get(0)!.status).toBe('active')
    expect(state().closure).toBeNull()
    expect(store.listArchived()).toEqual([])
  }, 30_000)

  it('verifies files, preserves optional receipt failures as nonblocking observations and keeps context read-only', async () => {
    writeFileSync(join(workspace, 'report.md'), 'Reviewed content')
    const plan = filePlan()
    plan.acceptance.push({ ...acceptance, id: 'optional', required: false })
    plan.deliverables.push({ ...fileDelivery, id: 'extra', required: false, acceptance_ids: ['optional'] })
    await setup(plan)
    await report()
    await report('optional')
    const check = state().checks.at(-1)!
    writeFileSync(join(directory, 'executions', executionId, 'artifacts', `${check.receipt}.json`), '{"tampered":true}')
    const inspected = await local('inspect')
    expect(inspected.readiness).toMatchObject({
      ready: true, gaps: [],
      deliveries: [
        { id: 'report', endpoint: 'present', acceptance: [{ id: 'review', outcome: 'passed' }] },
        { id: 'extra', endpoint: 'present', acceptance: [{ id: 'optional', outcome: 'invalid' }] },
      ],
    })
    const before = readFileSync(join(directory, 'todos.yaml'), 'utf8')
    const context = await local('context')
    expect(context).toMatchObject({
      readiness: null, workspace_observation: 'not_observed',
      delivery_requirements: { declared: true, confirmed: true, items: plan.deliverables },
    })
    expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toBe(before)
    const projection = context.document_projection as { path: string }
    const record = readFileSync(projection.path, 'utf8')
    expect(record).toContain('report.md')
    expect(record).toContain('Delivery requirements')
  }, 30_000)

  it('keeps optional failures nonblocking on required delivery', async () => {
    writeFileSync(join(workspace, 'report.md'), 'Reviewed content')
    const plan = filePlan()
    plan.acceptance.push({ ...acceptance, id: 'optional', required: false })
    plan.deliverables[0]!.acceptance_ids.push('optional')
    await setup(plan)
    await report()
    await report('optional', 'failed')
    expect((await local('inspect')).readiness).toMatchObject({
      ready: true, gaps: [], deliveries: [{ acceptance: [{ outcome: 'passed' }, { outcome: 'failed' }] }],
    })
    const request = closure()
    prepareClosure(request)
    expect(finalizeClosure(request).status).toBe('done')
  }, 30_000)

  it('does not let an optional delivery waive an independently required acceptance criterion', async () => {
    await setup({ ...filePlan(), deliverables: [{ ...fileDelivery, required: false }] })
    expect((await local('inspect')).readiness).toMatchObject({
      ready: false, gaps: ['acceptance:review'], deliveries: [{ required: false, endpoint: 'missing' }],
    })
    await report()
    expect((await local('inspect')).readiness).toMatchObject({
      ready: true, gaps: [], deliveries: [{ required: false, endpoint: 'missing' }],
    })
  }, 20_000)

  it.each(['absent', 'deleted', 'ignored'])('does not satisfy an %s required file with an unrelated passing observation', async kind => {
    let path = 'report.md'
    if (kind === 'deleted') {
      path = 'source.txt'
      rmSync(join(workspace, path))
    }
    if (kind === 'ignored') {
      path = 'ignored.md'
      writeFileSync(join(workspace, path), 'Excluded from the captured candidate')
    }
    await setup({ ...filePlan(), deliverables: [{ ...fileDelivery, target: { kind: 'file', path } }] })
    await report()
    expect((await local('inspect')).readiness).toMatchObject({
      ready: false, gaps: ['delivery:report'], deliveries: [{ endpoint: 'missing' }],
    })
  }, 20_000)

  it('requires fresh acceptance after candidate edits and rechecks a prepared closure before finalizing', async () => {
    writeFileSync(join(workspace, 'report.md'), 'Candidate A')
    await setup()
    await report()
    writeFileSync(join(workspace, 'report.md'), 'Candidate B')
    await yieldFiles()
    expect((await local('inspect')).readiness).toMatchObject({
      ready: false, gaps: ['acceptance:review'],
      deliveries: [{ endpoint: 'present', acceptance: [{ outcome: 'missing' }] }],
    })
    await report()
    const request = closure()
    prepareClosure(request)
    rmSync(join(workspace, 'report.md'))
    expect(() => prepareClosure(request)).toThrow(/drift/i)
    expect(() => finalizeClosure(request)).toThrow(/drift/i)
    expect(state().closure).toBeNull()
    writeFileSync(join(workspace, 'report.md'), 'Candidate B')
    expect(finalizeClosure(request).status).toBe('done')
    const verification = new ExecutionArtifacts(directory, executionId).get(state().closings.at(-1)!.verification!) as Record<string, unknown>
    expect(verification).toMatchObject({ deliveries: [{ id: 'report', endpoint: 'present' }] })
    expect(verification.manifest).toMatch(/^[a-f0-9]{64}$/)
    rmSync(join(workspace, 'report.md'))
    expect(finalizeClosure(request).status).toBe('done')
  }, 30_000)

  it('allows acknowledged acceptance gaps only when the required endpoint exists', async () => {
    writeFileSync(join(workspace, 'report.md'), 'Unreviewed content')
    await setup()
    const request = closure('with_gaps', ['acceptance:review'])
    prepareClosure(request)
    const todo = finalizeClosure(request)
    expect(todo.status).toBe('done')
    expect(state().closure).toMatchObject({ mode: 'with_gaps', gaps: ['acceptance:review'] })
  }, 20_000)

  it('allows safe stopping with missing delivery, without claiming it was delivered', async () => {
    await setup()
    await local('apply', { ...mutation(), command: {
      action: 'request_control', control_id: 'cancel', kind: 'cancel',
      decision: 'fixture:explicit-whole-task-decision', note: 'Cancel without claiming delivery.',
    } })
    const request = closure('stopped')
    prepareClosure(request)
    finalizeClosure(request)
    expect(state().closure).toMatchObject({ mode: 'stopped', gaps: ['acceptance:review', 'delivery:report'] })
    expect(store.get(0)!.status).toBe('cancelled')
  }, 20_000)

  it('does not manufacture filesystem verification from a stored candidate reference', async () => {
    writeFileSync(join(workspace, 'report.md'), 'Reviewed content')
    await setup()
    await report()
    const result = verifyReadiness(directory, todoId, executionId, state(), state().yield!.candidate)
    expect(result).toMatchObject({
      ready: false, gaps: ['delivery:report'], deliveries: [{ endpoint: 'not_observed' }],
    })
    const mismatched = { ...captureCandidate(workspace), digest: 'f'.repeat(64) }
    expect(() => verifyReadiness(directory, todoId, executionId, state(), state().yield!.candidate, false, mismatched))
      .toThrow(/manifest/i)
  }, 20_000)

  it('retains declared deliveries and old reports on pause, but requires fresh checks after continuing', async () => {
    writeFileSync(join(workspace, 'report.md'), 'Candidate before pause')
    await setup()
    await report()
    await local('apply', { ...mutation(), command: {
      action: 'request_control', control_id: 'pause', kind: 'pause', decision: 'fixture:pause', note: 'User pauses',
    } })
    await local('settle-pause', { ...mutation(), control_id: 'pause', actor: 'builder' })
    await local('continue', { ...mutation(), control_id: 'pause', actor: 'builder', decision: 'fixture:continue' })
    await yieldFiles()
    expect((await local('inspect')).readiness).toMatchObject({
      ready: false, gaps: ['acceptance:review'],
      deliveries: [{ endpoint: 'present', acceptance: [{ outcome: 'missing' }] }],
    })
    expect(state().checks).toHaveLength(1)
    expect(state().plans[0]!.content.deliverables).toEqual([fileDelivery])
  }, 30_000)

  it.each([false, true])('accepts a workspace target without requiring added files (deletion=%s)', async deletion => {
    if (deletion) rmSync(join(workspace, 'source.txt'))
    await setup({ ...filePlan(), deliverables: [{ ...fileDelivery, target: { kind: 'workspace' } }] })
    await report()
    expect((await local('inspect')).readiness).toMatchObject({
      ready: true, deliveries: [{ endpoint: 'present' }],
    })
    const request = closure()
    prepareClosure(request)
    expect(finalizeClosure(request).status).toBe('done')
  }, 20_000)

  it('retains legacy absence and does not derive requirements from PR associations', async () => {
    await setup(legacyPlan)
    store.update(0, { pr: 42, pull_requests: [{ repo: fixtureRepository('fixture/delivery'), number: 42 }] })
    await report()
    expect((await local('inspect')).readiness).toMatchObject({ ready: true, deliveries: [] })
    expect((await local('context')).delivery_requirements).toMatchObject({ declared: false, items: [] })
    expect(state().plans[0]!.content).not.toHaveProperty('deliverables')
    expect(state().plans[0]!.digest).toBe(planDigest(legacyPlan))
  }, 20_000)
})
