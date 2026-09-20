import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { currentTodoExecution, TodoStore } from '../storage/todo-store.js'
import { ExecutionArtifacts } from './artifacts.js'
import { captureCandidate, verifyCandidateManifest } from './candidate.js'
import { candidateReferenceSchema } from './contracts.js'
import type { WorkflowCommand, WorkflowState } from './contracts.js'
import { assertLocalWorkspace } from './processes.js'
import { activeControl, transitionWorkflow, unresolvedOperations } from './workflow.js'
import { verifyReadiness } from './verification.js'
import { assertRemoteEffectsSettled } from '../storage/remote-effects.js'
import { assertNoPendingIssueClose } from '../storage/issue-close-journal.js'

const text = z.string().trim().min(1).max(16_384)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const input = z.object({
  directory: text, todo_id: text, execution_id: text, request_id: text,
  expected_revision: z.number().int().nonnegative(), control_id: text, actor: text,
})
export const pauseSettlementSchema = input.strict()
export const continueRequestSchema = input.extend({ decision: text }).strict()
export const cancelCloseRequestSchema = input.extend({ closure_id: text, note: text }).strict()
const recordSchema = z.object({
  version: z.literal(1), todo_id: text, execution_id: text, control_id: text,
  action: z.enum(['settle_pause', 'resume_control']),
  plan_id: text.nullable(), attempt_id: text.nullable(), epoch: z.number().int().nonnegative(),
  request: continueRequestSchema.omit({ directory: true }).partial({ decision: true }),
  candidate: candidateReferenceSchema.nullable(), manifest: digest.nullable(),
  at: z.string().datetime(),
}).strict()

export function cancelPendingClose(raw: unknown): WorkflowState {
  const input = cancelCloseRequestSchema.parse(raw)
  const store = new TodoStore(input.directory)
  return store.transaction(() => {
    const todo = store.resolveItemById(input.todo_id)?.item
    const execution = todo && currentTodoExecution(todo)
    if (execution?.id !== input.execution_id || !execution.workflow) throw new Error('Open original execution required for closure withdrawal.')
    const state = execution.workflow
    const command: WorkflowCommand = {
      action: 'cancel_closure', closure_id: input.closure_id, control_id: input.control_id,
      actor: input.actor, note: input.note,
    }
    const request = { request_id: input.request_id, expected_revision: input.expected_revision, command }
    if (state.requests.some(item => item.id === input.request_id)) {
      // Exact replay reads the current state without withdrawing a newer reservation.
      return transitionWorkflow(state, request)
    }
    const attempt = state.attempts.find(item => item.id === state.attempt_id)
    if (attempt) assertLocalWorkspace(attempt.workspace)
    return store.applyWorkflow(input.todo_id, input.execution_id, request)
  })
}

export function verifyControlHistory(directory: string, todoId: string, executionId: string, state: WorkflowState): string[] {
  if (!state.control?.events.length) return []
  const artifacts = new ExecutionArtifacts(directory, executionId)
  return (state.control?.events ?? []).filter(event => event.kind === 'paused' || event.kind === 'resumed').map(event => {
    const record = recordSchema.parse(artifacts.get(event.verification!))
    const request = state.control!.requests.find(request => request.id === event.control_id)!
    const attempt = state.attempts.find(attempt => attempt.id === record.attempt_id)
    if (record.todo_id !== todoId || record.execution_id !== executionId || record.control_id !== event.control_id
      || record.request.todo_id !== todoId || record.request.execution_id !== executionId
      || record.request.control_id !== event.control_id || record.request.actor !== event.actor
      || record.action !== (event.kind === 'paused' ? 'settle_pause' : 'resume_control')
      || (record.action === 'resume_control' ? record.request.decision : request.decision) !== event.decision
      || record.request.expected_revision + 1 !== event.at_revision || record.epoch > state.epoch
      || (event.kind === 'resumed' && record.epoch >= state.epoch)
      || state.requests.find(item => item.id === record.request.request_id)?.revision !== event.at_revision
      || !isDeepStrictEqual(record.candidate, event.candidate)
      || artifacts.getReceipt(record.request.request_id, 'control')?.digest !== event.verification) {
      throw new Error('Control receipt does not support the recorded settlement or resumption.')
    }
    const command: WorkflowCommand = record.action === 'settle_pause'
      ? { action: record.action, control_id: record.control_id, actor: record.request.actor, candidate: record.candidate, verification: event.verification! }
      : { action: record.action, control_id: record.control_id, actor: record.request.actor, candidate: record.candidate,
          verification: event.verification!, decision: record.request.decision! }
    // Compare the immutable command against its exact persisted request digest.
    transitionWorkflow(state, { request_id: record.request.request_id, expected_revision: record.request.expected_revision, command })
    if (record.attempt_id) {
      if (!attempt || attempt.plan_id !== record.plan_id || attempt.owner !== event.actor || !record.candidate || !record.manifest) {
        throw new Error('Control receipt is missing the original workspace binding.')
      }
      const { root, git_dir, common_dir } = attempt.workspace
      if (record.candidate.root !== root || record.candidate.git_dir !== git_dir || record.candidate.common_dir !== common_dir) {
        throw new Error('Control receipt belongs to another workspace.')
      }
      verifyCandidateManifest(artifacts.get(record.manifest), record.candidate)
    }
    else if (record.candidate || record.manifest) throw new Error('Unbound control cannot contain workspace evidence.')
    return event.verification!
  })
}

/** Local settlement inspects real files; the generic MCP command only records intent. */
export function settleControl(action: 'settle_pause' | 'resume_control', raw: unknown): WorkflowState {
  const input = (action === 'settle_pause' ? pauseSettlementSchema : continueRequestSchema).parse(raw)
  const store = new TodoStore(input.directory)
  return store.transaction(() => {
    const todo = store.resolveItemById(input.todo_id)?.item
    const execution = todo && currentTodoExecution(todo)
    if (execution?.id !== input.execution_id || !execution.workflow) throw new Error('Open original execution required for control.')
    const state = execution.workflow
    const artifacts = new ExecutionArtifacts(input.directory, input.execution_id)
    const { directory: _directory, ...request } = input
    const saved = artifacts.getReceipt(input.request_id, 'control')
    const previous = saved ? recordSchema.parse(saved.value) : null
    if (previous && (previous.action !== action || !isDeepStrictEqual(previous.request, request))) {
      throw new Error('Conflicting control request reuse.')
    }
    const commandFor = (record: z.infer<typeof recordSchema>, verification: string): WorkflowCommand =>
      action === 'settle_pause'
        ? { action, control_id: input.control_id, actor: input.actor, candidate: record.candidate, verification }
        : { action, control_id: input.control_id, actor: input.actor, candidate: record.candidate, verification,
            decision: continueRequestSchema.parse(raw).decision }
    if (previous && state.requests.some(item => item.id === input.request_id)) {
      verifyControlHistory(input.directory, input.todo_id, input.execution_id, state)
      return store.applyWorkflow(input.todo_id, input.execution_id, {
        request_id: input.request_id, expected_revision: input.expected_revision, command: commandFor(previous, saved!.digest),
      })
    }
    if (state.revision !== input.expected_revision) throw new Error('Control revision changed; inspect current state before continuing.')
    assertRemoteEffectsSettled(input.directory, input.todo_id)
    assertNoPendingIssueClose(input.directory, input.todo_id)
    if (activeControl(state)?.id !== input.control_id || state.closing_id || unresolvedOperations(state).length) {
      throw new Error('Control settlement requires the active request, no pending closure and no unresolved operations.')
    }
    verifyControlHistory(input.directory, input.todo_id, input.execution_id, state)
    const attempt = state.attempts.find(item => item.id === state.attempt_id)
    let candidate = null
    let manifest = null
    if (attempt) {
      assertLocalWorkspace(attempt.workspace)
      const captured = captureCandidate(attempt.workspace.root)
      candidate = { digest: captured.digest, root: captured.root, git_dir: captured.git_dir, common_dir: captured.common_dir }
      if (action === 'settle_pause' && !isDeepStrictEqual(state.yield?.candidate, candidate)) {
        throw new Error('Yield the current candidate after accounting for all work before settling pause.')
      }
      const evidence = verifyReadiness(input.directory, input.todo_id, input.execution_id, state, candidate, false, captured)
      if (evidence.gaps.some(gap => /^(delegation|relocation|reconciliation|closure-reconciliation|control):/.test(gap))) {
        throw new Error('Original operation accounting evidence is incomplete; repair it before control settlement.')
      }
      manifest = artifacts.put(captured)
    }
    const record = recordSchema.parse({
      version: 1, todo_id: input.todo_id, execution_id: input.execution_id, control_id: input.control_id,
      action, plan_id: state.plan_id, attempt_id: state.attempt_id, epoch: state.epoch, request,
      candidate, manifest, at: previous?.at ?? new Date().toISOString(),
    })
    if (previous && !isDeepStrictEqual(previous, record)) throw new Error('Control candidate changed after receipt publication; inspect and use a new request.')
    transitionWorkflow(state, { request_id: input.request_id, expected_revision: input.expected_revision,
      command: commandFor(record, '0'.repeat(64)) })
    const verification = saved?.digest ?? artifacts.putReceipt(input.request_id, record, 'control')
    return store.applyWorkflow(input.todo_id, input.execution_id, {
      request_id: input.request_id, expected_revision: input.expected_revision, command: commandFor(record, verification),
    })
  })
}
