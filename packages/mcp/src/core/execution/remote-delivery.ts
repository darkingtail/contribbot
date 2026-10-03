import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { getGitCommit, getGitReference, getGitTree, getPull } from '../clients/github.js'
import { TodoStore } from '../storage/todo-store.js'
import { ExecutionArtifacts } from './artifacts.js'
import { captureCandidate, verifyCandidateManifest } from './candidate.js'
import type { Candidate } from './candidate.js'
import { observeCommitDelivery } from './commit-delivery.js'
import type { CommitObservation } from './commit-delivery.js'
import type { CandidateReference, WorkflowPlanInput, WorkflowState } from './contracts.js'
import { assertLocalWorkspace } from './processes.js'

type Delivery = NonNullable<WorkflowPlanInput['deliverables']>[number]
type RemoteTarget = Extract<Delivery['target'], { kind: 'remote_ref' | 'remote_pull' }>
type Endpoint = 'present' | 'missing' | 'not_observed'
export interface RemoteObservation {
  endpoint: Endpoint
  note: string
  remote: { source: 'github_read'; receipt: string; observed_at: string }
}
// A serialized object, including a caller-supplied receipt, cannot act as this handle.
export type RemoteDeliveryBatch = Readonly<{ readonly kind: 'remote-delivery-batch' }>
interface BatchData {
  directory: string; todoId: string; executionId: string; state: WorkflowState
  candidate: CandidateReference; observations: Map<string, RemoteObservation>
}
const batches = new WeakMap<RemoteDeliveryBatch, BatchData>()
const oid = z.string().regex(/^[a-f0-9]{40}$/)
const repoIdentity = z.object({ full_name: z.string().regex(/^[\w][\w.-]*\/[\w][\w.-]*$/) })
const pullSchema = z.object({
  number: z.number().int().positive(), state: z.enum(['open', 'closed']), merged: z.boolean(), draft: z.boolean(),
  merged_at: z.string().datetime({ offset: true }).nullable(), merge_commit_sha: oid.nullable(),
  base: z.object({ ref: z.string(), sha: oid, repo: repoIdentity }),
  head: z.object({ ref: z.string(), sha: oid, repo: repoIdentity.nullable() }),
})
const refSchema = z.object({ ref: z.string(), object: z.object({ type: z.literal('commit'), sha: oid }) })
const commitSchema = z.object({ sha: oid, tree: z.object({ sha: oid }) })
const treeSchema = z.object({
  sha: oid, truncated: z.literal(false),
  tree: z.array(z.object({
    path: z.string().min(1).max(4096), mode: z.string(), type: z.string(), sha: oid,
  })).max(100_000),
})
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const inside = (path: string, scope: string[]) =>
  scope.some(parent => parent === '.' || path === parent || path.startsWith(`${parent}/`))

export function hasRemoteDeliveries(state: WorkflowState): boolean {
  return Boolean(state.plans.find(plan => plan.id === state.plan_id)?.content.deliverables?.some(item =>
    item.target.kind === 'remote_ref' || item.target.kind === 'remote_pull'))
}

function currentState(directory: string, todoId: string, executionId: string): WorkflowState {
  const todo = new TodoStore(directory).resolveItemFromAll(todoId)
  const execution = todo?.executions.at(-1)
  if (execution?.id !== executionId || execution.closed_at !== null || !execution.workflow) {
    throw new Error('Remote observation requires the current open execution.')
  }
  return execution.workflow
}

async function observe(target: RemoteTarget, candidate: Candidate, local: CommitObservation) {
  if (target.repo.platform !== 'github' || target.repo.instance !== 'https://github.com') {
    return { endpoint: 'not_observed' as const, note: 'Remote delivery reads support GitHub.com repositories only.', local: local.commit, facts: null }
  }
  if (local.endpoint !== 'present') return {
    endpoint: local.endpoint, note: local.note, local: local.commit, facts: null,
  }
  const [owner, name] = target.repo.path.split('/') as [string, string]
  const readIdentity = async () => target.kind === 'remote_ref'
    ? refSchema.parse(await getGitReference(owner, name, target.ref))
    : pullSchema.parse(await getPull(owner, name, target.number))
  const first = await readIdentity()
  let sourceRepo = target.repo.path
  let sha: string
  let stateMatches = true
  if ('object' in first) {
    if (target.kind !== 'remote_ref' || first.ref !== target.ref) throw new Error('Remote ref identity mismatch.')
    sha = first.object.sha
  }
  else {
    if (target.kind !== 'remote_pull' || first.number !== target.number
      || !sameRepo(first.base.repo.full_name, target.repo.path) || first.base.ref !== target.base) {
      throw new Error('Remote PR identity mismatch.')
    }
    if (first.merged && (first.state !== 'closed' || !first.merged_at || !first.merge_commit_sha)) {
      throw new Error('Incomplete merge identity.')
    }
    stateMatches = first.merged || (target.endpoint === 'submitted' && first.state === 'open'
      && (target.allow_draft || !first.draft))
    if (first.merged) sha = first.merge_commit_sha!
    else {
      if (!first.head.repo) throw new Error('PR head repository unavailable.')
      sourceRepo = first.head.repo.full_name
      sha = first.head.sha
    }
  }
  if (!stateMatches) {
    const second = await readIdentity()
    if (!isDeepStrictEqual(first, second)) throw new Error('Remote identity changed during observation.')
    return { endpoint: 'missing' as const, note: 'Observed PR state does not meet the declared endpoint or draft policy.', local: local.commit, facts: { first, second } }
  }
  const [sourceOwner, sourceName] = sourceRepo.split('/') as [string, string]
  const remoteCommit = commitSchema.parse(await getGitCommit(sourceOwner, sourceName, sha))
  if (remoteCommit.sha !== sha) throw new Error('Remote commit identity mismatch.')
  const tree = treeSchema.parse(await getGitTree(sourceOwner, sourceName, remoteCommit.tree.sha))
  if (tree.sha !== remoteCommit.tree.sha) throw new Error('Remote tree identity mismatch.')
  const remoteFiles = new Map<string, { sha: string; mode: string }>()
  const seen = new Set<string>()
  for (const entry of tree.tree) {
    if (entry.path.includes('\0') || entry.path.includes('\\') || entry.path.startsWith('/')
      || entry.path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(entry.path)) {
      throw new Error('Invalid or duplicate remote tree path.')
    }
    seen.add(entry.path)
    if (entry.type === 'tree') {
      if (entry.mode !== '040000') throw new Error('Invalid directory mode.')
      continue
    }
    if (!inside(entry.path, target.scope)) continue
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      throw new Error('Unsupported scoped remote entry.')
    }
    remoteFiles.set(entry.path, { sha: entry.sha, mode: entry.mode })
  }
  const localFiles = candidate.files.filter(file => file.digest !== null && inside(file.path, target.scope))
  const contentMatches = remoteFiles.size === localFiles.length && localFiles.every(file => {
    const remote = remoteFiles.get(file.path)
    return remote?.sha === file.index_oid && remote.mode === file.index_mode
  })
  const second = await readIdentity()
  if (!isDeepStrictEqual(first, second)) throw new Error('Remote identity changed during observation.')
  return {
    endpoint: contentMatches ? 'present' as const : 'missing' as const,
    note: contentMatches
      ? 'Queried endpoint and scoped committed content match this candidate. This is an observation, not continuous monitoring or task acceptance.'
      : 'Queried scoped content differs from the committed candidate, including file additions, deletions or modes.',
    local: local.commit, facts: { first, second, source_repo: sourceRepo, commit: remoteCommit, tree },
  }
}

/** No caller-provided response is accepted here. Network reads happen outside Todo locks. */
export async function collectRemoteDeliveries(
  directory: string, todoId: string, executionId: string, state: WorkflowState, snapshot: Candidate,
): Promise<RemoteDeliveryBatch | undefined> {
  if (!hasRemoteDeliveries(state)) return undefined
  const attempt = state.attempts.find(attempt => attempt.id === state.attempt_id)
  const plan = state.plans.find(plan => plan.id === state.plan_id)
  if (!attempt || !plan?.confirmation) throw new Error('Confirmed plan and bound attempt required for remote delivery.')
  assertLocalWorkspace(attempt.workspace)
  const { digest, root, git_dir, common_dir } = snapshot
  const candidate = { digest, root, git_dir, common_dir }
  verifyCandidateManifest(snapshot, candidate)
  if (root !== attempt.workspace.root || git_dir !== attempt.workspace.git_dir || common_dir !== attempt.workspace.common_dir
    || !isDeepStrictEqual(currentState(directory, todoId, executionId), state)) {
    throw new Error('Remote observation does not match the current workspace or workflow.')
  }
  const artifacts = new ExecutionArtifacts(directory, executionId)
  const manifest = artifacts.put(snapshot)
  const queries = (plan.content.deliverables ?? []).filter(item =>
    item.target.kind === 'remote_ref' || item.target.kind === 'remote_pull')
  // Local drift is a verification failure, not an optional remote-access limitation.
  // Do this before launching readers so a local failure leaves no queries in flight.
  const local = queries.slice(0, 20).map(delivery =>
    observeCommitDelivery(snapshot, (delivery.target as RemoteTarget).scope))
  const observations = new Map<string, RemoteObservation>()
  // Bound each invocation; an unqueried required item remains a gap.
  let cursor = 0
  let failed = false
  let failure: unknown
  await Promise.all(Array.from({ length: Math.min(4, queries.length) }, async () => {
    try {
      while (!failed) {
        const index = cursor++
        const delivery = queries[index]
        if (!delivery) break
        let result: { endpoint: Endpoint; note: string; local?: unknown; facts?: unknown }
        try {
          result = index >= 20
            ? { endpoint: 'not_observed', note: 'Remote observation limit is 20 targets per verification.' }
            : await observe(delivery.target as RemoteTarget, snapshot, local[index]!)
        }
        catch {
          result = {
            endpoint: 'not_observed',
            note: 'Remote delivery could not be verified: unavailable access, incomplete/unsupported data, or changing remote identity. Raw service errors are not exposed.',
          }
        }
        if (failed) break
        const observed_at = new Date().toISOString()
        const receipt = artifacts.put({
          version: 1, source: 'github_read', query_id: randomUUID(), observed_at,
          todo_id: todoId, execution_id: executionId, plan_id: plan.id, plan_digest: plan.digest,
          attempt_id: attempt.id, epoch: state.epoch, revision: state.revision, candidate, manifest,
          delivery, ...result,
        })
        observations.set(delivery.id, {
          endpoint: result.endpoint, note: result.note, remote: { source: 'github_read', receipt, observed_at },
        })
      }
    }
    catch (error) {
      if (!failed) failure = error
      failed = true
    }
  }))
  if (failed) throw failure
  // Save historical facts even if they are no longer applicable, but never consume a drifted batch.
  if (!isDeepStrictEqual(currentState(directory, todoId, executionId), state)
    || captureCandidate(root).digest !== digest) {
    throw new Error('Workflow or candidate changed during remote observation; re-read context and verify again.')
  }
  const batch = Object.freeze({ kind: 'remote-delivery-batch' as const })
  batches.set(batch, { directory, todoId, executionId, state: structuredClone(state), candidate, observations })
  return batch
}

export function remoteDeliveryObservations(
  batch: RemoteDeliveryBatch | undefined, directory: string, todoId: string, executionId: string,
  state: WorkflowState, candidate: CandidateReference,
): Map<string, RemoteObservation> {
  if (!batch) return new Map()
  const data = batches.get(batch)
  if (!data || data.directory !== directory || data.todoId !== todoId || data.executionId !== executionId
    || !isDeepStrictEqual(data.state, state) || !isDeepStrictEqual(data.candidate, candidate)) {
    throw new Error('Remote delivery batch is not a fresh internal observation of this workflow/candidate.')
  }
  const artifacts = new ExecutionArtifacts(directory, executionId)
  for (const entry of data.observations.values()) artifacts.get(entry.remote.receipt)
  return structuredClone(data.observations)
}
