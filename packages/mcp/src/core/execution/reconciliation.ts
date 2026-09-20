import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { currentTodoExecution, TodoStore } from '../storage/todo-store.js'
import { ExecutionArtifacts } from './artifacts.js'
import { captureCandidate, verifyCandidateManifest } from './candidate.js'
import { observeCheck, readRecordedCheck } from './checks.js'
import { candidateReferenceSchema, operationSchema, processHandleSchema } from './contracts.js'
import type { CandidateReference, WorkflowOperation, WorkflowState } from './contracts.js'
import { assertLocalWorkspace, localMachine, observeProcess } from './processes.js'

const text = z.string().trim().min(1).max(16_384)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const reportSchema = z.object({
  source: z.enum(['host_report', 'user']), actor: text, locator: text,
  operation_id: text, attempt_id: text, observed_at: z.string().datetime(),
  raw: text, coverage_basis: text, reviewed_candidate: digest, changes_review: text.optional(),
  descendants: z.array(z.object({ handle: processHandleSchema, locator: text }).strict()).max(64),
  accounted_missing: z.array(z.enum(['runner', 'supervisor', 'command'])).max(3),
  unresolved: z.array(text).max(100),
}).strict()
const requestSchema = z.object({
  directory: text, todo_id: text, execution_id: text, operation_id: text,
  request_id: text, expected_revision: z.number().int().nonnegative(), actor: text, decision: text,
  report: reportSchema,
}).strict()
export { requestSchema as checkReconciliationRequestSchema }
type Request = z.infer<typeof requestSchema>
const recordedRequestSchema = requestSchema.omit({ directory: true, expected_revision: true })
const observedProcessSchema = z.object({
  handle: processHandleSchema,
  observation: z.object({
    state: z.enum(['running', 'stopped', 'replaced', 'unknown']), observed_at: z.string().datetime(), reason: text,
  }).strict(),
}).strict()
const observationSchema = z.object({
  runner: observedProcessSchema.nullable(),
  supervisor: observedProcessSchema.nullable(), command: observedProcessSchema.nullable(),
  descendants: z.array(observedProcessSchema),
}).strict()
const pointersSchema = z.object({ supervisor: digest.nullable(), process: digest.nullable(), result: digest.nullable() }).strict()
const recordSchema = z.object({
  version: z.literal(1), todo_id: text, execution_id: text, operation_id: text,
  plan_id: text, attempt_id: text, epoch: z.number().int().nonnegative(), owner: text,
  original: operationSchema, candidate: candidateReferenceSchema, manifest: digest,
  machine: processHandleSchema.shape.machine,
  changed_since_check: z.boolean(), observation: observationSchema, receipts: pointersSchema,
  request: recordedRequestSchema, captured_at: z.string().datetime(),
}).strict()
type Record = z.infer<typeof recordSchema>

function readState(store: TodoStore, input: Request) {
  const todo = store.resolveItemFromAll(input.todo_id)
  if (!todo || todo.id !== input.todo_id) throw new Error('Exact stable Todo identity required for reconciliation.')
  const execution = todo.executions.find(item => item.id === input.execution_id)
  const state = execution?.workflow
  const operation = state?.operations.find(item => item.id === input.operation_id)
  const attempt = state?.attempts.find(item => item.id === operation?.attempt_id)
  if (!state || !operation || !attempt) throw new Error('Original check execution/attempt is unavailable.')
  return { todo, execution, state, operation, attempt }
}

function storedRequest(input: Request) {
  const { directory: _directory, expected_revision: _revision, ...request } = input
  return request
}
const receiptKey = (input: Pick<Request, 'operation_id' | 'request_id'>) => JSON.stringify([input.operation_id, input.request_id])

function pointers(artifacts: ExecutionArtifacts) {
  return (operationId: string) => ({
    supervisor: artifacts.getReceipt(operationId, 'supervisor')?.digest ?? null,
    process: artifacts.getReceipt(operationId, 'process')?.digest ?? null,
    result: artifacts.getReceipt(operationId)?.digest ?? null,
  })
}

function requireStopped(observed: z.infer<typeof observedProcessSchema>, label: string) {
  if (observed.observation.state !== 'stopped' && observed.observation.state !== 'replaced') {
    throw new Error(`${label} is ${observed.observation.state}, not stopped; keep the original operation occupied.`)
  }
}

function validateReport(input: Request, operation: WorkflowOperation, candidate: CandidateReference, now: string) {
  const report = input.report
  if (report.operation_id !== operation.id || report.attempt_id !== operation.attempt_id
    || report.reviewed_candidate !== candidate.digest) throw new Error('Reconciliation report must identify the original operation and the exact reviewed current candidate.')
  if (Date.parse(report.observed_at) < Date.parse(operation.uncertain_at ?? operation.started_at)
    || Date.parse(report.observed_at) > Date.parse(now)) throw new Error('Use a fresh reconciliation report after the interruption, not stale or future observations.')
  if (report.unresolved.length) throw new Error('Unresolved process questions prevent reconciliation.')
  if (!isDeepStrictEqual(candidate, operation.candidate) && !report.changes_review) {
    throw new Error('Explicitly review changed, unverified workspace content before releasing its operation.')
  }
}

function freshObservation(input: Request, state: WorkflowState, operation: WorkflowOperation) {
  const original = readRecordedCheck(input.directory, input.todo_id, input.execution_id, state, input.operation_id)
  if (original && (original.receipt.process === null || original.receipt.process.process_stopped)) {
    throw new Error('A normal terminal result exists. Recover that original receipt; do not discard it through reconciliation.')
  }
  const observed = observeCheck({
    directory: input.directory, todo_id: input.todo_id,
    execution_id: input.execution_id, operation_id: input.operation_id,
  })
  if (operation.dispatch === null) {
    if (observed.runner) requireStopped(observed.runner, 'Original legacy runner')
    else if (!input.report.accounted_missing.includes('runner')) {
      throw new Error('Missing legacy runner metadata must be explicitly accounted for, not inferred as never started.')
    }
  }
  for (const name of ['supervisor', 'command'] as const) {
    const entry = observed[name]
    if (entry) requireStopped(entry, `Original ${name}`)
    else if (!input.report.accounted_missing.includes(name)) {
      throw new Error(`Missing ${name} metadata must be explicitly accounted for in the external report, not inferred as never started.`)
    }
  }
  const descendants = input.report.descendants.map(({ handle }) => ({ handle, observation: observeProcess(handle) }))
  for (const entry of descendants) requireStopped(entry, `Reported descendant ${entry.handle.pid}`)
  return observationSchema.parse({ runner: observed.runner, supervisor: observed.supervisor, command: observed.command, descendants })
}

function validateRecord(record: Record, todoId: string, executionId: string, state: WorkflowState, operation: WorkflowOperation) {
  const attempt = state.attempts.find(item => item.id === operation.attempt_id)
  const { reconciliation: _reconciliation, status: _status, ended_at: _ended, decision_actor: _actor, ...unchanged } = operation
  const { reconciliation: _oldReconciliation, status: _oldStatus, ended_at: _oldEnded, decision_actor: _oldActor, ...original } = record.original
  if (record.todo_id !== todoId || record.execution_id !== executionId || record.operation_id !== operation.id
    || record.plan_id !== operation.plan_id || record.attempt_id !== operation.attempt_id || record.epoch !== operation.epoch
    || record.owner !== attempt?.owner || record.request.actor !== record.owner || record.original.reconciliation
    || !['running', 'unknown'].includes(record.original.status) || record.original.kind !== 'check'
    || !isDeepStrictEqual(unchanged, original)
    || !attempt || !isDeepStrictEqual(record.machine, attempt.workspace.machine)
    || record.candidate.root !== attempt.workspace.root || record.candidate.git_dir !== attempt.workspace.git_dir
    || record.candidate.common_dir !== attempt.workspace.common_dir
    || record.changed_since_check !== !isDeepStrictEqual(record.candidate, operation.candidate)) {
    throw new Error('Reconciliation evidence differs from the original operation or workspace.')
  }
  validateReport({ ...record.request, directory: '', expected_revision: 0 }, record.original, record.candidate, record.captured_at)
  if (!isDeepStrictEqual(record.observation.runner?.handle ?? null, operation.runner)) throw new Error('Reconciliation runner identity changed.')
  if (record.original.dispatch === null) {
    if (record.observation.runner) requireStopped(record.observation.runner, 'Recorded legacy runner')
    else if (!record.request.report.accounted_missing.includes('runner')) throw new Error('Reconciliation lacks legacy-runner accounting.')
  }
  for (const name of ['supervisor', 'command'] as const) {
    const entry = record.observation[name]
    if (entry) requireStopped(entry, `Recorded ${name}`)
    else if (!record.request.report.accounted_missing.includes(name)) throw new Error('Reconciliation lacks missing-process accounting.')
  }
  if (record.observation.descendants.length !== record.request.report.descendants.length) throw new Error('Incomplete descendant observations.')
  record.observation.descendants.forEach((entry, index) => {
    if (!isDeepStrictEqual(entry.handle, record.request.report.descendants[index]!.handle)) throw new Error('Reconciliation descendant identity changed.')
    requireStopped(entry, 'Recorded descendant')
  })
}

export function verifyCheckReconciliation(
  directory: string, todoId: string, executionId: string, state: WorkflowState, operation: WorkflowOperation,
): string {
  const link = operation.reconciliation
  if (!link || operation.status !== 'reconciled') throw new Error('Operation is not reconciled.')
  const artifacts = new ExecutionArtifacts(directory, executionId)
  const record = recordSchema.parse(artifacts.get(link.receipt))
  validateRecord(record, todoId, executionId, state, operation)
  if (link.actor !== record.owner || link.decision !== record.request.decision || !isDeepStrictEqual(link.candidate, record.candidate)
    || artifacts.getReceipt(receiptKey(record.request), 'reconciliation')?.digest !== link.receipt) {
    throw new Error('Reconciliation pointer or owner decision differs from its record.')
  }
  verifyCandidateManifest(artifacts.get(record.manifest), record.candidate)
  for (const receipt of Object.values(record.receipts)) if (receipt) artifacts.get(receipt)
  return link.receipt
}

/** Explicit cooperative accounting, never a substitute for a captured command result. */
export function reconcileCheck(raw: unknown) {
  const input = requestSchema.parse(raw)
  const store = new TodoStore(input.directory)
  const initial = readState(store, input)
  const artifacts = new ExecutionArtifacts(input.directory, input.execution_id)
  const key = receiptKey(input)
  const saved = artifacts.getReceipt(key, 'reconciliation')
  let record = saved ? recordSchema.parse(saved.value) : null
  if (record && !isDeepStrictEqual(record.request, storedRequest(input))) throw new Error('Conflicting reconciliation request reuse.')
  if (initial.operation.reconciliation) {
    if (!saved || saved.digest !== initial.operation.reconciliation.receipt) throw new Error('Operation was already reconciled by a different request.')
    verifyCheckReconciliation(input.directory, input.todo_id, input.execution_id, initial.state, initial.operation)
    return result(initial.state, input.operation_id, saved.digest)
  }
  if (currentTodoExecution(initial.todo)?.id !== input.execution_id || initial.state.attempt_id !== initial.attempt.id
    || initial.operation.kind !== 'check' || !['running', 'unknown'].includes(initial.operation.status)
    || initial.attempt.owner !== input.actor || initial.state.closing_id
    || initial.state.plans.find(plan => plan.id === initial.operation.plan_id)?.content.acceptance
      .find(item => item.id === initial.operation.acceptance_id)?.kind !== 'command') {
    throw new Error('Reconciliation requires the open original command check and its accountable owner.')
  }
  if (initial.state.revision !== input.expected_revision) throw new Error('Reconciliation revision conflict; read the original operation again.')
  assertLocalWorkspace(initial.attempt.workspace)
  const beforePointers = pointers(artifacts)(input.operation_id)
  const observation = freshObservation(input, initial.state, initial.operation)
  const snapshot = captureCandidate(initial.attempt.workspace.root)
  const { digest: candidateDigest, root, git_dir, common_dir } = snapshot
  const candidate = { digest: candidateDigest, root, git_dir, common_dir }
  const now = new Date().toISOString()
  validateReport(input, initial.operation, candidate, now)
  if (record) {
    validateRecord(record, input.todo_id, input.execution_id, initial.state, initial.operation)
    verifyCandidateManifest(artifacts.get(record.manifest), record.candidate)
    if (!isDeepStrictEqual(record.candidate, candidate) || !isDeepStrictEqual(record.receipts, beforePointers)) {
      throw new Error('Workspace or receipts changed after reconciliation publication; review the current state with a new request.')
    }
  }
  else {
    record = recordSchema.parse({
      version: 1, todo_id: input.todo_id, execution_id: input.execution_id, operation_id: input.operation_id,
      plan_id: initial.operation.plan_id, attempt_id: initial.attempt.id, epoch: initial.operation.epoch, owner: input.actor,
      original: initial.operation, candidate, manifest: artifacts.put(snapshot),
      machine: localMachine(),
      changed_since_check: !isDeepStrictEqual(candidate, initial.operation.candidate),
      observation, receipts: beforePointers, request: storedRequest(input), captured_at: now,
    })
  }
  const receipt = saved?.digest ?? artifacts.putReceipt(key, record, 'reconciliation')
  // Publication can stall or fail; never release against a workspace observed before that boundary.
  const latest = captureCandidate(initial.attempt.workspace.root)
  if (!isDeepStrictEqual(record.candidate, {
    digest: latest.digest, root: latest.root, git_dir: latest.git_dir, common_dir: latest.common_dir,
  })) throw new Error('Workspace changed during reconciliation publication; review the current candidate with a new request.')
  const workflow = store.transaction(() => {
    const current = readState(store, input)
    if (current.state.revision !== input.expected_revision || !isDeepStrictEqual(current.operation, record.original)
      || !isDeepStrictEqual(pointers(artifacts)(input.operation_id), record.receipts)) {
      throw new Error('Operation or receipts changed during reconciliation; no occupancy was released.')
    }
    return store.applyWorkflow(input.todo_id, input.execution_id, {
      request_id: input.request_id, expected_revision: input.expected_revision,
      command: { action: 'reconcile_check', operation_id: input.operation_id, actor: input.actor,
        decision: input.decision, receipt, candidate: record.candidate },
    })
  })
  return result(workflow, input.operation_id, receipt)
}

function result(workflow: WorkflowState, operationId: string, receipt: string) {
  return {
    schema_version: 1, operation_id: operationId, reconciliation_receipt: receipt, verification: 'not_verified',
    workflow, limitations: [
      'External reconciliation reports are cooperative claims, not process-tree discovery or authentication.',
      'Unlisted descendants may exist. Never submit a report without actually accounting for the original command and descendants.',
      'No command was rerun and no passed check was created. Yield and run fresh acceptance checks before delivery.',
    ],
  }
}
