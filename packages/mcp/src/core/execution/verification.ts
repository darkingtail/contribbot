import { isDeepStrictEqual } from 'node:util'
import { verifyCommandResult } from './checks.js'
import type { CandidateReference, WorkflowState } from './contracts.js'
import { verifyReportResult } from './reports.js'
import { verifyDelegationResult } from './delegation.js'
import { ExecutionArtifacts } from './artifacts.js'
import { relocationRecordSchema } from './contracts.js'
import { verifyCandidateManifest } from './candidate.js'
import type { Candidate } from './candidate.js'
import { workflowReadiness } from './workflow.js'
import { verifyCheckReconciliation } from './reconciliation.js'
import { verifyClosureReconciliation } from './closure-reconciliation.js'
import { verifyControlHistory } from './control.js'
import { observeCommitDelivery } from './commit-delivery.js'
import { remoteDeliveryObservations } from './remote-delivery.js'
import type { RemoteDeliveryBatch } from './remote-delivery.js'

/** Stored pass flags only count while their candidate-bound evidence remains readable and valid. */
export function verifyReadiness(
  directory: string, todoId: string, executionId: string, state: WorkflowState, candidate: CandidateReference, stopping = false,
  snapshot?: Candidate,
  remoteBatch?: RemoteDeliveryBatch,
) {
  if (snapshot) verifyCandidateManifest(snapshot, candidate)
  const remoteObservations = remoteDeliveryObservations(remoteBatch, directory, todoId, executionId, state, candidate)
  const coverage = workflowReadiness(state, candidate, stopping)
  const gaps = coverage.missing.map(id => `acceptance:${id}`)
  const errors: string[] = []
  const receipts: string[] = []
  const environment: { acceptance_id: string; receipt_version: 1 | 2; notes: string[] }[] = []
  const delegationReceipts: string[] = []
  const relocationReceipts: string[] = []
  const reconciliationReceipts: string[] = []
  const controlReceipts: string[] = []
  try { controlReceipts.push(...verifyControlHistory(directory, todoId, executionId, state)) }
  catch (error) {
    gaps.push('control:history')
    errors.push(`Control history: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const closing of state.closings.filter(item => item.reconciliation)) {
    try { reconciliationReceipts.push(verifyClosureReconciliation(directory, todoId, executionId, state, closing)) }
    catch (error) {
      gaps.push(`closure-reconciliation:${closing.intent.id}`)
      errors.push(`Closure reconciliation ${closing.intent.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const operation of state.operations.filter(item => item.reconciliation)) {
    try { reconciliationReceipts.push(verifyCheckReconciliation(directory, todoId, executionId, state, operation)) }
    catch (error) {
      gaps.push(`reconciliation:${operation.id}`)
      errors.push(`Reconciliation ${operation.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const attempt of state.attempts.filter(item => item.relocation)) {
    try {
      const artifacts = new ExecutionArtifacts(directory, executionId)
      const link = attempt.relocation!
      const report = relocationRecordSchema.parse(artifacts.get(link.receipt))
      const previous = state.attempts.find(item => item.id === link.from_attempt)
      if (report.todo_id !== todoId || report.execution_id !== executionId || report.plan_id !== attempt.plan_id
        || report.from_attempt !== link.from_attempt || report.attempt_id !== attempt.id || report.owner !== attempt.owner
        || report.decision !== link.decision || report.plan_digest !== link.plan_digest
        || !isDeepStrictEqual(report.from_workspace, previous?.workspace) || !isDeepStrictEqual(report.workspace, attempt.workspace)) {
        throw new Error('Relocation evidence differs from the recorded identity or binding.')
      }
      const { root, git_dir, common_dir, baseline: digest } = attempt.workspace
      verifyCandidateManifest(artifacts.get(report.manifest), { root, git_dir, common_dir, digest })
      relocationReceipts.push(link.receipt)
    }
    catch (error) {
      gaps.push(`relocation:${attempt.id}`)
      errors.push(`Relocation ${attempt.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const operation of state.operations.filter(item => item.delegation && ['accepted', 'rejected'].includes(item.status))) {
    try { delegationReceipts.push(verifyDelegationResult(directory, todoId, executionId, state, operation)) }
    catch (error) {
      gaps.push(`delegation:${operation.id}`)
      errors.push(`Delegation ${operation.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const plan = state.plans.find(plan => plan.id === state.plan_id)
  const linked = new Set(plan?.content.deliverables?.flatMap(item => item.acceptance_ids) ?? [])
  const observations = new Map<string, {
    id: string; required: boolean; outcome: 'passed' | 'failed' | 'blocked' | 'stale' | 'missing' | 'invalid'
    source: string | null; receipt: string | null; note: string
  }>()
  for (const criterion of plan?.content.acceptance.filter(item => item.required || linked.has(item.id)) ?? []) {
    const check = state.checks.filter(check => check.plan_id === state.plan_id && check.attempt_id === state.attempt_id
      && check.epoch === state.epoch && check.acceptance_id === criterion.id && isDeepStrictEqual(check.candidate, candidate)).at(-1)
    const observation = {
      id: criterion.id, required: criterion.required, outcome: check?.outcome ?? 'missing' as const,
      source: check?.source ?? null, receipt: check?.receipt ?? null,
      note: check ? 'Recorded outcome for this plan, attempt, epoch and candidate.' : 'No current-candidate check recorded.',
    }
    observations.set(criterion.id, observation)
    if (!check || check.outcome !== 'passed') continue
    try {
      if (criterion.kind === 'command') {
        environment.push({ acceptance_id: criterion.id, ...verifyCommandResult(directory, todoId, executionId, state, check) })
      }
      else verifyReportResult(directory, todoId, executionId, state, check)
      receipts.push(check.receipt)
    }
    catch (error) {
      const note = `Artifact/receipt ${criterion.id}: ${error instanceof Error ? error.message : String(error)}`
      observations.set(criterion.id, { ...observation, outcome: 'invalid', note })
      if (criterion.required) {
        gaps.push(`artifact:${criterion.id}`)
        errors.push(note)
      }
    }
  }
  const files = new Map(snapshot?.files.map(file => [file.path, file]) ?? [])
  const deliveries = (plan?.content.deliverables ?? []).map(delivery => {
    const remoteTarget = delivery.target.kind === 'remote_ref' || delivery.target.kind === 'remote_pull'
    const remote = remoteTarget ? remoteObservations.get(delivery.id) : undefined
    const commit = snapshot && delivery.target.kind === 'commit'
      ? observeCommitDelivery(snapshot, delivery.target.scope) : null
    const file = delivery.target.kind === 'file' ? files.get(delivery.target.path) : undefined
    const endpoint = remote?.endpoint ?? (remoteTarget ? 'not_observed' as const : commit?.endpoint ?? (!snapshot ? 'not_observed' as const
      : delivery.target.kind === 'workspace' || file?.digest ? 'present' as const : 'missing' as const
    ))
    const note = remote?.note ?? (remoteTarget ? 'No fresh remote query for this verification. Reports and stored PR progress do not satisfy delivery.' : commit?.note ?? (endpoint === 'not_observed' ? 'No matching freshly captured manifest was supplied; this is not a file absence observation.'
      : endpoint === 'missing' ? 'No non-deleted file in this candidate. It may be absent, deleted or ignored; deliver the file within the captured scope or revise and reconfirm the plan.'
        : 'Present in the captured candidate; existence does not prove content acceptance.'))
    if (delivery.required && endpoint !== 'present') gaps.push(`delivery:${delivery.id}`)
    return {
      ...delivery, endpoint, note, candidate: snapshot ? candidate : null,
      ...(commit ? { commit: commit.commit } : {}),
      ...(remote ? { remote: remote.remote } : {}),
      file_digest: file?.digest ?? null,
      acceptance: delivery.acceptance_ids.map(id => observations.get(id)!),
    }
  })
  return {
    ...coverage, ready: coverage.ready && gaps.length === 0,
    gaps: [...new Set(gaps)].sort(), errors, check_receipts: receipts,
    delegation_receipts: delegationReceipts, relocation_receipts: relocationReceipts,
    reconciliation_receipts: reconciliationReceipts,
    control_receipts: controlReceipts,
    environment_limitations: environment,
    deliveries,
  }
}
