import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { currentTodoExecution, TodoStore } from '../storage/todo-store.js'
import { ExecutionArtifacts } from './artifacts.js'
import { captureCandidate, verifyCandidateManifest } from './candidate.js'
import { candidateReferenceSchema } from './contracts.js'
import type { WorkflowState } from './contracts.js'
import { assertLocalWorkspace } from './processes.js'
import { transitionWorkflow } from './workflow.js'

export const reportInputSchema = z.object({
  directory: z.string().min(1), todo_id: z.string().min(1), execution_id: z.string().min(1),
  request_id: z.string().min(1), expected_revision: z.number().int().nonnegative(),
  operation_id: z.string().min(1), acceptance_id: z.string().min(1), actor: z.string().min(1),
  plan_id: z.string().min(1), attempt_id: z.string().min(1), epoch: z.number().int().nonnegative(),
  candidate: candidateReferenceSchema,
  observed_at: z.string().datetime(),
  source: z.enum(['user', 'host_report']), outcome: z.enum(['passed', 'failed', 'blocked']),
  locator: z.string().trim().min(1).max(16_384), summary: z.string().trim().min(1).max(16_384),
}).strict()
const intentSchema = reportInputSchema.omit({ directory: true })
const reportSchema = reportInputSchema.omit({ directory: true, request_id: true, expected_revision: true }).extend({
  version: z.union([z.literal(1), z.literal(2)]),
  observed_at: z.string().datetime().optional(),
  intent: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  after: candidateReferenceSchema, manifest: z.string(),
}).strict()

function verifyIntent(artifacts: ExecutionArtifacts, report: z.infer<typeof reportSchema>): void {
  if (report.version === 1) return
  const intent = artifacts.getReceipt(report.operation_id, 'report-intent')
  if (!report.intent || intent?.digest !== report.intent) throw new Error('Report intent is missing or differs from the original observation.')
  const { request_id: _request, expected_revision: _revision, ...original } = intentSchema.parse(intent.value)
  const { version: _version, intent: _intent, after: _after, manifest: _manifest, ...observed } = report
  if (!isDeepStrictEqual(original, observed)) throw new Error('Report differs from its original observation.')
}

export function verifyReportResult(
  directory: string, todoId: string, executionId: string, state: WorkflowState, check: WorkflowState['checks'][number],
): void {
  const artifacts = new ExecutionArtifacts(directory, executionId)
  const report = reportSchema.parse(artifacts.get(check.receipt))
  verifyIntent(artifacts, report)
  const pointer = artifacts.getReceipt(check.operation_id)
  if (!pointer || pointer.digest !== check.receipt || report.todo_id !== todoId || report.execution_id !== executionId
    || report.operation_id !== check.operation_id || report.plan_id !== check.plan_id || report.attempt_id !== check.attempt_id
    || report.epoch !== check.epoch || report.acceptance_id !== check.acceptance_id || report.source !== check.source
    || report.actor !== check.actor || report.summary !== check.summary || report.outcome !== check.outcome
    || !isDeepStrictEqual(report.candidate, check.candidate) || !isDeepStrictEqual(report.after, check.after)) {
    throw new Error('Manual/review report does not support the stored check.')
  }
  const operation = state.operations.find(item => item.id === report.operation_id)
  if (operation?.status !== 'completed' || operation.receipt !== check.receipt) throw new Error('Report operation is not completed.')
  verifyCandidateManifest(artifacts.get(report.manifest), report.after)
}

/** Host/user observations remain reported evidence, never a captured command result. */
export function recordCheckReport(raw: unknown) {
  const input = reportInputSchema.parse(raw)
  const store = new TodoStore(input.directory)
  const artifacts = new ExecutionArtifacts(input.directory, input.execution_id)
  const lookup = () => {
    const todo = store.resolveItemById(input.todo_id)?.item
    const execution = todo && currentTodoExecution(todo)
    if (execution?.id !== input.execution_id || !execution.workflow) throw new Error('Managed execution changed.')
    return execution.workflow
  }
  const { directory: _directory, ...intent } = input
  const reservation = store.transaction(() => {
    const state = lookup()
    const attempt = state.attempts.find(item => item.id === state.attempt_id)
    if (!attempt) throw new Error('Bind a local workspace before reporting.')
    assertLocalWorkspace(attempt.workspace)
    const existing = state.operations.find(operation => operation.id === input.operation_id)
    if (input.plan_id !== state.plan_id || input.attempt_id !== state.attempt_id || input.epoch !== state.epoch
      || !isDeepStrictEqual(input.candidate, existing?.candidate ?? state.yield?.candidate)) {
      throw new Error('Report must identify the originally reviewed current plan, attempt, epoch and yielded candidate.')
    }
    const candidate = input.candidate
    const observedAt = Date.parse(input.observed_at)
    if (observedAt < Date.parse(attempt.started_at) || observedAt > Date.now()) {
      throw new Error('Report observation must be from this attempt, not a prior or future observation.')
    }
    const criterion = state.plans.find(plan => plan.id === state.plan_id)?.content.acceptance.find(item => item.id === input.acceptance_id)
    if (!criterion || criterion.kind === 'command') throw new Error('Command acceptance must use the local runner, not a host report.')
    if ((criterion.kind === 'manual' && input.source !== 'user') || (criterion.kind === 'review' && input.source !== 'host_report')) {
      throw new Error('Manual acceptance requires an explicit user source; review requires a host reviewer.')
    }
    if (!existing) {
      const previous = state.checks.filter(check => check.plan_id === input.plan_id && check.attempt_id === input.attempt_id
        && check.epoch === input.epoch && check.acceptance_id === input.acceptance_id
        && isDeepStrictEqual(check.candidate, candidate)).at(-1)
      if (previous) {
        let previousTime = Date.parse(previous.recorded_at)
        try {
          verifyReportResult(input.directory, input.todo_id, input.execution_id, state, previous)
          const original = reportSchema.parse(artifacts.get(previous.receipt))
          if (original.version === 2 && original.observed_at) previousTime = Date.parse(original.observed_at)
        }
        catch {
          // Missing or old evidence uses its later import time as a conservative ordering bound.
        }
        if (observedAt < previousTime || (observedAt === previousTime && input.outcome === 'passed')) {
          throw new Error('A newer observation already exists; a delayed or tied pass cannot replace it.')
        }
      }
    }
    const request = {
      request_id: input.request_id, expected_revision: input.expected_revision,
      command: { action: 'begin_check', operation_id: input.operation_id, acceptance_id: input.acceptance_id, actor: input.actor, candidate },
    }
    transitionWorkflow(state, request)
    const savedIntent = artifacts.getReceipt(input.operation_id, 'report-intent')
    if (savedIntent && !isDeepStrictEqual(intentSchema.parse(savedIntent.value), intent)) {
      throw new Error('Conflicting report intent; preserve the original observation and request.')
    }
    if (existing && !savedIntent && !existing.receipt && !artifacts.getReceipt(input.operation_id)) {
      throw new Error('Report has no original intent or durable receipt; account for the previous host observation before recovery.')
    }
    const intentDigest = savedIntent?.digest
      ?? (!existing ? artifacts.putReceipt(input.operation_id, intent, 'report-intent') : undefined)
    store.applyWorkflow(input.todo_id, input.execution_id, request)
    return { candidate, intentDigest, recordedReceipt: existing?.status === 'completed' ? existing.receipt : null }
  })
  if (!artifacts.getReceipt(input.operation_id) && reservation.recordedReceipt) {
    // A terminal operation owns its original blob even if the receipt index was lost.
    const original = artifacts.get(reservation.recordedReceipt)
    reportSchema.parse(original)
    artifacts.putReceipt(input.operation_id, original)
  }
  else if (!artifacts.getReceipt(input.operation_id)) {
    if (!reservation.intentDigest) throw new Error('Cannot reconstruct an unrecorded report observation.')
    const { directory: _directory, request_id: _request, expected_revision: _revision, ...observed } = input
    const captured = captureCandidate(reservation.candidate.root)
    const { root, git_dir, common_dir, digest } = captured
    artifacts.putReceipt(input.operation_id, {
      ...observed, version: 2, intent: reservation.intentDigest,
      candidate: reservation.candidate, after: { root, git_dir, common_dir, digest }, manifest: artifacts.put(captured),
    })
  }
  const saved = artifacts.getReceipt(input.operation_id)
  if (!saved) throw new Error('Report has no durable receipt; reconcile the previous host observation.')
  const report = reportSchema.parse(saved.value)
  verifyIntent(artifacts, report)
  const state = lookup()
  if (report.todo_id !== input.todo_id || report.execution_id !== input.execution_id || report.operation_id !== input.operation_id
    || report.plan_id !== state.plan_id || report.attempt_id !== state.attempt_id || report.acceptance_id !== input.acceptance_id
    || report.epoch !== state.epoch
    || report.actor !== input.actor || report.locator !== input.locator || report.summary !== input.summary
    || (report.version === 2 && report.observed_at !== input.observed_at)
    || report.source !== input.source || report.outcome !== input.outcome || !isDeepStrictEqual(report.candidate, reservation.candidate)) {
    throw new Error('Conflicting report receipt or stale execution.')
  }
  verifyCandidateManifest(artifacts.get(report.manifest), report.after)
  return store.applyWorkflow(input.todo_id, input.execution_id, {
    request_id: `report-${createHash('sha256').update(input.operation_id).digest('hex')}`, expected_revision: state.revision,
    command: {
      action: 'complete_check', operation_id: input.operation_id, after: report.after,
      outcome: report.outcome, source: report.source, receipt: saved.digest, summary: report.summary, process_stopped: true,
    },
  })
}
