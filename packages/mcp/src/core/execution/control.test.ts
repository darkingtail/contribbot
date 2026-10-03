import { describe, expect, it } from 'vitest'
import type { WorkflowCommand, WorkflowState } from './contracts.js'
import { createWorkflow, normalizeWorkflow, transitionWorkflow } from './workflow.js'
import { fixtureRepository } from './__fixtures__/repository.js'

const stop = { action: 'request_control', control_id: 'pause', kind: 'pause',
  decision: 'user:pause-this-task', note: 'Continue tomorrow.' } as const
const send = (state: WorkflowState, command: unknown, request_id = `request-${state.revision}`, expected_revision = state.revision) =>
  transitionWorkflow(state, { request_id, expected_revision, command })
const plan = {
  goal: 'Implement the feature', completion_scope: 'task', remaining_scope: [], non_goals: [], scope: ['.'], risk: 'normal',
  steps: [{ id: 'implement', title: 'Implement', scope: ['.'], depends_on: [], acceptance_ids: ['manual'] }],
  acceptance: [{ id: 'manual', description: 'User accepts', required: true, independent: false, kind: 'manual' }],
}
const sha = 'a'.repeat(64)
const candidate = { digest: sha, root: 'root', git_dir: 'git', common_dir: 'git' }
function boundState() {
  let state = send(createWorkflow(), { action: 'propose_plan', plan_id: 'plan', plan })
  state = send(state, { action: 'confirm_plan', plan_id: 'plan', digest: state.plans[0]!.digest, confirmation: 'user:plan' })
  state = send(state, { action: 'start_attempt', attempt_id: 'attempt', owner: 'owner',
    workspace: { repo: fixtureRepository('fixture/repo'),
      root: 'root', git_dir: 'git', common_dir: 'git', baseline: sha } })
  return send(state, { action: 'yield', actor: 'owner', candidate, observed_operations: [], note: 'Settled' })
}

describe('durable workflow stop intent', () => {
  it('records an unbound design pause without fabricating an attempt or a terminal outcome', () => {
    const initial = createWorkflow()
    const state = send(initial, stop)
    expect(state).toMatchObject({
      revision: 1, epoch: 0, attempts: [], operations: [], closure: null,
      control: { active_id: 'pause', requests: [{ id: 'pause', kind: 'pause', decision: stop.decision }] },
    })
    expect(normalizeWorkflow(state)).toEqual(state)
    expect(initial).not.toHaveProperty('control')
    expect(send(state, stop, 'request-0', 0)).toEqual(state)
    expect(() => send(state, { ...stop, note: 'Different' }, 'request-0', 0)).toThrow(/reuse/i)
    expect(() => send(state, { ...stop, control_id: 'other' })).toThrow(/control|pending/i)
    expect(() => send(state, { action: 'propose_plan', plan_id: 'plan', plan })).toThrow(/control|pause/i)
  })

  it('accepts stop intent during a closure but does not finish or erase that closure', () => {
    let state = send(boundState(), { action: 'reserve_closure', intent: {
      id: 'close', mode: 'verified', decision: 'original decision', note: 'Original closure',
      acknowledged_gaps: [], target: { kind: 'local' },
    } })
    state = send(state, stop)
    expect(state.closing_id).toBe('close')
    expect(state.closure).toBeNull()
    expect(() => send(state, { action: 'prepare_closure', closure_id: 'close',
      candidate, verification: sha, gaps: [] })).toThrow(/control|pause/i)
    const recovered = send(state, { action: 'cancel_closure', closure_id: 'close', note: 'Withdraw original local reservation.' })
    expect(recovered.closing_id).toBeNull()
    expect(recovered.control?.active_id).toBe('pause')
  })

  it('does not interpret arbitrary control metadata as a valid active stop', () => {
    const state = send(createWorkflow(), stop)
    expect(() => normalizeWorkflow({ ...state, control: { ...state.control, active_id: 'missing' } })).toThrow()
  })

  it('fences fresh work but preserves exact historical readback', () => {
    let state = send(createWorkflow(), { action: 'propose_plan', plan_id: 'plan', plan }, 'original')
    state = send(state, stop)
    expect(send(state, { action: 'propose_plan', plan_id: 'plan', plan }, 'original', 0)).toEqual(state)
    const command: WorkflowCommand = { action: 'confirm_plan', plan_id: 'plan',
      digest: state.plans[0]!.digest, confirmation: 'old-user-turn' }
    expect(() => send(state, command)).toThrow(/control|pause/i)
  })

  it.each(['cancel', 'pause'] as const)('keeps a prepared Issue reservation until reconciliation names the exact %s', kind => {
    let state = send(boundState(), { action: 'reserve_closure', intent: { id: 'issue-close', mode: 'with_gaps',
      decision: 'user:original', note: 'Original Issue operation', acknowledged_gaps: ['acceptance:manual'],
      target: { kind: 'issue', repo: fixtureRepository('fixture/repo'), issue_number: 1 } } })
    state = send(state, { action: 'prepare_closure', closure_id: 'issue-close', candidate, verification: sha, gaps: ['acceptance:manual'] })
    state = send(state, { ...stop, kind, control_id: kind })
    state = send(state, { action: 'closure_remote_receipt', closure_id: 'issue-close', receipt: sha })
    expect(() => send(state, { action: 'reconcile_closure', closure_id: 'issue-close', actor: 'owner',
      decision: 'user:cancel', candidate, receipt: sha, remote_receipt: sha })).toThrow(/cancel|decision|control/i)
    expect(state.closing_id).toBe('issue-close')
    expect(state.closings[0]?.remote_receipt).toBe(sha)
    const reconciled = send(state, { action: 'reconcile_closure', closure_id: 'issue-close', actor: 'owner',
      decision: stop.decision, control_id: kind, candidate, receipt: sha, remote_receipt: sha })
    expect(reconciled.closing_id).toBeNull()
    expect(reconciled.control?.active_id).toBe(kind)
    expect(reconciled.closure).toBeNull()
    expect(reconciled.yield).toBeNull()
    expect(reconciled.closings[0]?.reconciliation?.control_id).toBe(kind)
    expect(normalizeWorkflow(reconciled)).toEqual(reconciled)
    expect(() => send(reconciled, { action: 'prepare_closure', closure_id: 'issue-close',
      candidate, verification: sha, gaps: [] })).toThrow()
  })

  it('does not prepare unbound Issue effects while still allowing unbound local cancellation', () => {
    const intent = { id: 'unbound', mode: 'stopped', decision: 'user:cancel', note: 'No work started',
      acknowledged_gaps: [], target: { kind: 'issue', repo: fixtureRepository('fixture/repo'), issue_number: 1 } }
    expect(() => send(createWorkflow(), { action: 'reserve_closure', intent })).toThrow(/bound|local/i)
    const cancelled = send(createWorkflow(), { ...stop, kind: 'cancel', control_id: 'cancel', decision: intent.decision })
    expect(send(cancelled, { action: 'reserve_closure', intent: { ...intent, target: { kind: 'local' } } })
      .closing_id).toBe('unbound')
  })
})
