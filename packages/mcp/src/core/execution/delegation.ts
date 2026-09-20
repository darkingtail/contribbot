import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { currentTodoExecution, TodoStore } from '../storage/todo-store.js'
import { ExecutionArtifacts } from './artifacts.js'
import { captureCandidate, readCandidateFile, verifyCandidateManifest } from './candidate.js'
import type { Candidate, CandidateFile } from './candidate.js'
import { candidateReferenceSchema, hostTaskHandleSchema, processHandleSchema, scopePathSchema } from './contracts.js'
import type { WorkflowCommand, WorkflowOperation, WorkflowState } from './contracts.js'
import { assertLocalWorkspace, localMachine } from './processes.js'
import { assertDispatchAllowed } from './workflow.js'

const text = z.string().trim().min(1).max(16_384)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const identity = z.object({ directory: text, todo_id: text, execution_id: text, operation_id: text })
const mutation = identity.extend({ request_id: text, expected_revision: z.number().int().nonnegative(), actor: text })
const prepareSchema = mutation.extend({
  workspace: text, token: text, provider: text, tool: text, brief: text,
  step_id: text, scope: z.array(scopePathSchema).min(1), purpose: text,
}).strict()
const launchSchema = z.object({
  version: z.literal(1), todo_id: text, execution_id: text, operation_id: text,
  plan_id: text, attempt_id: text, epoch: z.number().int().nonnegative(), owner: text, token: text,
  provider: text, tool: text, brief: text, scope: z.array(scopePathSchema),
  machine: processHandleSchema.shape.machine,
  target: candidateReferenceSchema, target_manifest: digest,
  workspace: candidateReferenceSchema, workspace_manifest: digest,
  request: z.record(z.unknown()),
}).strict()
const contentSchema = z.object({
  digest, executable: z.boolean(), encoding: z.enum(['utf8', 'base64']).nullable(), data: z.string().nullable(),
}).strict()
const resultSchema = z.object({
  version: z.literal(1), launch: digest, host_observation: digest,
  candidate: candidateReferenceSchema, manifest: digest,
  changes: z.array(z.object({ path: scopePathSchema, before: contentSchema.nullable(), after: contentSchema.nullable() }).strict()),
  violations: z.array(text),
}).strict()
const observationSchema = mutation.extend({
  handle: hostTaskHandleSchema, tool: text, locator: text, observed_at: z.string().datetime(),
  status: z.enum(['running', 'terminal', 'unknown']), raw: z.record(z.unknown()),
  quiescence: z.object({
    statement: text, locator: text,
    descendants: z.array(z.object({
      handle: hostTaskHandleSchema, status: z.enum(['running', 'terminal', 'unknown']), locator: text,
    }).strict()),
    unaccounted: z.array(text),
  }).strict(),
}).strict()
const attachSchema = mutation.extend({ handle: hostTaskHandleSchema, locator: text, raw: z.record(z.unknown()) }).strict()
const reviewSchema = mutation.extend({ result: digest, locator: text, note: text }).strict()
const finishSchema = mutation.extend({ decision: z.enum(['accepted', 'rejected']), note: text }).strict()
export const delegationRequestSchemas = {
  'delegate-prepare': prepareSchema,
  'delegate-attach': attachSchema,
  'delegate-observe': observationSchema,
  'delegate-collect': mutation.strict(),
  'delegate-review': reviewSchema,
  'delegate-finish': finishSchema,
  'delegate-inspect': identity.strict(),
} as const
const attachmentRecord = attachSchema.omit({ expected_revision: true }).extend({ source: z.literal('host_report'), launch: digest }).strict()
const observationRecord = observationSchema.omit({ expected_revision: true }).extend({ source: z.literal('host_report'), launch: digest }).strict()
const reviewRecord = reviewSchema.omit({ expected_revision: true }).extend({
  source: z.literal('host_report'), launch: digest, candidate: candidateReferenceSchema, target: candidateReferenceSchema,
}).strict()
const integrationRecord = finishSchema.omit({ expected_revision: true }).extend({
  launch: digest, result: digest, review: digest.nullable(), candidate: candidateReferenceSchema, manifest: digest,
}).strict()

type Identity = z.infer<typeof identity>
const reference = ({ digest, root, git_dir, common_dir }: Candidate) => ({ digest, root, git_dir, common_dir })
const material = (file: Pick<CandidateFile, 'digest' | 'executable'> | undefined) => file?.digest ? { digest: file.digest, executable: file.executable } : null
const materials = (candidate: Candidate) => Object.fromEntries(candidate.files.filter(file => file.digest)
  .map(file => [file.path, material(file)]))
const index = (candidate: Candidate) => candidate.files.filter(file => file.index_mode)
  .map(file => [file.path, file.index_mode, file.index_oid])
const inScope = (path: string, scope: string[]) => scope.some(parent => parent === '.' || path === parent || path.startsWith(`${parent}/`))
const requestBody = ({ expected_revision: _revision, ...rest }: z.infer<typeof mutation>) => rest
const hostQuiescent = (observation: z.infer<typeof observationSchema> | z.infer<typeof observationRecord>) =>
  observation.status === 'terminal' && observation.quiescence.unaccounted.length === 0
    && observation.quiescence.descendants.every(item => item.status === 'terminal')

function workflowFor(store: TodoStore, input: Identity) {
  const todo = store.resolveItemById(input.todo_id)?.item
  const execution = todo && currentTodoExecution(todo)
  if (!execution?.workflow || execution.id !== input.execution_id) throw new Error('Open managed execution required for delegation.')
  const state = execution.workflow
  const attempt = state.attempts.find(item => item.id === state.attempt_id)
  if (!attempt || attempt.plan_id !== state.plan_id) throw new Error('Confirm a plan and bind its attempt before delegation.')
  return { state, attempt }
}

function outside(first: string, second: string) {
  const path = relative(first, second)
  return isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)
}

function sameCandidate(actual: Candidate, expected: z.infer<typeof candidateReferenceSchema>, label: string) {
  if (!isDeepStrictEqual(reference(actual), expected)) throw new Error(`${label} candidate changed; reconcile the exact reviewed content.`)
}

function bytes(candidate: Candidate, file: CandidateFile | undefined, disclose: boolean): z.infer<typeof contentSchema> | null {
  if (!file?.digest) return null
  if (!disclose) return { digest: file.digest, executable: file.executable, encoding: null, data: null }
  const content = readCandidateFile(candidate, file)
  const utf8 = content.toString('utf8')
  const encoding = Buffer.from(utf8).equals(content) ? 'utf8' : 'base64'
  return { digest: file.digest, executable: file.executable, encoding, data: content.toString(encoding) }
}

function checkContent(content: z.infer<typeof contentSchema> | null) {
  if (!content) return
  if (!content.encoding || content.data === null
    || createHash('sha256').update(Buffer.from(content.data, content.encoding)).digest('hex') !== content.digest) {
    throw new Error('Returned candidate content is missing or inconsistent.')
  }
}

function assertRecord(record: z.infer<typeof identity> & { actor: string; launch: string },
  input: Identity, launch: z.infer<typeof launchSchema>, launchId: string) {
  if (record.todo_id !== input.todo_id || record.execution_id !== input.execution_id
    || record.operation_id !== input.operation_id || record.actor !== launch.owner || record.launch !== launchId) {
    throw new Error('Delegation evidence does not support the original identity and launch.')
  }
}

function readObservation(artifacts: ExecutionArtifacts, input: Identity, launch: z.infer<typeof launchSchema>,
  delegation: NonNullable<WorkflowOperation['delegation']>, receipt: string) {
  if (!delegation.host || !delegation.attachment) throw new Error('Original host attachment is missing.')
  const attachment = attachmentRecord.parse(artifacts.get(delegation.attachment))
  assertRecord(attachment, input, launch, delegation.launch)
  if (attachment.handle.provider !== launch.provider || !isDeepStrictEqual(attachment.handle, delegation.host)) {
    throw new Error('Host attachment differs from the launch intent.')
  }
  const observation = observationRecord.parse(artifacts.get(receipt))
  assertRecord(observation, input, launch, delegation.launch)
  if (!isDeepStrictEqual(observation.handle, delegation.host) || !hostQuiescent(observation)) {
    throw new Error('Host task or scoped descendants lack terminal quiescence evidence.')
  }
  return observation
}

function verifyDelta(result: z.infer<typeof resultSchema>, sourceBase: Candidate, source: Candidate, scope: string[]) {
  const before = new Map(sourceBase.files.map(file => [file.path, file]))
  const after = new Map(source.files.map(file => [file.path, file]))
  const expected = [...new Set([...before.keys(), ...after.keys()])].sort()
    .filter(path => !isDeepStrictEqual(material(before.get(path)), material(after.get(path))))
  if (!isDeepStrictEqual(result.changes.map(change => change.path), expected)) throw new Error('Returned delta omits or duplicates candidate changes.')
  const violations = source.head !== sourceBase.head || !isDeepStrictEqual(index(source), index(sourceBase)) ? ['<git-metadata>'] : []
  for (const change of result.changes) {
    if (!isDeepStrictEqual(material(change.before ?? undefined), material(before.get(change.path)))
      || !isDeepStrictEqual(material(change.after ?? undefined), material(after.get(change.path)))) throw new Error('Delta does not match its source manifests.')
    if (inScope(change.path, scope)) { checkContent(change.before); checkContent(change.after) }
    else violations.push(change.path)
  }
  if (!isDeepStrictEqual(violations, result.violations)) throw new Error('Delta violations are inconsistent with its scope.')
}

function verifyIntegration(result: z.infer<typeof resultSchema>, targetBase: Candidate, target: Candidate, scope: string[]) {
  if (result.violations.length) throw new Error('Out-of-scope delta cannot be integrated.')
  if (target.head !== targetBase.head || !isDeepStrictEqual(index(target), index(targetBase))) throw new Error('Target Git metadata changed during integration.')
  const expected = materials(targetBase)
  for (const change of result.changes) {
    checkContent(change.before)
    checkContent(change.after)
    if (!inScope(change.path, scope) || !isDeepStrictEqual(expected[change.path] ?? null, material(change.before ?? undefined))) {
      throw new Error('Delta baseline or scope is inconsistent.')
    }
    if (change.after) expected[change.path] = { digest: change.after.digest, executable: change.after.executable }
    else delete expected[change.path]
  }
  if (!isDeepStrictEqual(materials(target), expected)) throw new Error('Integrated target does not match the exact reviewed delta.')
}

/** Local files supply candidate evidence; imported host status remains explicitly host-reported. */
export function runDelegation(action: string, raw: unknown): Record<string, unknown> {
  const input = identity.passthrough().parse(raw)
  return action === 'delegate-prepare'
    ? new TodoStore(input.directory).transaction(() => runDelegationLocked(action, raw))
    : runDelegationLocked(action, raw)
}

function runDelegationLocked(action: string, raw: unknown): Record<string, unknown> {
  const input = identity.passthrough().parse(raw)
  const store = new TodoStore(input.directory)
  const artifacts = new ExecutionArtifacts(input.directory, input.execution_id)
  const apply = (request: z.infer<typeof mutation>, command: WorkflowCommand) =>
    store.applyWorkflow(input.todo_id, input.execution_id, {
      request_id: request.request_id, expected_revision: request.expected_revision, command,
    })
  if (action === 'delegate-prepare') {
    const request = prepareSchema.parse(raw)
    const { state, attempt } = workflowFor(store, input)
    assertDispatchAllowed(state)
    assertLocalWorkspace(attempt.workspace)
    if (request.actor !== attempt.owner) throw new Error('Only the owner can prepare the original launch intent.')
    const existing = state.operations.find(item => item.id === request.operation_id)
    let launch: z.infer<typeof launchSchema>
    let launchId: string
    if (existing) {
      if (!existing.delegation) throw new Error('Operation id belongs to a different operation.')
      launchId = existing.delegation.launch
      launch = launchSchema.parse(artifacts.get(launchId))
      if (!isDeepStrictEqual(launch.request, requestBody(request))) throw new Error('Conflicting delegation launch request.')
    }
    else {
      const target = captureCandidate(attempt.workspace.root)
      if (target.root !== attempt.workspace.root || target.git_dir !== attempt.workspace.git_dir
        || target.common_dir !== attempt.workspace.common_dir) throw new Error('Target workspace identity differs from the bound attempt.')
      const workspace = captureCandidate(request.workspace)
      if (workspace.root === target.root || workspace.git_dir === target.git_dir || workspace.common_dir !== target.common_dir
        || !outside(target.root, workspace.root) || !outside(workspace.root, target.root)) {
        throw new Error('Delegation requires a separate, nonnested linked worktree.')
      }
      const storage = realpathSync(input.directory)
      if (!outside(target.root, storage) || !outside(workspace.root, storage)) throw new Error('Delegation storage must remain outside both workspaces.')
      if (workspace.head !== target.head || !isDeepStrictEqual(materials(workspace), materials(target))) {
        throw new Error('Isolated baseline must preserve the target HEAD and all existing material content, including user changes.')
      }
      launch = launchSchema.parse({
        version: 1, todo_id: input.todo_id, execution_id: input.execution_id, operation_id: input.operation_id,
        plan_id: state.plan_id!, attempt_id: attempt.id, epoch: state.epoch + 1, owner: request.actor, token: request.token,
        provider: request.provider, tool: request.tool,
        brief: `${request.brief}\n\nContribbot assignment token: ${request.token}`,
        scope: request.scope, machine: localMachine(),
        target: reference(target), target_manifest: artifacts.put(target),
        workspace: reference(workspace), workspace_manifest: artifacts.put(workspace), request: requestBody(request),
      })
      launchId = artifacts.put(launch)
    }
    const stateAfter = apply(request, {
      action: 'begin_delegation', operation_id: request.operation_id, actor: request.actor,
      step_id: request.step_id, scope: request.scope, purpose: request.purpose, token: request.token,
      launch: launchId, workspace: {
        root: launch.workspace.root, git_dir: launch.workspace.git_dir, common_dir: launch.workspace.common_dir,
        baseline: launch.workspace.digest, repo: attempt.workspace.repo, machine: launch.machine,
      },
    })
    return {
      schema_version: 1, workflow: stateAfter, launch: { artifact: launchId, token: launch.token, brief: launch.brief, provider: launch.provider, tool: launch.tool },
      next: 'Invoke the host once with this exact brief, then attach its actual handle. A missing handle never authorizes another launch.',
    }
  }
  const { state, attempt } = workflowFor(store, input)
  const operation = state.operations.find(item => item.id === input.operation_id)
  const delegation = operation?.delegation
  if (!operation || !delegation || operation.plan_id !== state.plan_id || operation.attempt_id !== attempt.id) throw new Error('Current candidate-bound delegation required.')
  const launch = launchSchema.parse(artifacts.get(delegation.launch))
  if (launch.todo_id !== input.todo_id || launch.execution_id !== input.execution_id || launch.operation_id !== operation.id
    || launch.plan_id !== operation.plan_id || launch.attempt_id !== operation.attempt_id || launch.epoch !== operation.epoch || launch.owner !== attempt.owner
    || launch.token !== delegation.token || !isDeepStrictEqual(launch.scope, operation.scope)
    || launch.workspace.root !== delegation.workspace.root || launch.workspace.git_dir !== delegation.workspace.git_dir
    || launch.workspace.common_dir !== delegation.workspace.common_dir || launch.workspace.digest !== delegation.workspace.baseline) {
    throw new Error('Launch intent does not match the original delegation.')
  }
  const targetBase = artifacts.get(launch.target_manifest) as Candidate
  const sourceBase = artifacts.get(launch.workspace_manifest) as Candidate
  verifyCandidateManifest(targetBase, launch.target)
  verifyCandidateManifest(sourceBase, launch.workspace)
  const assertLocal = () => {
    assertLocalWorkspace(attempt.workspace)
    if (!isDeepStrictEqual(launch.machine, localMachine())) throw new Error('Delegated workspaces belong to another machine.')
  }
  const assertStopped = () => {
    if (!delegation.host || !delegation.observation) throw new Error('Observe the original host task before collecting a candidate.')
    const observation = readObservation(artifacts, input, launch, delegation, delegation.observation.receipt)
    if (delegation.uncertain_at || delegation.observation.status !== 'terminal' || !delegation.observation.quiescent
      || (delegation.observation.observed_at && observation.observed_at !== delegation.observation.observed_at)) {
      throw new Error('Host observation is not terminal for the exact delegation.')
    }
    return observation
  }
  const readResult = (receipt: string) => {
    const result = resultSchema.parse(artifacts.get(receipt))
    if (result.launch !== delegation.launch || (delegation.result && (!isDeepStrictEqual(result.candidate, delegation.result.candidate)
      || receipt !== delegation.result.receipt))) throw new Error('Returned candidate belongs to another launch.')
    const source = artifacts.get(result.manifest) as Candidate
    verifyCandidateManifest(source, result.candidate)
    readObservation(artifacts, input, launch, delegation, result.host_observation)
    verifyDelta(result, sourceBase, source, operation.scope)
    if (artifacts.getReceipt(operation.id)?.digest !== receipt) throw new Error('Returned candidate receipt pointer is missing or inconsistent.')
    return result
  }
  const resultFor = () => {
    if (!delegation.result) throw new Error('Collect the real child candidate before reviewing or integrating.')
    return readResult(delegation.result.receipt)
  }
  if (action === 'delegate-inspect') {
    delegationRequestSchemas['delegate-inspect'].parse(raw)
    return {
      schema_version: 1, operation, launch, result: delegation.result ? resultFor() : null,
      limitations: ['Host observations are reports, not provider authentication.', 'Task completion is not code acceptance.', 'No host task is queried or launched by this read.'],
    }
  }
  if (action === 'delegate-attach') {
    const request = attachSchema.parse(raw)
    if (request.handle.provider !== launch.provider) throw new Error('Host provider differs from the launch intent.')
    const receipt = artifacts.put({ ...requestBody(request), source: 'host_report', launch: delegation.launch })
    return { schema_version: 1, workflow: apply(request, { action: 'attach_delegation', operation_id: operation.id, actor: request.actor, handle: request.handle, receipt }) }
  }
  if (action === 'delegate-observe') {
    const request = observationSchema.parse(raw)
    if (delegation.observation && delegation.observation.observed_at === null) {
      const previous = observationRecord.parse(artifacts.get(delegation.observation.receipt))
      if (Date.parse(request.observed_at) <= Date.parse(previous.observed_at)) throw new Error('Stale host observation cannot override newer evidence.')
    }
    const receipt = artifacts.put({ ...requestBody(request), source: 'host_report', launch: delegation.launch })
    const quiescent = hostQuiescent(request)
    return { schema_version: 1, source: 'host_report', workflow: apply(request, {
      action: 'observe_delegation', operation_id: operation.id, actor: request.actor,
      handle: request.handle, status: request.status, quiescent, receipt, observed_at: request.observed_at,
    }) }
  }
  assertLocal()
  assertStopped()
  const replay = state.requests.some(item => item.id === (raw as { request_id?: unknown }).request_id)
  if (replay && action === 'delegate-collect') {
    const request = delegationRequestSchemas['delegate-collect'].parse(raw)
    const result = resultFor()
    return { schema_version: 1, result: delegation.result!.receipt, changes: result.changes, violations: result.violations,
      workflow: apply(request, { action: 'return_delegation', operation_id: operation.id, actor: request.actor, candidate: result.candidate, receipt: delegation.result!.receipt }) }
  }
  if (replay && action === 'delegate-review' && delegation.review) {
    const request = reviewSchema.parse(raw)
    const saved = reviewRecord.parse(artifacts.get(delegation.review.receipt))
    const { source: _source, launch: _launch, candidate: _candidate, target, ...original } = saved
    if (!isDeepStrictEqual(original, requestBody(request))) throw new Error('Conflicting review request reuse.')
    resultFor()
    return { schema_version: 1, workflow: apply(request, { action: 'review_delegation', operation_id: operation.id, actor: request.actor,
      result: request.result, target, receipt: delegation.review.receipt }) }
  }
  if (replay && action === 'delegate-finish' && delegation.integration) {
    const request = finishSchema.parse(raw)
    const saved = integrationRecord.parse(artifacts.get(delegation.integration.receipt))
    const { launch: _launch, result: _result, review: _review, candidate, manifest: _manifest, ...original } = saved
    if (!isDeepStrictEqual(original, requestBody(request))) throw new Error('Conflicting integration request reuse.')
    verifyDelegationResult(input.directory, input.todo_id, input.execution_id, state, operation)
    return { schema_version: 1, candidate, workflow: apply(request, { action: 'finish_delegation', operation_id: operation.id,
      actor: request.actor, decision: request.decision, candidate, receipt: delegation.integration.receipt }) }
  }
  if (action === 'delegate-collect') {
    const request = delegationRequestSchemas['delegate-collect'].parse(raw)
    const target = captureCandidate(launch.target.root)
    sameCandidate(target, launch.target, 'Target baseline')
    const source = captureCandidate(launch.workspace.root)
    if (source.git_dir !== launch.workspace.git_dir || source.common_dir !== launch.workspace.common_dir) throw new Error('Child Git workspace identity changed.')
    const published = artifacts.getReceipt(operation.id)
    if (published) {
      const result = readResult(published.digest)
      sameCandidate(source, result.candidate, 'Child')
      const workflow = apply(request, {
        action: 'return_delegation', operation_id: operation.id, actor: request.actor, candidate: result.candidate, receipt: published.digest,
      })
      return { schema_version: 1, workflow, result: published.digest, changes: result.changes, violations: result.violations }
    }
    const before = new Map(sourceBase.files.map(file => [file.path, file]))
    const after = new Map(source.files.map(file => [file.path, file]))
    const changes: z.infer<typeof resultSchema>['changes'] = []
    const violations: string[] = []
    if (source.head !== sourceBase.head || !isDeepStrictEqual(index(source), index(sourceBase))) violations.push('<git-metadata>')
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      if (isDeepStrictEqual(material(before.get(path)), material(after.get(path)))) continue
      const allowed = inScope(path, operation.scope)
      if (!allowed) violations.push(path)
      changes.push({ path, before: bytes(target, target.files.find(file => file.path === path), allowed), after: bytes(source, after.get(path), allowed) })
    }
    sameCandidate(captureCandidate(source.root), reference(source), 'Child')
    sameCandidate(captureCandidate(target.root), launch.target, 'Target baseline')
    const result = resultSchema.parse({
      version: 1, launch: delegation.launch, host_observation: delegation.observation!.receipt,
      candidate: reference(source), manifest: artifacts.put(source), changes, violations,
    })
    const resultId = artifacts.putReceipt(operation.id, result)
    const workflow = apply(request, { action: 'return_delegation', operation_id: operation.id, actor: request.actor, candidate: result.candidate, receipt: resultId })
    return { schema_version: 1, workflow, result: resultId, changes, violations }
  }
  const result = resultFor()
  const source = captureCandidate(launch.workspace.root)
  sameCandidate(source, result.candidate, 'Child')
  const target = captureCandidate(launch.target.root)
  if (action === 'delegate-review') {
    const request = reviewSchema.parse(raw)
    if (result.violations.length) throw new Error(`Out-of-scope candidate: ${result.violations.join(', ')}`)
    if (request.result !== delegation.result!.receipt) throw new Error('Review requires the exact returned candidate digest.')
    sameCandidate(target, launch.target, 'Target baseline')
    for (const change of result.changes) { checkContent(change.before); checkContent(change.after) }
    const receipt = artifacts.put({ ...requestBody(request), source: 'host_report', launch: delegation.launch, candidate: result.candidate, target: reference(target) })
    return { schema_version: 1, workflow: apply(request, {
      action: 'review_delegation', operation_id: operation.id, actor: request.actor, result: request.result, target: reference(target), receipt,
    }), next: 'Owner integration is a sub-step under this same reservation. Apply only the reviewed delta, then verify with delegate-finish.' }
  }
  if (action === 'delegate-finish') {
    const request = finishSchema.parse(raw)
    if (request.decision === 'rejected') sameCandidate(target, launch.target, 'Target baseline')
    else {
      if (!delegation.review) throw new Error('Review and integrate the exact returned candidate first.')
      const review = reviewRecord.parse(artifacts.get(delegation.review.receipt))
      assertRecord(review, input, launch, delegation.launch)
      if (review.result !== delegation.result!.receipt || !isDeepStrictEqual(review.candidate, result.candidate)
        || !isDeepStrictEqual(review.target, launch.target) || review.actor !== attempt.owner) throw new Error('Stored review does not support this candidate.')
      verifyIntegration(result, targetBase, target, operation.scope)
    }
    // Recheck the child after capturing the target; acceptance only covers this bounded observation.
    sameCandidate(captureCandidate(launch.workspace.root), result.candidate, 'Child')
    const receipt = artifacts.put({ ...requestBody(request), launch: delegation.launch, result: delegation.result!.receipt,
      review: delegation.review?.receipt ?? null, candidate: reference(target), manifest: artifacts.put(target) })
    return { schema_version: 1, workflow: apply(request, {
      action: 'finish_delegation', operation_id: operation.id, actor: request.actor, decision: request.decision, candidate: reference(target), receipt,
    }), candidate: reference(target), next: 'Yield the integrated target and run its required checks afresh; child checks were not adopted.' }
  }
  throw new Error(`Unknown delegation action: ${action}.`)
}

/** Verify historical adoption evidence, not the present liveness of the child workspace. */
export function verifyDelegationResult(
  directory: string, todoId: string, executionId: string, state: WorkflowState, operation: WorkflowOperation,
): string {
  const delegation = operation.delegation
  const attempt = state.attempts.find(item => item.id === operation.attempt_id)
  if (!delegation?.integration || !delegation.result || !delegation.observation || !attempt
    || delegation.uncertain_at || delegation.observation.status !== 'terminal' || !delegation.observation.quiescent
    || !['accepted', 'rejected'].includes(operation.status)) throw new Error('Delegation is not settled with integration evidence.')
  const artifacts = new ExecutionArtifacts(directory, executionId)
  const input = { directory, todo_id: todoId, execution_id: executionId, operation_id: operation.id }
  const launch = launchSchema.parse(artifacts.get(delegation.launch))
  if (launch.todo_id !== todoId || launch.execution_id !== executionId || launch.operation_id !== operation.id
    || launch.plan_id !== operation.plan_id || launch.attempt_id !== attempt.id || launch.epoch !== operation.epoch
    || launch.owner !== attempt.owner || launch.token !== delegation.token || !isDeepStrictEqual(launch.scope, operation.scope)
    || !isDeepStrictEqual(launch.workspace, { digest: delegation.workspace.baseline, root: delegation.workspace.root,
      git_dir: delegation.workspace.git_dir, common_dir: delegation.workspace.common_dir })
    || launch.target.root !== attempt.workspace.root || launch.target.git_dir !== attempt.workspace.git_dir
    || launch.target.common_dir !== attempt.workspace.common_dir) throw new Error('Delegation launch identity mismatch.')
  const targetBase = artifacts.get(launch.target_manifest) as Candidate
  const sourceBase = artifacts.get(launch.workspace_manifest) as Candidate
  verifyCandidateManifest(targetBase, launch.target)
  verifyCandidateManifest(sourceBase, launch.workspace)
  if (sourceBase.head !== targetBase.head || !isDeepStrictEqual(materials(sourceBase), materials(targetBase))) throw new Error('Delegation baselines differ.')
  const observation = readObservation(artifacts, input, launch, delegation, delegation.observation.receipt)
  if (delegation.observation.observed_at && observation.observed_at !== delegation.observation.observed_at) throw new Error('Host observation ordering evidence mismatch.')
  const result = resultSchema.parse(artifacts.get(delegation.result.receipt))
  if (result.launch !== delegation.launch || !isDeepStrictEqual(result.candidate, delegation.result.candidate)
    || artifacts.getReceipt(operation.id)?.digest !== delegation.result.receipt) throw new Error('Returned candidate identity or pointer mismatch.')
  readObservation(artifacts, input, launch, delegation, result.host_observation)
  const source = artifacts.get(result.manifest) as Candidate
  verifyCandidateManifest(source, result.candidate)
  verifyDelta(result, sourceBase, source, operation.scope)
  const integrated = integrationRecord.parse(artifacts.get(delegation.integration.receipt))
  assertRecord(integrated, input, launch, delegation.launch)
  if (integrated.result !== delegation.result.receipt || integrated.decision !== operation.status
    || integrated.review !== (delegation.review?.receipt ?? null)
    || !isDeepStrictEqual(integrated.candidate, delegation.integration.candidate)) throw new Error('Integration evidence identity mismatch.')
  const target = artifacts.get(integrated.manifest) as Candidate
  verifyCandidateManifest(target, integrated.candidate)
  if (integrated.decision === 'accepted') {
    if (!delegation.review) throw new Error('Accepted delegation lacks owner review.')
    const review = reviewRecord.parse(artifacts.get(delegation.review.receipt))
    assertRecord(review, input, launch, delegation.launch)
    if (review.result !== delegation.result.receipt || !isDeepStrictEqual(review.candidate, result.candidate)
      || !isDeepStrictEqual(review.target, launch.target) || !isDeepStrictEqual(review.target, delegation.review.target)) {
      throw new Error('Review evidence does not support the adopted candidate.')
    }
    verifyIntegration(result, targetBase, target, operation.scope)
  }
  else sameCandidate(target, launch.target, 'Rejected target baseline')
  return delegation.integration.receipt
}
