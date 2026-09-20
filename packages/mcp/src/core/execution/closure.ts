import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { TodoStore } from '../storage/todo-store.js'
import type { TodoItem } from '../storage/todo-store.js'
import { ExecutionArtifacts } from './artifacts.js'
import { captureCandidate } from './candidate.js'
import { closureIntentSchema } from './contracts.js'
import type { CandidateReference, ClosureIntent, WorkflowCommand, WorkflowState } from './contracts.js'
import { verifyReadiness } from './verification.js'
import { assertLocalWorkspace } from './processes.js'
import { assertClosureCoverage, assertControlAllows } from './workflow.js'
import { collectRemoteDeliveries, hasRemoteDeliveries } from './remote-delivery.js'
import type { RemoteDeliveryBatch } from './remote-delivery.js'
import { verifyControlHistory } from './control.js'

export const closureRequestSchema = z.object({
  directory: z.string().min(1), todo_id: z.string().min(1), execution_id: z.string().min(1),
  closure_id: closureIntentSchema.shape.id,
  expected_revision: z.number().int().nonnegative(),
  mode: closureIntentSchema.shape.mode,
  acknowledged_gaps: closureIntentSchema.shape.acknowledged_gaps,
  decision: closureIntentSchema.shape.decision,
  note: closureIntentSchema.shape.note,
  target: closureIntentSchema.shape.target,
}).strict()
export type ClosureRequest = z.infer<typeof closureRequestSchema>
export const completionSchema = closureRequestSchema.omit({ directory: true, todo_id: true, target: true }).strict()

function intent(input: ClosureRequest): ClosureIntent {
  return {
    id: input.closure_id, mode: input.mode, decision: input.decision, note: input.note,
    acknowledged_gaps: input.acknowledged_gaps, target: input.target,
  }
}

function load(store: TodoStore, input: ClosureRequest) {
  // Completed requests remain readable after a separate explicit archival.
  const active = store.list().find(todo => todo.id === input.todo_id)
  const archived = store.listArchived().find(todo => todo.id === input.todo_id)
  const todo = active ?? archived
  if (!todo) throw new Error('Todo not found for managed closure.')
  const execution = todo.executions.find(execution => execution.id === input.execution_id)
  if (!execution?.workflow) throw new Error('Managed execution not found for closure.')
  if (todo.executions.at(-1)?.id !== execution.id) throw new Error('Closure refers to a superseded execution.')
  const state = execution.workflow
  const closing = state.closings.find(closing => closing.intent.id === input.closure_id)
  if (closing && !isDeepStrictEqual(closing.intent, intent(input))) throw new Error('Closure id reuse with a different intent.')
  return { todo, execution, state, closing, archived, active }
}

function apply(store: TodoStore, input: ClosureRequest, suffix: string, command: WorkflowCommand, expectedRevision?: number): WorkflowState {
  const state = load(store, input).state
  return store.applyWorkflow(input.todo_id, input.execution_id, {
    request_id: `closure-${createHash('sha256').update(`${input.closure_id}:${suffix}`).digest('hex')}`,
    expected_revision: expectedRevision ?? state.revision, command,
  })
}

export interface ClosureVerification {
  version: 1
  todo_id: string
  execution_id: string
  closure_id: string
  candidate: CandidateReference | null
  gaps: string[]
  errors: string[]
  check_receipts: string[]
  manifest?: string | null
  deliveries?: ReturnType<typeof verifyReadiness>['deliveries']
}

function verify(input: ClosureRequest, state: WorkflowState, remoteBatch?: RemoteDeliveryBatch): { report: ClosureVerification; artifact: string } {
  const closing = state.closings.find(closing => closing.intent.id === state.closing_id)
  if (!closing || closing.intent.id !== input.closure_id) throw new Error('No matching closing reservation.')
  let candidate: CandidateReference | null = null
  const artifacts = new ExecutionArtifacts(input.directory, input.execution_id)
  const gaps: string[] = []
  const errors: string[] = []
  const receipts: string[] = []
  let manifest: string | null = null
  let deliveries: ReturnType<typeof verifyReadiness>['deliveries'] = []
  if (state.attempt_id) {
    const attempt = state.attempts.find(attempt => attempt.id === state.attempt_id)!
    assertLocalWorkspace(attempt.workspace)
    const captured = captureCandidate(attempt.workspace.root)
    candidate = { digest: captured.digest, root: captured.root, git_dir: captured.git_dir, common_dir: captured.common_dir }
    if (!isDeepStrictEqual(candidate, closing.candidate)) throw new Error('Candidate drifted since yield/closure preparation; keep the reservation and reconcile.')
    const readiness = verifyReadiness(input.directory, input.todo_id, input.execution_id, state, candidate, input.mode === 'stopped', captured, remoteBatch)
    if (readiness.reasons.length) throw new Error(readiness.reasons.join(' '))
    if (readiness.gaps.some(gap => /^(delegation|relocation|reconciliation|closure-reconciliation|control):/.test(gap))) {
      throw new Error(`Original operation accounting evidence must be repaired before closure: ${readiness.gaps.join(', ')}.`)
    }
    gaps.push(...readiness.gaps)
    errors.push(...readiness.errors)
    receipts.push(...readiness.check_receipts)
    manifest = artifacts.put(captured)
    deliveries = readiness.deliveries
  }
  else {
    try {
      receipts.push(...verifyControlHistory(input.directory, input.todo_id, input.execution_id, state))
    }
    catch (error) {
      throw new Error(`Original control accounting evidence must be repaired before closure: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const report: ClosureVerification = {
    version: 1, todo_id: input.todo_id, execution_id: input.execution_id, closure_id: input.closure_id,
    candidate, gaps: [...new Set(gaps)].sort(), errors, check_receipts: receipts, manifest, deliveries,
  }
  return { report, artifact: artifacts.put(report) }
}

function reserve(store: TodoStore, input: ClosureRequest): WorkflowState {
  const initial = load(store, input)
  if (initial.state.closure) {
    if (initial.state.closure.id !== input.closure_id) throw new Error('Execution closed with a different intent.')
    return initial.state
  }
  assertControlAllows(initial.state, { action: 'reserve_closure', intent: intent(input) })
  if (!initial.closing) {
    store.applyWorkflow(input.todo_id, input.execution_id, {
      request_id: `reserve-${createHash('sha256').update(input.closure_id).digest('hex')}`,
      expected_revision: input.expected_revision, command: { action: 'reserve_closure', intent: intent(input) },
    })
  }
  return load(store, input).state
}

export function prepareClosure(raw: unknown, remoteBatch?: RemoteDeliveryBatch): WorkflowState {
  const input = closureRequestSchema.parse(raw)
  const store = new TodoStore(input.directory)
  const state = reserve(store, input)
  if (state.closure) return state
  const closing = state.closings.find(item => item.intent.id === input.closure_id)!
  if (closing.state === 'prepared') {
    const { report } = verify(input, state, remoteBatch)
    assertClosureCoverage(state, report.candidate, closing.intent, report.gaps)
    return state
  }
  if (closing.state !== 'reserved') throw new Error('Closure has been cancelled; use a new closure id after reconciling.')
  try {
    const { report, artifact } = verify(input, state, remoteBatch)
    return apply(store, input, 'prepare', {
      action: 'prepare_closure', closure_id: input.closure_id, candidate: report.candidate, gaps: report.gaps, verification: artifact,
    }, state.revision)
  }
  catch (error) {
    // No public effects may occur before a prepared reservation is returned.
    apply(store, input, 'cancel-preflight', {
      action: 'cancel_closure', closure_id: input.closure_id, note: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export function recordClosureRemoteReceipt(raw: unknown, receipt: string): WorkflowState {
  const input = closureRequestSchema.parse(raw)
  return apply(new TodoStore(input.directory), input, 'remote', {
    action: 'closure_remote_receipt', closure_id: input.closure_id, receipt,
  })
}

export function finalizeClosure(raw: unknown, remoteBatch?: RemoteDeliveryBatch): TodoItem {
  const input = closureRequestSchema.parse(raw)
  const store = new TodoStore(input.directory)
  let snapshot = load(store, input)
  if (!snapshot.state.closure) {
    if (snapshot.closing?.state !== 'prepared') throw new Error('Closure must be prepared before finalization.')
    const { report, artifact } = verify(input, snapshot.state, remoteBatch)
    apply(store, input, 'finish', {
      action: 'finish_closure', closure_id: input.closure_id,
      candidate: report.candidate, gaps: report.gaps, verification: artifact,
    }, snapshot.state.revision)
    snapshot = load(store, input)
  }
  if (snapshot.state.closure?.id !== input.closure_id) throw new Error('Execution was closed with another outcome.')
  return store.transaction(() => {
    const current = load(store, input)
    if (current.active) {
      store.refreshRecord(input.todo_id)
      return current.active
    }
    if (current.archived) return current.archived
    throw new Error('Closed Todo has no recoverable record.')
  })
}

export function closeManaged(raw: unknown): TodoItem {
  prepareClosure(raw)
  return finalizeClosure(raw)
}

async function observeForClosure(input: ClosureRequest, state: WorkflowState) {
  if (input.mode === 'stopped' || state.closure || !hasRemoteDeliveries(state)) return undefined
  const attempt = state.attempts.find(attempt => attempt.id === state.attempt_id)
  if (!attempt) throw new Error('Remote delivery requires a bound local attempt.')
  assertLocalWorkspace(attempt.workspace)
  const candidate = captureCandidate(attempt.workspace.root)
  return collectRemoteDeliveries(input.directory, input.todo_id, input.execution_id, state, candidate)
}

/** Async boundary: no Todo transaction spans these readbacks. */
export async function prepareClosureWithReadback(raw: unknown): Promise<WorkflowState> {
  const input = closureRequestSchema.parse(raw)
  const state = reserve(new TodoStore(input.directory), input)
  const batch = await observeForClosure(input, state)
  return prepareClosure(input, batch)
}

export async function finalizeClosureWithReadback(raw: unknown): Promise<TodoItem> {
  const input = closureRequestSchema.parse(raw)
  const state = load(new TodoStore(input.directory), input).state
  const batch = await observeForClosure(input, state)
  return finalizeClosure(input, batch)
}

export async function closeManagedWithReadback(raw: unknown): Promise<TodoItem> {
  await prepareClosureWithReadback(raw)
  return finalizeClosureWithReadback(raw)
}
