import { describe, expect, it } from 'vitest'
import { assertClosureCoverage, completionCoverage, createWorkflow, normalizeWorkflow, planDigest, transitionWorkflow, workflowReadiness } from './workflow.js'
import type { ClosureIntent, WorkflowCommand, WorkflowPlanInput, WorkflowState } from './contracts.js'
import { fixtureRepository } from './__fixtures__/repository.js'

const sha = 'a'.repeat(64)
const workspace = {
  repo: { platform: 'github' as const, instance: 'https://github.com', path: 'fixture/repo' },
  root: 'fixture-root', git_dir: 'fixture-git', common_dir: 'fixture-git',
  baseline: sha,
}
const candidate = { digest: sha, root: workspace.root, git_dir: workspace.git_dir, common_dir: workspace.common_dir }
const plan: WorkflowPlanInput = {
  completion_scope: 'task', remaining_scope: [],
  goal: 'Implement a usable workflow', non_goals: ['Publish changes'], scope: ['src'],
  risk: 'normal',
  steps: [{ id: 'implement', title: 'Implement feature', scope: ['src'], depends_on: [], acceptance_ids: ['behavior'] }],
  acceptance: [{
    id: 'behavior', description: 'The command exercises the feature', required: true,
    kind: 'command', independent: false,
    command: { executable: 'node', argv: ['test.js'], timeout_ms: 1000, max_output_bytes: 4096 },
  }],
}
let sequence = 0
function act(state: WorkflowState, command: WorkflowCommand, requestId = `request-${++sequence}`, revision = state.revision) {
  return transitionWorkflow(state, { request_id: requestId, expected_revision: revision, command })
}
function prepared(input: WorkflowPlanInput = plan): WorkflowState {
  let state = createWorkflow()
  state = act(state, { action: 'propose_plan', plan_id: 'plan-1', plan: input })
  state = act(state, {
    action: 'confirm_plan', plan_id: 'plan-1', digest: planDigest(input), confirmation: 'user-turn-1',
  })
  return act(state, { action: 'start_attempt', attempt_id: 'attempt-1', owner: 'primary', workspace })
}
function yielded(input: WorkflowPlanInput = plan): WorkflowState {
  return act(prepared(input), { action: 'yield', actor: 'primary', candidate, observed_operations: [], note: 'No writers remain.' })
}
function startedCheck(state = yielded()): WorkflowState {
  return act(state, { action: 'begin_check', operation_id: 'check-1', acceptance_id: 'behavior', actor: 'runner', candidate })
}
function passed(state = startedCheck()): WorkflowState {
  return act(state, {
    action: 'complete_check', operation_id: 'check-1', after: candidate, outcome: 'passed',
    source: 'local_runner', receipt: 'artifact-receipt', summary: 'Actual test ran.', process_stopped: true,
  })
}

describe('managed Todo workflow', () => {
  it('requires confirmation of the exact latest plan before starting', () => {
    let state = act(createWorkflow(), { action: 'propose_plan', plan_id: 'plan-1', plan })
    expect(() => act(state, { action: 'start_attempt', attempt_id: 'a', owner: 'primary', workspace })).toThrow(/confirm/i)
    expect(() => act(state, { action: 'confirm_plan', plan_id: 'plan-1', digest: 'b'.repeat(64), confirmation: 'turn' })).toThrow(/digest/i)
    state = act(state, { action: 'propose_plan', plan_id: 'plan-2', plan: { ...plan, goal: 'Changed goal' } })
    expect(() => act(state, { action: 'confirm_plan', plan_id: 'plan-1', digest: planDigest(plan), confirmation: 'turn' })).toThrow(/latest/i)
  })

  it('does not allow empty acceptance, dangling dependencies, cycles or high risk without independent review', () => {
    const propose = (input: WorkflowPlanInput) => act(createWorkflow(), { action: 'propose_plan', plan_id: 'p', plan: input })
    expect(() => propose({ ...plan, acceptance: [] })).toThrow()
    expect(() => propose({ ...plan, steps: [{ ...plan.steps[0]!, depends_on: ['absent'] }] })).toThrow(/depend/i)
    expect(() => propose({ ...plan, steps: [{ ...plan.steps[0]!, depends_on: ['implement'] }] })).toThrow(/cycl|depend/i)
    expect(() => propose({ ...plan, risk: 'high' })).toThrow(/independent/i)
  })

  it('requires stage plans to disclose remaining goals and blocks whole-Todo completion', () => {
    const propose = (input: WorkflowPlanInput) => act(createWorkflow(), { action: 'propose_plan', plan_id: 'p', plan: input })
    expect(() => propose({ ...plan, completion_scope: 'stage' })).toThrow(/remaining/i)
    expect(() => propose({ ...plan, completion_scope: 'task', remaining_scope: ['Finish the rest'] })).toThrow(/remaining/i)

    const stagePlan: WorkflowPlanInput = {
      ...plan, completion_scope: 'stage', remaining_scope: ['Publish the follow-up documentation'],
    }
    const state = passed(startedCheck(yielded(stagePlan)))
    const intent = (mode: ClosureIntent['mode']): ClosureIntent => ({
      id: `close-${mode}`, mode, decision: 'explicit user decision', note: 'fixture',
      acknowledged_gaps: [], target: { kind: 'local' },
    })
    expect(() => assertClosureCoverage(state, candidate, intent('verified'), [])).toThrow(/stage-only|remaining/i)
    expect(() => assertClosureCoverage(state, candidate, intent('with_gaps'), [])).toThrow(/stage-only|remaining/i)
    const cancelled = act(state, { action: 'request_control', control_id: 'cancel', kind: 'cancel',
      decision: 'explicit user decision', note: 'User cancels the remaining work.' })
    expect(assertClosureCoverage(cancelled, candidate, intent('stopped'), [])).toEqual([])
  })

  it('requires explicit coverage on new plans, without filling defaults into legacy digests', () => {
    const { completion_scope: _scope, remaining_scope: _remaining, ...legacy } = plan
    expect(() => act(createWorkflow(), { action: 'propose_plan', plan_id: 'new', plan: legacy })).toThrow(/coverage|completion_scope/i)
    expect(() => act(createWorkflow(), {
      action: 'propose_plan', plan_id: 'new', plan: { ...legacy, remaining_scope: ['Still unknown'] },
    })).toThrow(/coverage|completion_scope/i)
    expect(() => act(createWorkflow(), {
      action: 'propose_plan', plan_id: 'new', plan: { ...legacy, completion_scope: 'task' },
    })).toThrow(/remaining_scope|remaining/i)
    expect(planDigest(legacy)).not.toBe(planDigest(plan))
    expect(legacy).not.toHaveProperty('completion_scope')
  })

  it.each(['stage', 'legacy'] as const)('blocks %s completion before reserving any local or remote effect', scope => {
    let state = passed()
    if (scope === 'stage') {
      state = passed(startedCheck(yielded({
        ...plan, completion_scope: 'stage', remaining_scope: ['Implement and test the feature'],
      })))
    }
    else {
      const { completion_scope: _scope, remaining_scope: _remaining, ...legacy } = state.plans[0]!.content
      state.plans[0]!.content = legacy
      state.plans[0]!.digest = planDigest(legacy)
    }
    const historical = structuredClone(state)
    expect(normalizeWorkflow(state)).toEqual(historical)
    expect(workflowReadiness(state, candidate).ready).toBe(true)
    for (const mode of ['verified', 'with_gaps'] as const) {
      const intent: ClosureIntent = {
        id: `closure-${mode}`, mode, decision: 'fixture:whole-task-acceptance',
        note: 'No inference of full coverage', acknowledged_gaps: ['coverage'],
        target: { kind: 'issue', repo: fixtureRepository('fixture/repo'), issue_number: 1 },
      }
      expect(() => act(state, { action: 'reserve_closure', intent })).toThrow(/stage|coverage|completion_scope/i)
      if (scope === 'stage') {
        expect(() => assertClosureCoverage(state, candidate, intent, [])).toThrow(/stage|coverage|completion_scope/i)
      }
    }
    expect(state).toEqual(historical)
    state = act(state, { action: 'request_control', control_id: 'cancel', kind: 'cancel',
      decision: 'fixture:cancel', note: 'User stops' })
    expect(act(state, { action: 'reserve_closure', intent: {
      id: 'stopped', mode: 'stopped', decision: 'fixture:cancel', note: 'User stops',
      acknowledged_gaps: [], target: { kind: 'local' },
    } }).closing_id).toBe('stopped')
  })

  it('does not infer empty remaining goals from a partially declared persisted plan', () => {
    const state = passed()
    delete state.plans[0]!.content.remaining_scope
    state.plans[0]!.digest = planDigest(state.plans[0]!.content)
    const original = structuredClone(state)
    expect(normalizeWorkflow(state)).toEqual(original)
    expect(completionCoverage(state)).toMatchObject({
      remaining_scope: null, scope_allows_task_completion: false,
    })
    for (const mode of ['verified', 'with_gaps'] as const) {
      expect(() => act(state, { action: 'reserve_closure', intent: {
        id: mode, mode, decision: 'fixture:decision', note: 'Must reconfirm complete coverage',
        acknowledged_gaps: [], target: { kind: 'local' },
      } })).toThrow(/coverage|completion_scope/i)
    }
    expect(state).toEqual(original)
  })

  it.each(['reserved', 'prepared'] as const)('recovers an original legacy %s closure without declaring new coverage', status => {
    let state = passed()
    const intent: ClosureIntent = { id: 'legacy-finish', mode: 'verified',
      decision: 'fixture:original-user-intent', note: 'Originally approved delivery', acknowledged_gaps: [],
      target: { kind: 'local' } }
    state = act(state, { action: 'reserve_closure', intent })
    if (status === 'prepared') {
      state = act(state, { action: 'prepare_closure', closure_id: intent.id, candidate, verification: sha, gaps: [] })
    }
    delete state.plans[0]!.content.completion_scope
    delete state.plans[0]!.content.remaining_scope
    state.plans[0]!.digest = planDigest(state.plans[0]!.content)
    const digest = state.plans[0]!.digest
    expect(normalizeWorkflow(state).closing_id).toBe(intent.id)
    if (status === 'reserved') {
      state = act(state, { action: 'prepare_closure', closure_id: intent.id, candidate, verification: sha, gaps: [] })
    }
    state = act(state, { action: 'finish_closure', closure_id: intent.id, candidate, verification: sha, gaps: [] })
    expect(state.closure?.id).toBe(intent.id)
    expect(state.plans[0]!.content).not.toHaveProperty('completion_scope')
    expect(state.plans[0]!.digest).toBe(digest)
  })

  it('keeps immutable plan versions and rejects mutation after confirmation', () => {
    const original = prepared()
    const changed = act(original, { action: 'propose_plan', plan_id: 'plan-2', plan: { ...plan, goal: 'New goal' } })
    expect(original.plans).toHaveLength(1)
    expect(changed.plans[0]).toEqual(original.plans[0])
    expect(changed.attempt_id).toBeNull()
    expect(() => act(changed, { action: 'propose_plan', plan_id: 'plan-1', plan })).toThrow(/exists/i)
  })

  it('makes identical requests idempotent, rejects conflicting reuse and stale revisions', () => {
    const initial = createWorkflow()
    const command: WorkflowCommand = { action: 'propose_plan', plan_id: 'p', plan }
    const state = act(initial, command, 'same-request')
    expect(act(state, command, 'same-request', 0)).toEqual(state)
    expect(() => act(state, { ...command, plan_id: 'different' }, 'same-request', 0)).toThrow(/reuse/i)
    expect(() => act(state, { ...command, plan_id: 'other' }, 'new-request', 0)).toThrow(/revision/i)
  })

  it('requires explicit yield, even when no writer was registered', () => {
    const state = prepared()
    expect(() => startedCheck(state)).toThrow(/yield/i)
    expect(workflowReadiness(state, candidate).ready).toBe(false)
    expect(startedCheck(yielded()).operations[0]?.status).toBe('running')
  })

  it('claims a command supervisor once and keeps that ownership when its operation becomes unknown', () => {
    const runner = {
      pid: 101, machine: { hostname: 'fixture', platform: 'fixture' }, started_at: 100,
      observed_at: '2026-09-17T00:00:00.000Z',
    }
    const supervisor = { ...runner, pid: 102 }
    let state = act(yielded(), {
      action: 'begin_check', operation_id: 'check', acceptance_id: 'behavior', actor: 'runner', candidate, runner, dispatch: 'pending',
    })
    expect(state.operations[0]?.dispatch).toBe('pending')
    const legacy = structuredClone(state)
    legacy.operations[0]!.dispatch = null
    expect(() => act(legacy, { action: 'claim_supervisor', operation_id: 'check', supervisor })).toThrow(/pending|unclaimed/i)
    expect(() => act(state, {
      action: 'claim_supervisor', operation_id: 'check',
      supervisor: { ...supervisor, machine: { ...supervisor.machine, hostname: 'other-host' } },
    })).toThrow(/machine/i)
    state = act(state, { action: 'claim_supervisor', operation_id: 'check', supervisor })
    expect(normalizeWorkflow(state).operations[0]?.supervisor).toEqual(supervisor)
    expect(state.operations[0]?.dispatch).toBe('claimed')
    const invalid = structuredClone(state)
    invalid.operations[0]!.dispatch = 'pending'
    expect(() => normalizeWorkflow(invalid)).toThrow(/dispatch/i)
    expect(() => act(state, { action: 'claim_supervisor', operation_id: 'check', supervisor })).toThrow(/unclaimed/i)
    state = act(state, { action: 'mark_unknown', operation_id: 'check', reason: 'Lost receipt' })
    expect(state.operations[0]?.supervisor).toEqual(supervisor)
    expect(state.operations[0]?.dispatch).toBe('claimed')
    expect(() => act(state, { action: 'claim_supervisor', operation_id: 'check', supervisor })).toThrow(/unclaimed/i)
  })

  it('blocks check and second writer while an operation is running or unknown', () => {
    let state = act(prepared(), {
      action: 'begin_operation', operation_id: 'writer', kind: 'write', actor: 'builder',
      delegated: false, step_id: 'implement', scope: ['src'], purpose: 'Implement scoped change',
    })
    expect(() => act(state, { action: 'yield', actor: 'primary', candidate, observed_operations: ['writer'], note: 'done' })).toThrow(/running|unresolved/i)
    state = act(state, { action: 'mark_unknown', operation_id: 'writer', reason: 'Lost host connection' })
    expect(() => act(state, { action: 'start_attempt', attempt_id: 'retry', owner: 'primary', workspace })).toThrow(/unknown|unresolved/i)
    expect(() => act(state, { action: 'propose_plan', plan_id: 'new', plan })).toThrow(/unknown|unresolved/i)
  })

  it('does not let a delegated author adopt its own result; yield must account for returned work', () => {
    const child = { ...workspace, root: 'child-root', git_dir: 'child-git' }
    const childCandidate = { digest: sha, root: child.root, git_dir: child.git_dir, common_dir: child.common_dir }
    let state = act(prepared(), {
      action: 'begin_delegation', operation_id: 'writer', actor: 'primary',
      step_id: 'implement', scope: ['src'], purpose: 'Implement scoped change',
      token: 'assignment', workspace: child, launch: sha,
    })
    const handle = { provider: 'host', task_id: 'builder' }
    state = act(state, { action: 'attach_delegation', operation_id: 'writer', actor: 'primary', handle, receipt: sha })
    state = act(state, { action: 'observe_delegation', operation_id: 'writer', actor: 'primary', handle, status: 'terminal', quiescent: true, receipt: sha, observed_at: new Date().toISOString() })
    state = act(state, { action: 'return_delegation', operation_id: 'writer', actor: 'primary', candidate: childCandidate, receipt: sha })
    expect(() => act(state, { action: 'yield', actor: 'primary', candidate, observed_operations: ['writer'], note: 'done' })).toThrow(/unresolved|adopt/i)
    expect(() => act(state, { action: 'finish_delegation', operation_id: 'writer', actor: 'host:builder', decision: 'accepted', candidate, receipt: sha })).toThrow(/owner|author|actor/i)
    expect(() => act(state, { action: 'finish_delegation', operation_id: 'writer', actor: 'primary', decision: 'accepted', candidate, receipt: sha })).toThrow(/review/i)
    state = act(state, { action: 'review_delegation', operation_id: 'writer', actor: 'primary', result: sha, target: candidate, receipt: sha })
    state = act(state, { action: 'finish_delegation', operation_id: 'writer', actor: 'primary', decision: 'accepted', candidate, receipt: sha })
    expect(() => act(state, { action: 'yield', actor: 'primary', candidate, observed_operations: [], note: 'done' })).toThrow(/observed/i)
    state = act(state, { action: 'yield', actor: 'primary', candidate, observed_operations: ['writer'], note: 'Integrated and stopped.' })
    expect(state.yield?.candidate).toEqual(candidate)
  })

  it('rejects scope expansion and out-of-order dependent work', () => {
    const dependent = {
      ...plan,
      steps: [...plan.steps, { id: 'followup', title: 'Follow up', scope: ['src/sub'], depends_on: ['implement'], acceptance_ids: ['behavior'] }],
    }
    const state = prepared(dependent)
    const command = {
      action: 'begin_operation' as const, operation_id: 'op', kind: 'write' as const, actor: 'primary',
      delegated: false, step_id: 'followup', scope: ['src/sub'], purpose: 'Followup work',
    }
    expect(() => act(state, command)).toThrow(/depend/i)
    expect(() => act(state, { ...command, step_id: 'implement', scope: ['src/../outside'] })).toThrow(/scope|path/i)
    expect(() => act(state, { ...command, step_id: 'implement', scope: ['outside'] })).toThrow(/scope/i)
  })

  it('binds passing checks to before/after candidate and never accepts reported command success', () => {
    const ready = passed()
    expect(workflowReadiness(ready, candidate).ready).toBe(true)
    expect(workflowReadiness(ready, { ...candidate, digest: 'b'.repeat(64) }).ready).toBe(false)
    expect(() => act(startedCheck(), {
      action: 'complete_check', operation_id: 'check-1', after: candidate, outcome: 'passed',
      source: 'host_report', receipt: 'host-result', summary: 'claimed pass', process_stopped: true,
    })).toThrow(/source|runner/i)
    const drifted = act(startedCheck(), {
      action: 'complete_check', operation_id: 'check-1', after: { ...candidate, digest: 'b'.repeat(64) },
      outcome: 'passed', source: 'local_runner', receipt: 'receipt', summary: 'Changed during test', process_stopped: true,
    })
    expect(drifted.checks[0]?.outcome).toBe('stale')
    expect(workflowReadiness(drifted, candidate).ready).toBe(false)
  })

  it('later failure overrides earlier pass; timeout without known process stop remains occupied', () => {
    let state = passed()
    state = act(state, { action: 'begin_check', operation_id: 'check-2', acceptance_id: 'behavior', actor: 'runner', candidate })
    state = act(state, {
      action: 'complete_check', operation_id: 'check-2', after: candidate, outcome: 'failed',
      source: 'local_runner', receipt: 'receipt-2', summary: 'Assertion failed', process_stopped: true,
    })
    expect(workflowReadiness(state, candidate).ready).toBe(false)
    state = act(state, { action: 'begin_check', operation_id: 'check-3', acceptance_id: 'behavior', actor: 'runner', candidate })
    state = act(state, {
      action: 'complete_check', operation_id: 'check-3', after: candidate, outcome: 'blocked',
      source: 'local_runner', receipt: 'timeout-observation', summary: 'Descendant state unknown', process_stopped: false,
    })
    expect(state.operations.at(-1)?.status).toBe('unknown')
    expect(() => act(state, { action: 'start_attempt', attempt_id: 'again', owner: 'primary', workspace })).toThrow(/unknown|unresolved/i)
  })

  it('requires manual results from the user and independent reviews from another observable actor', () => {
    const criteria: WorkflowPlanInput = {
      ...plan, risk: 'high',
      acceptance: [
        ...plan.acceptance,
        { id: 'review', description: 'Independent review', kind: 'review', independent: true, required: true },
        { id: 'manual', description: 'Usability acceptance', kind: 'manual', independent: false, required: true },
      ],
    }
    let state = passed(startedCheck(yielded(criteria)))
    expect(workflowReadiness(state, candidate).missing).toEqual(['review', 'manual'])
    expect(() => act(state, { action: 'begin_check', operation_id: 'self-review', acceptance_id: 'review', actor: 'primary', candidate })).toThrow(/independent/i)
    state = act(state, { action: 'begin_check', operation_id: 'review', acceptance_id: 'review', actor: 'reviewer-session', candidate })
    state = act(state, {
      action: 'complete_check', operation_id: 'review', after: candidate, outcome: 'passed',
      source: 'host_report', receipt: 'review-turn', summary: 'Read actual diff and tests', process_stopped: true,
    })
    state = act(state, { action: 'begin_check', operation_id: 'manual', acceptance_id: 'manual', actor: 'user', candidate })
    expect(() => act(state, {
      action: 'complete_check', operation_id: 'manual', after: candidate, outcome: 'passed',
      source: 'host_report', receipt: 'agent-opinion', summary: 'User probably accepts', process_stopped: true,
    })).toThrow(/source|user/i)
  })

  it('rework invalidates yield/checks and never inherits a previous attempt pass', () => {
    const state = act(passed(), { action: 'start_attempt', attempt_id: 'attempt-2', owner: 'primary', workspace })
    expect(state.attempts).toHaveLength(2)
    expect(state.checks).toHaveLength(1)
    expect(state.yield).toBeNull()
    expect(workflowReadiness(state, candidate).ready).toBe(false)
  })

  it('rejects persisted check success inconsistent with its actual check contract', () => {
    const wrongSource = passed()
    wrongSource.checks[0]!.source = 'host_report'
    expect(() => normalizeWorkflow(wrongSource)).toThrow(/source/i)
    const missingAfter = passed()
    missingAfter.checks[0]!.after = null
    expect(() => normalizeWorkflow(missingAfter)).toThrow(/pass|candidate/i)
    const stillRunning = passed()
    stillRunning.operations[0]!.status = 'running'
    expect(() => normalizeWorkflow(stillRunning)).toThrow(/operation|terminal/i)
  })

  it('refuses corrupted request ordering rather than sorting by untrusted timestamps', () => {
    const state = prepared()
    state.requests[1]!.revision = 1
    expect(() => normalizeWorkflow(state)).toThrow(/revision|order/i)
  })
})
