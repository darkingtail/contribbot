import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { sameRepository } from '../repository/ref.js'
import {
  candidateReferenceSchema, workflowPlanInputSchema, workflowRequestSchema, workflowSchema,
} from './contracts.js'
import type {
  CandidateReference, ClosureIntent, WorkflowCommand, WorkflowOperation, WorkflowPlanInput, WorkflowState, WorkspaceBinding,
} from './contracts.js'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}.`)
}

function covered(scope: string, allowed: string[]): boolean {
  return allowed.some(parent => parent === '.' || scope === parent || scope.startsWith(`${parent}/`))
}

function validatePlan(input: unknown): WorkflowPlanInput {
  const plan = workflowPlanInputSchema.parse(input)
  unique(plan.steps.map(step => step.id), 'step id')
  unique(plan.acceptance.map(item => item.id), 'acceptance id')
  if (plan.completion_scope === 'stage' && !plan.remaining_scope?.length) {
    throw new Error('Stage plans must declare at least one remaining goal.')
  }
  if (plan.completion_scope === 'task' && plan.remaining_scope?.length) {
    throw new Error('Task plans cannot declare remaining goals.')
  }
  if (plan.completion_scope === undefined && plan.remaining_scope !== undefined) {
    throw new Error('remaining_scope requires an explicit completion_scope.')
  }
  if (!plan.acceptance.some(item => item.required)) throw new Error('Plan requires at least one required acceptance criterion.')
  if (plan.risk === 'high' && !plan.acceptance.some(item => item.required && item.independent && item.kind === 'review')) {
    throw new Error('High-risk plan requires an independent review.')
  }
  unique((plan.deliverables ?? []).map(item => item.id), 'delivery id')
  for (const delivery of plan.deliverables ?? []) {
    unique(delivery.acceptance_ids, 'delivery acceptance')
    const criteria = delivery.acceptance_ids.map(id => plan.acceptance.find(item => item.id === id))
    if (criteria.some(item => !item)) throw new Error(`Delivery ${delivery.id} has unknown acceptance criterion.`)
    if (delivery.target.kind === 'file' && !covered(delivery.target.path, plan.scope)) {
      throw new Error(`Delivery ${delivery.id} exceeds plan scope.`)
    }
    if ('scope' in delivery.target) {
      unique(delivery.target.scope, 'delivery scope')
      if (delivery.target.scope.some(path => !covered(path, plan.scope))) {
        throw new Error(`Delivery ${delivery.id} exceeds plan scope.`)
      }
    }
    if (delivery.required && !criteria.some(item => item?.required)) {
      throw new Error(`Required delivery ${delivery.id} needs a required acceptance criterion.`)
    }
    if (delivery.required && delivery.target.kind === 'file'
      && !criteria.some(item => item?.required && (item.kind === 'manual' || item.kind === 'review'))) {
      throw new Error(`Required file delivery ${delivery.id} needs a required manual or review criterion for content acceptance.`)
    }
  }
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const steps = new Map(plan.steps.map(step => [step.id, step]))
  const acceptance = new Set(plan.acceptance.map(item => item.id))
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Cyclic step dependency: ${id}.`)
    if (visited.has(id)) return
    const step = steps.get(id)
    if (!step) throw new Error(`Unknown dependency: ${id}.`)
    unique(step.depends_on, 'step dependency')
    unique(step.acceptance_ids, 'step acceptance')
    if (step.scope.some(path => !covered(path, plan.scope))) throw new Error(`Step ${id} exceeds plan scope.`)
    if (step.acceptance_ids.some(id => !acceptance.has(id))) throw new Error(`Step ${id} has unknown acceptance criterion.`)
    visiting.add(id)
    for (const dependency of step.depends_on) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const step of plan.steps) visit(step.id)
  return plan
}

export function planDigest(input: unknown): string {
  return hash(validatePlan(input))
}

export function createWorkflow(): WorkflowState {
  return {
    version: 1, revision: 0, epoch: 0, plans: [], plan_id: null, attempts: [], attempt_id: null,
    operations: [], checks: [], yield: null, requests: [],
    closings: [], closing_id: null, closure: null,
  }
}

// Coverage describes the confirmed scope, not test success or user acceptance.
export function completionCoverage(state: WorkflowState | undefined) {
  const plan = state?.plans.find(plan => plan.id === state.plan_id)
  return {
    plan_id: plan?.id ?? null,
    scope: plan ? plan.content.completion_scope ?? 'legacy' : 'unplanned',
    confirmed: Boolean(plan?.confirmation),
    remaining_scope: plan?.content.remaining_scope ?? null,
    scope_allows_task_completion: Boolean(plan?.confirmation && plan.content.completion_scope === 'task'
      && plan.content.remaining_scope?.length === 0),
  }
}

export function deliveryRequirements(state: WorkflowState | undefined) {
  const plan = state?.plans.find(plan => plan.id === state.plan_id)
  return {
    plan_id: plan?.id ?? null, plan_digest: plan?.digest ?? null,
    declared: plan?.content.deliverables !== undefined, confirmed: Boolean(plan?.confirmation),
    items: plan?.content.deliverables ?? [],
  }
}

function live(operation: WorkflowOperation): boolean {
  return operation.status === 'running' || operation.status === 'unknown'
}

export function unresolvedOperations(state: WorkflowState): WorkflowOperation[] {
  return state.operations.filter(operation => live(operation) || operation.status === 'returned')
}

export function activeControl(state: WorkflowState) {
  return state.control?.requests.find(request => request.id === state.control?.active_id)
}

export function controlIsPaused(state: WorkflowState): boolean {
  const control = activeControl(state)
  return Boolean(control?.kind === 'pause' && state.control?.events.some(event =>
    event.control_id === control.id && event.kind === 'paused'))
}

/** Exact request replay is history, not permission to start another effect. */
export function assertDispatchAllowed(state: WorkflowState): void {
  const control = activeControl(state)
  if (control) throw new Error(`Control ${control.id}: ${control.kind} requested. No new work may be dispatched; reconcile existing work first.`)
  if (state.closure || state.closing_id) throw new Error('Execution is closing or closed; no new work may be dispatched.')
}

export function assertControlAllows(state: WorkflowState, command: WorkflowCommand): void {
  const control = activeControl(state)
  const intent = command.action === 'reserve_closure' ? command.intent
    : command.action === 'prepare_closure' || command.action === 'finish_closure'
      ? state.closings.find(item => item.intent.id === command.closure_id)?.intent : undefined
  if (intent?.mode === 'stopped' && (control?.kind !== 'cancel'
    || intent.target.kind !== 'local' || intent.decision !== control.decision)) {
    throw new Error('Stopped completion requires an active cancellation control, matching decision and local target.')
  }
  if (!control) return
  if (command.action === 'reconcile_closure'
    && (command.control_id !== control.id || command.decision !== control.decision)) {
    throw new Error('Stop reconciliation requires the exact active control id and decision.')
  }
  const recovery = [
    'request_control', 'settle_pause', 'resume_control', 'attach_delegation', 'observe_delegation',
    'return_delegation', 'review_delegation', 'finish_delegation', 'mark_unknown',
    'return_operation', 'adopt_operation', 'yield', 'complete_check', 'reconcile_check',
    'cancel_closure', 'reconcile_closure', 'closure_remote_receipt',
  ]
  if (recovery.includes(command.action)) return
  if (control.kind === 'cancel' && intent?.mode === 'stopped' && intent.target.kind === 'local'
    && intent.decision === control.decision) return
  throw new Error(`Control ${control.id}: ${control.kind} requested; this action cannot override the stop intent.`)
}

function assertSettled(state: WorkflowState): void {
  const unresolved = unresolvedOperations(state)
  if (unresolved.length) throw new Error(`Unresolved running, unknown or unadopted operations: ${unresolved.map(item => item.id).join(', ')}.`)
}

function current(state: WorkflowState) {
  const plan = state.plans.find(plan => plan.id === state.plan_id)
  if (!plan?.confirmation) throw new Error('Confirm the latest exact plan before execution.')
  const attempt = state.attempts.find(attempt => attempt.id === state.attempt_id)
  if (!attempt || attempt.plan_id !== plan.id) throw new Error('Start an attempt for the confirmed plan.')
  return { plan, attempt }
}

function assertWorkspace(candidate: CandidateReference, workspace: WorkspaceBinding): void {
  if (candidate.root !== workspace.root || candidate.git_dir !== workspace.git_dir || candidate.common_dir !== workspace.common_dir) {
    throw new Error('Candidate belongs to another workspace.')
  }
}

function operationFor(state: WorkflowState, id: string): WorkflowOperation {
  const { plan, attempt } = current(state)
  const operation = state.operations.find(operation => operation.id === id)
  if (!operation) throw new Error(`Unknown operation: ${id}.`)
  if (operation.plan_id !== plan.id || operation.attempt_id !== attempt.id) {
    throw new Error('Operation belongs to a superseded plan or attempt.')
  }
  return operation
}

function assertNewOperation(state: WorkflowState, id: string): void {
  if (state.operations.some(operation => operation.id === id)) throw new Error(`Operation id already exists: ${id}.`)
}

function assertCheckSource(kind: 'command' | 'manual' | 'review', source: string): void {
  const sources = { command: 'local_runner', manual: 'user', review: 'host_report' }
  if (sources[kind] !== source) throw new Error('Check source must match command runner, explicit user or host review acceptance.')
}

function assertYield(state: WorkflowState, candidate: CandidateReference): void {
  const { plan, attempt } = current(state)
  assertWorkspace(candidate, attempt.workspace)
  if (!state.yield || state.yield.plan_id !== plan.id || state.yield.attempt_id !== attempt.id
    || state.yield.epoch !== state.epoch || !isDeepStrictEqual(state.yield.candidate, candidate)) {
    throw new Error('Explicit current-candidate yield is required before checking.')
  }
}

function newOperation(
  state: WorkflowState, id: string, actor: string, kind: WorkflowOperation['kind'], now: string,
): WorkflowOperation {
  const { plan, attempt } = current(state)
  return {
    id, actor, kind, plan_id: plan.id, attempt_id: attempt.id, epoch: state.epoch,
    delegated: false, step_id: null, acceptance_id: null, scope: [],
    purpose: '', status: 'running', started_at: now, ended_at: null, receipt: null,
    note: '', decision_actor: null, candidate: null, runner: null, supervisor: null, dispatch: null, delegation: null,
    uncertain_at: null, reconciliation: null,
  }
}

export function assertClosureCoverage(
  state: WorkflowState, candidate: CandidateReference | null, intent: ClosureIntent, observedGaps: string[],
): string[] {
  const plan = state.plans.find(plan => plan.id === state.plan_id)
  if (intent.mode !== 'stopped' && plan?.content.completion_scope === 'stage') {
    const remaining = plan.content.remaining_scope?.join('; ') ?? 'undisclosed goals'
    throw new Error(`Cannot complete the Todo from a stage-only plan; remaining goals: ${remaining}.`)
  }
  const coverage = candidate ? workflowReadiness(state, candidate, intent.mode === 'stopped') : { ready: false, missing: [], reasons: [] }
  if (coverage.reasons.length) throw new Error(coverage.reasons.join(' '))
  const gaps = [...new Set([...observedGaps, ...coverage.missing.map(id => `acceptance:${id}`)])].sort()
  const deliveryGaps = gaps.filter(gap => gap.startsWith('delivery:'))
  if (intent.mode !== 'stopped' && deliveryGaps.length) {
    throw new Error(`Required delivery endpoints are not satisfied: ${deliveryGaps.join(', ')}. Deliver the declared artifacts or revise and reconfirm the plan; acknowledged verification gaps cannot remove a delivery requirement.`)
  }
  if (intent.mode === 'verified' && (!coverage.ready || gaps.length > 0)) {
    throw new Error(`Required acceptance/artifact verification gaps: ${gaps.join(', ')}.`)
  }
  if (intent.mode === 'with_gaps' && gaps.some(gap => !intent.acknowledged_gaps.includes(gap))) {
    throw new Error(`User must explicitly acknowledge all gaps: ${gaps.join(', ')}.`)
  }
  return gaps
}

function apply(state: WorkflowState, command: WorkflowCommand, now: string): void {
  if (state.closure) throw new Error('Managed execution is already closed.')
  assertControlAllows(state, command)
  const closureActions = ['request_control', 'prepare_closure', 'cancel_closure', 'closure_remote_receipt', 'finish_closure', 'reconcile_closure']
  if (state.closing_id && !closureActions.includes(command.action)) throw new Error('A closure is pending; reconcile closing first.')
  switch (command.action) {
    case 'request_control': {
      const previous = activeControl(state)
      if (state.control?.requests.some(request => request.id === command.control_id)) throw new Error('Control id already exists; retry the original request.')
      if (previous && !(previous.kind === 'pause' && command.kind === 'cancel')) throw new Error('A control request is already pending; settle or withdraw it first.')
      state.control ??= { active_id: null, requests: [], events: [] }
      if (previous) state.control.events.push({
        control_id: previous.id, kind: 'superseded', at_revision: state.revision + 1, at: now,
        actor: 'user', decision: command.decision, candidate: null, verification: null,
      })
      state.control.requests.push({
        id: command.control_id, kind: command.kind, decision: command.decision, note: command.note,
        at_revision: state.revision + 1, at: now,
      })
      state.control.active_id = command.control_id
      return
    }
    case 'settle_pause':
    case 'resume_control': {
      const control = activeControl(state)
      if (!control || control.id !== command.control_id) throw new Error('Exact active control request required.')
      assertSettled(state)
      if (command.action === 'settle_pause' && (control.kind !== 'pause' || controlIsPaused(state))) {
        throw new Error('Only an unsettled pause request can be settled.')
      }
      if (state.attempt_id) {
        const { attempt } = current(state)
        if (command.actor !== attempt.owner || !command.candidate) throw new Error('Original owner and current candidate required for control settlement.')
        assertWorkspace(command.candidate, attempt.workspace)
        if (command.action === 'settle_pause') assertYield(state, command.candidate)
      }
      else if (command.candidate !== null) throw new Error('Unbound control must not invent a workspace candidate.')
      state.control!.events.push({
        control_id: control.id, kind: command.action === 'settle_pause' ? 'paused' : 'resumed',
        at_revision: state.revision + 1, at: now, actor: command.actor,
        decision: command.action === 'resume_control' ? command.decision : control.decision,
        candidate: command.candidate, verification: command.verification,
      })
      if (command.action === 'resume_control') {
        state.control!.active_id = null
        state.epoch++
        state.yield = null
      }
      return
    }
    case 'reserve_closure': {
      assertSettled(state)
      if (command.intent.target.kind === 'issue' && !state.attempt_id) {
        throw new Error('Linked Issue closure requires a bound local attempt; unbound work can only close locally.')
      }
      if (state.closings.some(closing => closing.intent.id === command.intent.id)) throw new Error('Closure id already exists.')
      if (command.intent.mode !== 'stopped') {
        const plan = state.plans.find(plan => plan.id === state.plan_id)
        if (!plan?.confirmation || plan.content.completion_scope !== 'task' || plan.content.remaining_scope?.length !== 0) {
          throw new Error('Whole-Todo completion requires a confirmed task coverage declaration (completion_scope=task). Stage or legacy plans cannot begin a new completion.')
        }
      }
      const candidate = state.yield?.candidate ?? null
      if (state.attempt_id) {
        if (!candidate) throw new Error('Explicit current-candidate yield required before closing.')
        assertYield(state, candidate)
      }
      else if (command.intent.mode !== 'stopped') throw new Error('An unstarted task can only be stopped, not delivered.')
      unique(command.intent.acknowledged_gaps, 'acknowledged gap')
      state.closings.push({
        intent: command.intent, plan_id: state.plan_id, attempt_id: state.attempt_id, epoch: state.epoch,
        candidate, state: 'reserved', gaps: [], verification: null, remote_receipt: null, reconciliation: null, at: now, note: '',
        ...(command.intent.target.kind === 'issue' ? { issue_dispatch: 'journal-v1' as const } : {}),
      })
      state.closing_id = command.intent.id
      return
    }
    case 'prepare_closure':
    case 'finish_closure': {
      const closing = state.closings.find(item => item.intent.id === command.closure_id)
      if (!closing || state.closing_id !== command.closure_id || !['reserved', 'prepared'].includes(closing.state)) {
        throw new Error('No matching pending closure.')
      }
      if (!isDeepStrictEqual(command.candidate, closing.candidate)) throw new Error('Closure candidate drifted.')
      const gaps = assertClosureCoverage(state, command.candidate, closing.intent, command.gaps)
      if (command.action === 'finish_closure') {
        if (closing.state !== 'prepared') throw new Error('Prepare closure before finalizing.')
        if (closing.intent.target.kind === 'issue' && !closing.remote_receipt) throw new Error('Remote receipt required before linked closure.')
        state.closure = {
          id: closing.intent.id, mode: closing.intent.mode, candidate: command.candidate, gaps,
          verification: command.verification, decision: closing.intent.decision, note: closing.intent.note, at: now,
        }
        closing.state = 'completed'
        state.closing_id = null
        const control = activeControl(state)
        if (control) {
          state.control!.events.push({
            control_id: control.id, kind: 'cancelled', at_revision: state.revision + 1, at: now,
            actor: 'user', decision: control.decision, candidate: command.candidate, verification: command.verification,
          })
          state.control!.active_id = null
        }
      }
      else closing.state = 'prepared'
      closing.gaps = gaps
      closing.verification = command.verification
      return
    }
    case 'cancel_closure': {
      if (command.control_id !== undefined || command.actor !== undefined) {
        if (!command.control_id || activeControl(state)?.id !== command.control_id || !command.actor) {
          throw new Error('Exact current control request and actor required to withdraw closure.')
        }
        const attempt = state.attempts.find(item => item.id === state.attempt_id)
        if (attempt && command.actor !== attempt.owner) throw new Error('Original owner required to withdraw closure.')
      }
      const closing = state.closings.find(item => item.intent.id === command.closure_id)
      if (!closing || state.closing_id !== command.closure_id) throw new Error('No matching pending closure.')
      if (closing.remote_receipt || (closing.state === 'prepared' && closing.intent.target.kind === 'issue')) {
        throw new Error('Reconcile the remote operation before cancelling its closing reservation.')
      }
      closing.state = 'cancelled'
      closing.note = command.note
      state.closing_id = null
      return
    }
    case 'reconcile_closure': {
      const closing = state.closings.find(item => item.intent.id === command.closure_id)
      const { attempt } = current(state)
      assertSettled(state)
      const control = activeControl(state)
      if (command.control_id !== undefined
        && (!control || control.id !== command.control_id || control.decision !== command.decision)) {
        throw new Error('Exact active control required for stop reconciliation.')
      }
      if (!command.control_id && !command.remote_receipt) throw new Error('Continuation requires a closed remote receipt.')
      if (!closing || state.closing_id !== command.closure_id || closing.state !== 'prepared'
        || closing.intent.target.kind !== 'issue' || command.actor !== attempt.owner
        || (closing.remote_receipt !== null && closing.remote_receipt !== command.remote_receipt)) {
        throw new Error('Reconciliation requires the original prepared Issue closure, owner and exact remote receipt.')
      }
      assertWorkspace(command.candidate, attempt.workspace)
      closing.state = 'reconciled'
      closing.remote_receipt = command.remote_receipt
      closing.reconciliation = {
        receipt: command.receipt, actor: command.actor, decision: command.decision, candidate: command.candidate,
        ...(command.control_id ? { control_id: command.control_id } : {}),
      }
      state.closing_id = null
      state.yield = null
      state.epoch++
      return
    }
    case 'closure_remote_receipt': {
      const closing = state.closings.find(item => item.intent.id === command.closure_id)
      if (!closing || state.closing_id !== command.closure_id || closing.state !== 'prepared' || closing.intent.target.kind !== 'issue') {
        throw new Error('Remote receipt does not match a prepared linked closure.')
      }
      if (closing.remote_receipt && closing.remote_receipt !== command.receipt) throw new Error('Conflicting remote closure receipt.')
      closing.remote_receipt = command.receipt
      return
    }
    case 'propose_plan': {
      assertSettled(state)
      if (state.plans.some(plan => plan.id === command.plan_id)) throw new Error('Plan id already exists; use a new version.')
      const content = validatePlan(command.plan)
      if (content.completion_scope === undefined || content.remaining_scope === undefined) {
        throw new Error('New plans require explicit completion_scope and remaining_scope; legacy plans remain readable without changing their digest.')
      }
      state.plans.push({ id: command.plan_id, digest: planDigest(content), content, confirmation: null })
      state.plan_id = command.plan_id
      state.attempt_id = null
      state.yield = null
      state.epoch++
      return
    }
    case 'confirm_plan': {
      assertSettled(state)
      if (command.plan_id !== state.plan_id) throw new Error('Only the latest plan can be confirmed.')
      const plan = state.plans.find(plan => plan.id === command.plan_id)!
      if (plan.digest !== command.digest) throw new Error('Plan digest changed; request exact version confirmation.')
      if (plan.confirmation) throw new Error('Plan is already confirmed; reuse the original request id.')
      plan.confirmation = { locator: command.confirmation, at: now }
      return
    }
    case 'start_attempt':
    case 'relocate_attempt': {
      assertSettled(state)
      const plan = state.plans.find(plan => plan.id === state.plan_id)
      if (!plan?.confirmation) throw new Error('Confirm the latest plan before starting an attempt.')
      if (state.attempts.some(attempt => attempt.id === command.attempt_id)) throw new Error('Attempt id already exists.')
      const previous = state.attempts.at(-1)
      if (command.action === 'relocate_attempt') {
        if (!previous || previous.id !== state.attempt_id || command.relocation.from_attempt !== previous.id
          || command.relocation.plan_digest !== plan.digest || previous.plan_id !== plan.id
          || previous.owner !== command.owner || !sameRepository(previous.workspace.repo, command.workspace.repo) || !command.workspace.machine) {
          throw new Error('Relocation requires the exact settled attempt, original owner, confirmed plan digest and canonical repository.')
        }
      }
      else if (previous && (!sameRepository(previous.workspace.repo, command.workspace.repo) || previous.workspace.root !== command.workspace.root
        || previous.workspace.git_dir !== command.workspace.git_dir || previous.workspace.common_dir !== command.workspace.common_dir
        || !isDeepStrictEqual(previous.workspace.machine, command.workspace.machine))) {
        throw new Error('Changing workspace or machine requires explicit local relocation; normal bind cannot transfer ownership.')
      }
      state.attempts.push({
        id: command.attempt_id, plan_id: plan.id, owner: command.owner, workspace: command.workspace, started_at: now,
        ...(command.action === 'relocate_attempt' ? { relocation: command.relocation } : {}),
      })
      state.attempt_id = command.attempt_id
      state.yield = null
      state.epoch++
      return
    }
    case 'begin_operation': {
      if (command.delegated) throw new Error('Prepare a candidate-bound delegation through the local helper.')
      const { plan, attempt } = current(state)
      assertNewOperation(state, command.operation_id)
      // Read-only observations can share, but no writes may race them or a check.
      if (state.operations.some(operation => operation.status === 'unknown'
        || (live(operation) && (command.kind === 'write' || operation.kind !== 'read'))
        || operation.status === 'returned')) {
        throw new Error('An unresolved operation occupies this workspace.')
      }
      const step = plan.content.steps.find(step => step.id === command.step_id)
      if (!step) throw new Error('Unknown plan step.')
      if (command.scope.some(path => !covered(path, step.scope))) throw new Error('Operation exceeds confirmed step scope.')
      if (step.depends_on.some(id => !state.operations.some(operation =>
        operation.attempt_id === attempt.id && operation.step_id === id && operation.status === 'accepted'))) {
        throw new Error('Step dependencies must be adopted in the current attempt first.')
      }
      state.epoch++
      state.yield = null
      const operation = newOperation(state, command.operation_id, command.actor, command.kind, now)
      Object.assign(operation, {
        step_id: step.id, delegated: command.delegated, scope: command.scope, purpose: command.purpose,
      })
      state.operations.push(operation)
      return
    }
    case 'begin_delegation': {
      const { attempt } = current(state)
      if (command.actor !== attempt.owner) throw new Error('Only the accountable owner can prepare delegation.')
      if (command.workspace.root === attempt.workspace.root || command.workspace.git_dir === attempt.workspace.git_dir
        || command.workspace.common_dir !== attempt.workspace.common_dir || !sameRepository(command.workspace.repo, attempt.workspace.repo)) {
        throw new Error('Delegation requires a distinct linked worktree for the same repository.')
      }
      if (state.operations.some(item => item.delegation?.token === command.token)) throw new Error('Delegation token is already reserved.')
      apply(state, {
        action: 'begin_operation', operation_id: command.operation_id, actor: `unbound:${command.token}`,
        delegated: false, kind: 'write', step_id: command.step_id, scope: command.scope, purpose: command.purpose,
      }, now)
      const operation = operationFor(state, command.operation_id)
      operation.delegated = true
      operation.delegation = {
        token: command.token, workspace: command.workspace, launch: command.launch,
        host: null, attachment: null, observation: null, uncertain_at: null, result: null, review: null, integration: null,
      }
      return
    }
    case 'attach_delegation':
    case 'observe_delegation':
    case 'return_delegation':
    case 'review_delegation':
    case 'finish_delegation': {
      const operation = operationFor(state, command.operation_id)
      const delegation = operation.delegation
      const { attempt } = current(state)
      if (!operation.delegated || !delegation || command.actor !== attempt.owner) {
        throw new Error('Delegation requires the original accountable owner and local candidate contract.')
      }
      if (!live(operation) && operation.status !== 'returned') throw new Error('Delegation is already settled.')
      if (command.action === 'attach_delegation') {
        if (delegation.host) throw new Error('Host task is already attached; do not replace or respawn it.')
        delegation.host = command.handle
        delegation.attachment = command.receipt
        operation.actor = `${command.handle.provider}:${command.handle.task_id}`
        return
      }
      if (!delegation.host) throw new Error('Attach the actual original host task before reconciling delegation.')
      if (command.action === 'observe_delegation') {
        if (!isDeepStrictEqual(command.handle, delegation.host)) throw new Error('Observation belongs to a different host task.')
        if ((delegation.observation?.observed_at && Date.parse(command.observed_at) <= Date.parse(delegation.observation.observed_at))
          || (delegation.uncertain_at && Date.parse(command.observed_at) <= Date.parse(delegation.uncertain_at))) {
          throw new Error('Stale host observation cannot override newer liveness or uncertainty.')
        }
        delegation.observation = { status: command.status, quiescent: command.quiescent, receipt: command.receipt, observed_at: command.observed_at }
        delegation.uncertain_at = null
        if (command.status !== 'terminal' || !command.quiescent) {
          operation.status = 'unknown'
          operation.ended_at = null
          delegation.review = null
        }
        state.yield = null
        return
      }
      if (delegation.uncertain_at || delegation.observation?.status !== 'terminal' || !delegation.observation.quiescent) {
        throw new Error('Original host task and scoped descendants require a terminal quiescence observation.')
      }
      if (command.action === 'return_delegation') {
        assertWorkspace(command.candidate, delegation.workspace)
        if (delegation.result && (delegation.result.receipt !== command.receipt
          || !isDeepStrictEqual(delegation.result.candidate, command.candidate))) throw new Error('Delegated result is immutable.')
        delegation.result = { candidate: command.candidate, receipt: command.receipt }
        operation.status = 'returned'
        operation.ended_at = now
        operation.receipt = command.receipt
        return
      }
      if (operation.status !== 'returned' || !delegation.result) throw new Error('Collect a terminal child candidate before review or integration.')
      if (operation.actor === command.actor) throw new Error('Delegated author cannot adopt its own result.')
      if (command.action === 'review_delegation') {
        if (delegation.review) throw new Error('Review is already bound; reuse the original request.')
        if (command.result !== delegation.result.receipt) throw new Error('Review must bind the exact returned candidate artifact.')
        assertWorkspace(command.target, attempt.workspace)
        delegation.review = { target: command.target, receipt: command.receipt }
        return
      }
      if (command.decision === 'accepted' && !delegation.review) throw new Error('Review and integrate the exact candidate before acceptance.')
      assertWorkspace(command.candidate, attempt.workspace)
      delegation.integration = { candidate: command.candidate, receipt: command.receipt }
      operation.status = command.decision
      operation.decision_actor = command.actor
      state.yield = null
      state.epoch++
      return
    }
    case 'mark_unknown': {
      const operation = operationFor(state, command.operation_id)
      if (!live(operation)) throw new Error('Only an unsettled operation can become unknown.')
      operation.status = 'unknown'
      operation.note = command.reason
      operation.uncertain_at = now
      if (operation.delegation) {
        operation.delegation.uncertain_at = now
        operation.delegation.review = null
      }
      state.yield = null
      return
    }
    case 'return_operation': {
      const operation = operationFor(state, command.operation_id)
      if (operation.delegated) throw new Error('Delegated operations require local candidate collection, not a free-text return.')
      if (operation.kind === 'check' || !live(operation)) throw new Error('Only live host operations can return results.')
      operation.status = 'returned'
      operation.ended_at = now
      operation.receipt = command.receipt
      operation.note = command.note
      return
    }
    case 'adopt_operation': {
      const operation = operationFor(state, command.operation_id)
      if (operation.delegated) throw new Error('Delegated candidates require local review and integration verification.')
      const { attempt } = current(state)
      if (operation.status !== 'returned') throw new Error('Only a returned operation can be adopted.')
      if (command.actor !== attempt.owner) throw new Error('Only the current accountable actor can adopt results.')
      operation.status = command.decision
      operation.decision_actor = command.actor
      operation.note = command.note
      return
    }
    case 'yield': {
      const { plan, attempt } = current(state)
      assertSettled(state)
      assertWorkspace(command.candidate, attempt.workspace)
      if (command.actor !== attempt.owner) throw new Error('Only the accountable actor can yield the workspace.')
      unique(command.observed_operations, 'observed operation')
      const observed = state.operations.filter(operation => operation.attempt_id === attempt.id).map(operation => operation.id).sort()
      if (!isDeepStrictEqual(observed, [...command.observed_operations].sort())) {
        throw new Error('Yield observed_operations must account for every current-attempt operation.')
      }
      state.yield = {
        plan_id: plan.id, attempt_id: attempt.id, epoch: state.epoch, actor: command.actor,
        candidate: command.candidate, observed_operations: command.observed_operations, note: command.note, at: now,
      }
      return
    }
    case 'begin_check': {
      const { plan, attempt } = current(state)
      assertSettled(state)
      assertNewOperation(state, command.operation_id)
      assertYield(state, command.candidate)
      const criterion = plan.content.acceptance.find(item => item.id === command.acceptance_id)
      if (!criterion) throw new Error('Unknown acceptance criterion.')
      if (criterion.independent && (command.actor === attempt.owner
        || state.operations.some(operation => operation.kind === 'write' && operation.actor === command.actor))) {
        throw new Error('Independent review requires an actor distinct from the owner and all builders.')
      }
      const operation = newOperation(state, command.operation_id, command.actor, 'check', now)
      operation.acceptance_id = criterion.id
      operation.candidate = command.candidate
      operation.runner = command.runner ?? null
      if (command.dispatch && (!command.runner || criterion.kind !== 'command')) {
        throw new Error('Supervised dispatch requires a command check and original requester.')
      }
      operation.dispatch = command.dispatch ?? null
      operation.purpose = criterion.description
      state.operations.push(operation)
      return
    }
    case 'claim_supervisor': {
      const operation = operationFor(state, command.operation_id)
      const { plan } = current(state)
      const criterion = plan.content.acceptance.find(item => item.id === operation.acceptance_id)
      if (operation.kind !== 'check' || operation.status !== 'running' || !operation.runner
        || criterion?.kind !== 'command' || operation.supervisor || operation.dispatch !== 'pending') {
        throw new Error('Supervisor requires an unclaimed running command check.')
      }
      if (!isDeepStrictEqual(operation.runner.machine, command.supervisor.machine)) {
        throw new Error('Supervisor must run on the original requester machine.')
      }
      operation.supervisor = command.supervisor
      if (operation.dispatch === 'pending') operation.dispatch = 'claimed'
      return
    }
    case 'complete_check': {
      const operation = operationFor(state, command.operation_id)
      const { plan } = current(state)
      if (operation.kind !== 'check' || !live(operation) || !operation.candidate) throw new Error('Check operation is not pending.')
      const criterion = plan.content.acceptance.find(item => item.id === operation.acceptance_id)!
      assertCheckSource(criterion.kind, command.source)
      let outcome: WorkflowState['checks'][number]['outcome'] = command.outcome
      if (!isDeepStrictEqual(operation.candidate, command.after) || operation.epoch !== state.epoch) outcome = 'stale'
      if (!command.after) outcome = 'blocked'
      if (!command.process_stopped) outcome = 'blocked'
      operation.status = command.process_stopped ? 'completed' : 'unknown'
      operation.ended_at = command.process_stopped ? now : null
      operation.receipt = command.receipt
      operation.note = command.summary
      state.checks.push({
        operation_id: operation.id, plan_id: operation.plan_id, attempt_id: operation.attempt_id, epoch: operation.epoch,
        acceptance_id: criterion.id, candidate: operation.candidate, after: command.after,
        actor: operation.actor, outcome, source: command.source,
        receipt: command.receipt, summary: command.summary, recorded_at: now,
      })
      if (outcome === 'stale' || !command.process_stopped) state.yield = null
      if (!command.process_stopped) operation.uncertain_at = now
      return
    }
    case 'reconcile_check': {
      const operation = operationFor(state, command.operation_id)
      const { plan, attempt } = current(state)
      if (operation.kind !== 'check' || !live(operation) || operation.reconciliation
        || plan.content.acceptance.find(item => item.id === operation.acceptance_id)?.kind !== 'command') {
        throw new Error('Only an unsettled command check can be reconciled.')
      }
      if (command.actor !== attempt.owner) throw new Error('Only the original accountable owner can reconcile the check.')
      assertWorkspace(command.candidate, attempt.workspace)
      operation.status = 'reconciled'
      operation.ended_at = now
      operation.decision_actor = command.actor
      operation.reconciliation = {
        receipt: command.receipt, actor: command.actor, decision: command.decision, candidate: command.candidate,
      }
      state.yield = null
      state.epoch++
      return
    }
  }
}

/** Parse, retain and validate managed state. Unknown versions/fields fail closed instead of being dropped. */
export function normalizeWorkflow(input: unknown): WorkflowState {
  const state = workflowSchema.parse(input)
  if (state.control) {
    const { requests, events, active_id } = state.control
    unique(requests.map(request => request.id), 'control id')
    let active: string | null = null
    const paused = new Set<string>()
    const history = [
      ...requests.map(request => ({ revision: request.at_revision, request })),
      ...events.map(event => ({ revision: event.at_revision, event })),
    ].sort((a, b) => a.revision - b.revision || ('event' in a ? -1 : 1))
    for (const entry of history) {
      if (entry.revision < 1 || entry.revision > state.revision) throw new Error('Invalid control revision.')
      if ('request' in entry) {
        if (active) throw new Error('More than one active control request.')
        active = entry.request.id
      }
      else {
        const event = entry.event
        if (event.control_id !== active) throw new Error('Control event does not refer to the active request.')
        const request = requests.find(item => item.id === active)!
        if (event.kind === 'paused') {
          if (request.kind !== 'pause' || paused.has(active!)) throw new Error('Invalid pause settlement.')
          paused.add(active!)
        }
        else {
          if (event.kind === 'cancelled' && (request.kind !== 'cancel' || state.closure?.mode !== 'stopped'
            || state.closure.decision !== request.decision)) throw new Error('Cancellation requires its stopped closure.')
          if (event.kind === 'superseded' && (request.kind !== 'pause'
            || !requests.some(item => item.at_revision === event.at_revision && item.kind === 'cancel'))) {
            throw new Error('Only an explicit cancellation can supersede pause.')
          }
          active = null
        }
        if (event.kind !== 'superseded' && !event.verification) throw new Error('Control settlement requires verification.')
      }
    }
    if (active !== active_id || (state.closure && active)) throw new Error('Invalid active control reference.')
    if (controlIsPaused(state) && (unresolvedOperations(state).length || state.closing_id)) throw new Error('Paused control still has unresolved work.')
  }
  unique(state.plans.map(plan => plan.id), 'plan id')
  unique(state.attempts.map(attempt => attempt.id), 'attempt id')
  unique(state.operations.map(operation => operation.id), 'operation id')
  unique(state.requests.map(request => request.id), 'request id')
  unique(state.closings.map(closing => closing.intent.id), 'closure id')
  if (state.requests.length !== state.revision || state.requests.some((request, index) => request.revision !== index + 1)
    || state.epoch > state.revision) throw new Error('Stored request revision order is invalid.')
  for (const plan of state.plans) {
    if (planDigest(plan.content) !== plan.digest) throw new Error(`Stored plan digest mismatch: ${plan.id}.`)
  }
  if (state.plan_id !== (state.plans.at(-1)?.id ?? null)) throw new Error('Current plan does not identify the latest version.')
  for (const attempt of state.attempts) {
    if (!state.plans.find(plan => plan.id === attempt.plan_id)?.confirmation) throw new Error('Attempt refers to an unconfirmed plan.')
    if (attempt.relocation) {
      const earlier = state.attempts.slice(0, state.attempts.indexOf(attempt)).at(-1)
      if (!earlier || earlier.id !== attempt.relocation.from_attempt || earlier.plan_id !== attempt.plan_id
        || earlier.owner !== attempt.owner || !sameRepository(earlier.workspace.repo, attempt.workspace.repo) || !attempt.workspace.machine
        || state.plans.find(plan => plan.id === attempt.plan_id)?.digest !== attempt.relocation.plan_digest) {
        throw new Error('Invalid relocation ancestry or confirmation.')
      }
    }
  }
  if (state.attempt_id !== null) {
    current(state)
    if (state.attempt_id !== state.attempts.at(-1)?.id) throw new Error('Active attempt must be the latest attempt.')
  }
  for (const operation of state.operations) {
    if (!state.attempts.some(attempt => attempt.id === operation.attempt_id && attempt.plan_id === operation.plan_id)) {
      throw new Error('Operation refers to an unknown plan/attempt.')
    }
    if (operation.epoch > state.epoch) throw new Error('Operation epoch exceeds workflow epoch.')
    const plan = state.plans.find(plan => plan.id === operation.plan_id)!
    if (live(operation) !== (operation.ended_at === null)) throw new Error('Operation terminal state and stop time disagree.')
    if ((live(operation) || operation.status === 'returned') && operation.attempt_id !== state.attempt_id) {
      throw new Error('Unresolved operation cannot belong to a superseded attempt.')
    }
    if (operation.kind === 'check') {
      if (!operation.candidate || !plan.content.acceptance.some(item => item.id === operation.acceptance_id)
        || !['running', 'unknown', 'completed', 'reconciled'].includes(operation.status)) {
        throw new Error('Invalid check operation contract.')
      }
      if (operation.supervisor && (!operation.runner
        || !isDeepStrictEqual(operation.runner.machine, operation.supervisor.machine)
        || plan.content.acceptance.find(item => item.id === operation.acceptance_id)?.kind !== 'command')) {
        throw new Error('Invalid check supervisor identity.')
      }
      if (operation.dispatch !== null && (!operation.runner
        || plan.content.acceptance.find(item => item.id === operation.acceptance_id)?.kind !== 'command'
        || (operation.dispatch === 'pending' && (operation.supervisor !== null || operation.status === 'completed'))
        || (operation.dispatch === 'claimed' && operation.supervisor === null))) {
        throw new Error('Invalid check dispatch state.')
      }
      if ((operation.status === 'reconciled') !== Boolean(operation.reconciliation)) throw new Error('Reconciled check requires its audit record.')
      if (operation.reconciliation) {
        const attempt = state.attempts.find(item => item.id === operation.attempt_id)!
        if (operation.reconciliation.actor !== attempt.owner || operation.decision_actor !== attempt.owner
          || plan.content.acceptance.find(item => item.id === operation.acceptance_id)?.kind !== 'command') {
          throw new Error('Invalid check reconciliation owner or criterion.')
        }
        assertWorkspace(operation.reconciliation.candidate, attempt.workspace)
      }
    }
    else {
      const step = plan.content.steps.find(step => step.id === operation.step_id)
      if (!step || operation.scope.length === 0 || operation.scope.some(scope => !covered(scope, step.scope))
        || operation.acceptance_id !== null || operation.candidate !== null || operation.runner !== null
        || operation.supervisor !== null || operation.dispatch !== null || operation.reconciliation
        || operation.status === 'completed' || operation.status === 'reconciled') {
        throw new Error('Invalid host operation scope or step.')
      }
    }
    if (operation.delegation) {
      const delegation = operation.delegation
      const workspace = state.attempts.find(attempt => attempt.id === operation.attempt_id)!.workspace
      if (!operation.delegated || operation.kind !== 'write' || delegation.workspace.root === workspace.root
        || delegation.workspace.git_dir === workspace.git_dir || delegation.workspace.common_dir !== workspace.common_dir
        || !sameRepository(delegation.workspace.repo, workspace.repo)
        || (delegation.host === null) !== (delegation.attachment === null)
        || (delegation.host && operation.actor !== `${delegation.host.provider}:${delegation.host.task_id}`)
        || (delegation.observation && !delegation.host)
        || (delegation.result && !delegation.observation)
        || (delegation.review && !delegation.result)
        || (delegation.integration && !delegation.result)
        || (['accepted', 'rejected'].includes(operation.status) !== Boolean(delegation.integration))
        || (operation.status === 'returned' && !delegation.result)
        || (operation.status === 'accepted' && !delegation.review)) {
        throw new Error('Invalid candidate-bound delegation state.')
      }
      if (delegation.result) assertWorkspace(delegation.result.candidate, delegation.workspace)
      if (delegation.review) assertWorkspace(delegation.review.target, workspace)
      if (delegation.integration) assertWorkspace(delegation.integration.candidate, workspace)
    }
  }
  for (const check of state.checks) {
    const operation = state.operations.find(operation => operation.id === check.operation_id)
    if (!operation || operation.kind !== 'check' || operation.plan_id !== check.plan_id || operation.attempt_id !== check.attempt_id
      || operation.acceptance_id !== check.acceptance_id || operation.actor !== check.actor
      || operation.epoch !== check.epoch || !isDeepStrictEqual(operation.candidate, check.candidate)) {
      throw new Error('Check result does not match its operation.')
    }
    const plan = state.plans.find(plan => plan.id === check.plan_id)!
    const criterion = plan.content.acceptance.find(item => item.id === check.acceptance_id)!
    assertCheckSource(criterion.kind, check.source)
    if (check.outcome === 'passed' && (!check.after || !isDeepStrictEqual(check.candidate, check.after)
      || operation.status !== 'completed')) throw new Error('Passed check requires matching candidates and a terminal operation.')
  }
  if (state.yield) {
    const { attempt, plan } = current(state)
    if (state.yield.actor !== attempt.owner || state.yield.attempt_id !== attempt.id || state.yield.plan_id !== plan.id
      || state.yield.epoch !== state.epoch) throw new Error('Stored yield is stale.')
    assertWorkspace(state.yield.candidate, attempt.workspace)
  }
  const pending = state.closings.filter(closing => closing.state === 'reserved' || closing.state === 'prepared')
  if (pending.length > 1 || state.closing_id !== (pending[0]?.intent.id ?? null)) throw new Error('Inconsistent closing reservation.')
  for (const closing of state.closings) {
    if (closing.issue_dispatch && closing.intent.target.kind !== 'issue') throw new Error('Issue dispatch policy belongs only to an Issue closure.')
    if (closing.epoch > state.epoch) throw new Error('Invalid closing epoch.')
    if (closing === pending[0] && (closing.plan_id !== state.plan_id || closing.attempt_id !== state.attempt_id || closing.epoch !== state.epoch)) {
      throw new Error('Pending closure changed execution binding.')
    }
    if ((closing.state === 'reconciled') !== Boolean(closing.reconciliation)) throw new Error('Reconciled closure requires its audit record.')
    if (closing.reconciliation) {
      const attempt = state.attempts.find(item => item.id === closing.attempt_id)
      const control = closing.reconciliation.control_id
        ? state.control?.requests.find(item => item.id === closing.reconciliation!.control_id) : null
      if (closing.reconciliation.control_id
        && (!control || control.decision !== closing.reconciliation.decision)) {
        throw new Error('Invalid closure stop control binding.')
      }
      if (!attempt || closing.intent.target.kind !== 'issue' || closing.plan_id !== attempt.plan_id
        || closing.reconciliation.actor !== attempt.owner || (!control && !closing.remote_receipt) || state.epoch <= closing.epoch) {
        throw new Error('Invalid closure reconciliation identity or epoch.')
      }
      assertWorkspace(closing.reconciliation.candidate, attempt.workspace)
    }
  }
  const finished = state.closings.filter(closing => closing.state === 'completed')
  if (finished.length > 1 || (state.closure !== null) !== (finished.length === 1)) throw new Error('Inconsistent final closure.')
  if (state.closure && (state.closure.id !== finished[0]!.intent.id || state.closing_id
    || state.closure.mode !== finished[0]!.intent.mode || unresolvedOperations(state).length > 0)) throw new Error('Invalid closed workflow.')
  return state
}

/** Pure deterministic transition; callers serialize read/check/write under the Todo transaction lock. */
export function transitionWorkflow(input: unknown, requestInput: unknown, now = new Date().toISOString()): WorkflowState {
  const state = normalizeWorkflow(input)
  const request = workflowRequestSchema.parse(requestInput)
  const digest = hash(request.command)
  const previous = state.requests.find(item => item.id === request.request_id)
  if (previous) {
    if (previous.digest !== digest) throw new Error('Request id reuse with a different command is not allowed.')
    return state
  }
  if (request.expected_revision !== state.revision) throw new Error(`Workflow revision conflict: expected ${request.expected_revision}, actual ${state.revision}.`)
  apply(state, request.command, now)
  state.revision++
  state.requests.push({ id: request.request_id, digest, revision: state.revision })
  return normalizeWorkflow(state)
}

export function workflowReadiness(input: unknown, candidateInput: unknown, stopping = false): { ready: boolean; missing: string[]; reasons: string[] } {
  const state = normalizeWorkflow(input)
  const candidate = candidateReferenceSchema.parse(candidateInput)
  const reasons: string[] = []
  if (!stopping && activeControl(state)) reasons.push('A control request is active; completion readiness is suspended.')
  try {
    assertSettled(state)
    assertYield(state, candidate)
  }
  catch (error) { reasons.push((error as Error).message) }
  const plan = state.plans.find(plan => plan.id === state.plan_id)
  const missing = (plan?.content.acceptance ?? []).filter(criterion => {
    if (!criterion.required) return false
    const latest = state.checks.filter(check => check.acceptance_id === criterion.id && check.plan_id === state.plan_id
      && check.attempt_id === state.attempt_id && check.epoch === state.epoch
      && isDeepStrictEqual(check.candidate, candidate)).at(-1)
    return !latest || latest.outcome !== 'passed'
  }).map(criterion => criterion.id)
  return { ready: reasons.length === 0 && missing.length === 0, missing, reasons }
}
