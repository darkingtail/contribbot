import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { RepoConfig } from '../storage/repo-config.js'
import { currentTodoExecution, TodoStore } from '../storage/todo-store.js'
import { projectDirectory, repositoryRefSchema, sameRepository } from '../utils/repository-ref.js'
import { ExecutionArtifacts } from './artifacts.js'
import { captureCandidate } from './candidate.js'
import { observeCheck, recoverCheck, runCheck } from './checks.js'
import { closeManagedWithReadback } from './closure.js'
import { relocationRecordSchema, workflowCommandSchema } from './contracts.js'
import { recordCheckReport } from './reports.js'
import { runDelegation } from './delegation.js'
import { activeControl, assertDispatchAllowed, completionCoverage, controlIsPaused, deliveryRequirements, unresolvedOperations } from './workflow.js'
import { verifyReadiness } from './verification.js'
import { assertLocalWorkspace, localMachine } from './processes.js'
import { reconcileCheck } from './reconciliation.js'
import { issueClosureAccounting, reconcileClosure } from './closure-reconciliation.js'
import { cancelPendingClose, settleControl } from './control.js'
import { RemoteEffects } from '../storage/remote-effects.js'
import type { WorkflowCommand, WorkflowState } from './contracts.js'
import { collectRemoteDeliveries } from './remote-delivery.js'

const text = z.string().trim().min(1)
export const localIdentitySchema = z.object({
  repo: repositoryRefSchema,
  data_root: z.string().refine(isAbsolute, 'data_root must be absolute.').optional(),
  todo_id: text, execution_id: text.optional(),
})
const mutationSchema = localIdentitySchema.extend({
  execution_id: text, request_id: text, expected_revision: z.number().int().nonnegative(),
})
export const hostActions = [
  'propose_plan', 'confirm_plan', 'begin_operation', 'return_operation', 'adopt_operation', 'mark_unknown', 'request_control',
] as const

const hostOptions = workflowCommandSchema.options.filter(option => (hostActions as readonly string[]).includes(option.shape.action.value))
export const hostCommandSchema = z.discriminatedUnion('action', [hostOptions[0]!, ...hostOptions.slice(1)])
export const hostRequestSchema = z.object({
  todo_id: text, execution_id: text, request_id: text, expected_revision: z.number().int().nonnegative(),
  command: hostCommandSchema,
}).strict()
const bindingInput = mutationSchema.extend({ workspace: text, attempt_id: text, owner: text })
export const workspaceRequestSchemas = {
  bind: bindingInput.extend({ action: z.literal('bind') }).strict(),
  relocate: bindingInput.extend({
    action: z.literal('relocate'), from_attempt: text, decision: text, plan_digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  yield: mutationSchema.extend({
    action: z.literal('yield'), actor: text, observed_operations: z.array(text), note: text,
  }).strict(),
  inspect: localIdentitySchema.extend({ action: z.literal('inspect'), execution_id: text }).strict(),
} as const

export function applyHostCommand(directory: string, raw: unknown): WorkflowState {
  const input = hostRequestSchema.extend({ command: z.record(z.unknown()) }).parse(raw)
  if (!(hostActions as readonly unknown[]).includes(input.command.action)) {
    throw new Error('Internal/local action is not available through generic host commands.')
  }
  const store = new TodoStore(directory)
  return store.transaction(() => {
    if (input.command.action === 'begin_operation') {
      const state = executionContext(directory, input.todo_id, input.execution_id).execution?.workflow
      if (state) assertDispatchAllowed(state)
    }
    return store.applyWorkflow(input.todo_id, input.execution_id, {
      request_id: input.request_id, expected_revision: input.expected_revision, command: hostCommandSchema.parse(input.command),
    })
  })
}

export function executionContext(directory: string, todoId: string, executionId?: string) {
  const store = new TodoStore(directory)
  const todo = store.resolveItemFromAll(todoId)
  if (!todo || todo.id !== todoId) throw new Error('Exact stable Todo id required. Use todo_list / todo_activate first.')
  const execution = executionId ? todo.executions.find(item => item.id === executionId) : currentTodoExecution(todo) ?? todo.executions.at(-1)
  if (executionId && !execution) throw new Error('Execution does not belong to the requested Todo.')
  const workflow = execution?.workflow
  const coverage = completionCoverage(workflow)
  const documentProjection = store.recordProjection(todo)
  const recovery: string[] = []
  const remoteEffects = new RemoteEffects(directory, todoId).list()
  for (const effect of remoteEffects.filter(effect => effect.state !== 'linked')) {
    recovery.push(`Unresolved ${effect.request.kind} request ${effect.id} (${effect.state}). Recover the exact original request/receipt; absence from a remote listing is not proof of no effect or permission to redispatch.`)
  }
  if (documentProjection.status === 'outdated' || documentProjection.status === 'blocked') {
    recovery.push(`Document projection ${documentProjection.status}: ${documentProjection.note}`)
  }
  if (todo.pending_transition) recovery.push(`Reconcile pending ${todo.pending_transition} before other work.`)
  if (workflow?.closing_id) recovery.push(`Reconcile closure ${workflow.closing_id}; do not start another writer.`)
  const pendingClose = workflow?.closings.find(closing => closing.intent.id === workflow.closing_id)
  const issueAccounting = pendingClose?.intent.target.kind === 'issue' && execution
    ? issueClosureAccounting(directory, todoId, execution.id, pendingClose) : null
  if (pendingClose?.state === 'prepared' && pendingClose.intent.target.kind === 'issue') {
    recovery.push(workflow && activeControl(workflow)?.kind === 'cancel'
      ? 'Account for the original requests and writers, then use reconcile-close with the exact active control_id and cancellation decision. Keep unknown effects pending. Reconciliation only withdraws the original completion intent; yield again and use a matching local stopped close to finish cancelled, without changing GitHub or archiving.'
      : 'If post-close changes must be retained, account for the original public request and writers, then use local reconcile-close after an explicit user decision to continue locally. It does not verify or complete the task.')
  }
  if (workflow) {
    const control = activeControl(workflow)
    if (control) {
      recovery.push(controlIsPaused(workflow)
        ? `Paused by ${control.id}. Resume explicitly through the local continue action; todo_resume only repairs the document.`
        : `${control.kind} requested (${control.id}); not yet safely settled. Stop new assignments and recover/account for existing operations.`)
      if (workflow.closing_id) {
        recovery.push(pendingClose?.intent.target.kind === 'local'
          ? 'Withdraw the reversible local reservation using cancel-close with the exact current control_id and closure_id, then settle the stop. This does not cancel the Todo.'
          : 'Stop is blocked by the original closure. Preserve remote facts and receipts; do not finalize it over the newer stop intent or infer that missing receipts mean no effect.')
      }
    }
    if (!workflow.closure && !workflow.closing_id) {
      if (coverage.scope === 'stage') recovery.push('This plan covers a stage only. Retain its checks and remaining goals; do not complete the whole Todo.')
      if (coverage.scope === 'legacy' || (coverage.scope === 'task' && coverage.remaining_scope === null)) {
        recovery.push('Legacy coverage is incomplete or undeclared. Keep history unchanged; confirm a new plan with explicit coverage before beginning whole-Todo completion.')
      }
    }
    for (const operation of unresolvedOperations(workflow)) {
      recovery.push(operation.kind === 'check'
        ? `${operation.id}: observe the original executor/processes and recover existing terminal results. Without a recoverable result, use local reconcile only after actual descendant/content accounting and an explicit user decision; never replay an uncertain operation.`
        : `${operation.id}: query the original host task; account for its result and liveness before another assignment.`)
    }
    if (!workflow.attempt_id && !workflow.closure && !control) {
      const confirmed = workflow.plans.find(plan => plan.id === workflow.plan_id)?.confirmation
      recovery.push(confirmed ? 'Bind the local repository using the confirmed plan.'
        : 'Confirm the current plan and bind the local repository.')
    }
  }
  else recovery.push(execution
    ? 'Propose and confirm a versioned plan to enter the managed workflow.'
    : 'Activate this Todo before proposing a versioned plan.')
  return {
    schema_version: 1 as const, todo, execution: execution ?? null, recovery,
    remote_effects: remoteEffects, issue_close_accounting: issueAccounting,
    workflow_revision: execution ? workflow?.revision ?? 0 : null,
    workspace_observation: 'not_observed' as const,
    readiness: null,
    completion_coverage: coverage,
    delivery_requirements: deliveryRequirements(workflow),
    control: workflow ? { request: activeControl(workflow) ?? null,
      settled: controlIsPaused(workflow), dispatch_allowed: !activeControl(workflow) && !workflow.closing_id && !workflow.closure } : null,
    document_projection: documentProjection,
    limitations: ['Stored state is not current workspace verification.', 'Actor and user locators are audit records, not authentication.'],
  }
}

function storageFor(input: z.infer<typeof localIdentitySchema>): string {
  const directory = projectDirectory(input.repo, input.data_root)
  const config = new RepoConfig(directory).load()
  if (!config) throw new Error('Initialize the repository config before accessing a local execution.')
  if (!sameRepository(config.repository, input.repo)) {
    throw new Error('Repository config identity does not match the requested local execution.')
  }
  return directory
}

function readWorkflow(directory: string, todoId: string, executionId: string): WorkflowState {
  const context = executionContext(directory, todoId, executionId)
  if (!context.execution?.workflow || context.execution.closed_at !== null) throw new Error('Open managed execution required.')
  return context.execution.workflow
}

function canonicalOrigin(workspace: string): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)))
  const remote = execFileSync(process.platform === 'win32' ? 'git.exe' : 'git', ['config', '--get', 'remote.origin.url'], {
    cwd: workspace, env, windowsHide: true, timeout: 10_000, maxBuffer: 16_384, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote)
  if (!match) throw new Error('Workspace origin must identify an unambiguous GitHub repository without embedded credentials.')
  return `${match[1]}/${match[2]}`
}

export async function runLocalCommand(raw: unknown): Promise<Record<string, unknown>> {
  const input = localIdentitySchema.extend({ action: text }).passthrough().parse(raw)
  const directory = storageFor(input)
  if (input.action === 'resume') executionContext(directory, input.todo_id, input.execution_id)
  const repaired = input.action === 'resume' ? new TodoStore(directory).refreshRecord(input.todo_id) : null
  const result = await executeLocalCommand(raw)
  const todo = new TodoStore(directory).resolveItemFromAll(input.todo_id)
  return { ...result, ...(todo ? { document_projection: repaired ?? new TodoStore(directory).recordProjection(todo) } : {}) }
}

async function executeLocalCommand(raw: unknown): Promise<Record<string, unknown>> {
  const envelope = localIdentitySchema.extend({ action: text }).passthrough().parse(raw)
  const directory = storageFor(envelope)
  const { action, repo: _repo, data_root: _dataRoot, ...payload } = envelope
  if (action.startsWith('delegate-')) return runDelegation(action, { ...payload, directory })
  if (action === 'context' || action === 'resume') return executionContext(directory, envelope.todo_id, envelope.execution_id)
  if (action === 'apply') return { schema_version: 1, workflow: applyHostCommand(directory, payload) }
  if (action === 'settle-pause' || action === 'continue') {
    return { schema_version: 1, workflow: settleControl(action === 'settle-pause' ? 'settle_pause' : 'resume_control', { ...payload, directory }) }
  }
  if (action === 'cancel-close') return { schema_version: 1, workflow: cancelPendingClose({ ...payload, directory }) }
  if (action === 'close') {
    const todo = await closeManagedWithReadback({ ...payload, directory })
    return { schema_version: 1, todo, archived: 'archived' in todo }
  }
  if (action === 'check') return { schema_version: 1, ...await runCheck({ ...payload, directory }) }
  if (action === 'observe') return observeCheck({ ...payload, directory })
  if (action === 'recover') return { schema_version: 1, ...recoverCheck({ ...payload, directory }) }
  if (action === 'reconcile') return reconcileCheck({ ...payload, directory })
  if (action === 'reconcile-close') return reconcileClosure({ ...payload, directory, repo: envelope.repo })
  if (action === 'report') return { schema_version: 1, workflow: recordCheckReport({ ...payload, directory }) }
  if (action === 'bind' || action === 'relocate') {
    const input = action === 'bind'
      ? workspaceRequestSchemas.bind.parse(raw)
      : workspaceRequestSchemas.relocate.parse(raw)
    const state = readWorkflow(directory, input.todo_id, input.execution_id)
    const existing = state.attempts.find(attempt => attempt.id === input.attempt_id)
    const artifacts = new ExecutionArtifacts(directory, input.execution_id)
    const { expected_revision: _revision, ...request } = input
    if (existing) {
      assertLocalWorkspace(existing.workspace)
      const root = realpathSync(input.workspace)
      if ((process.platform === 'win32' ? root.toLowerCase() : root) !== existing.workspace.root
        || !sameRepository(input.repo, existing.workspace.repo)) throw new Error('Attempt id reuse with a different workspace/repository.')
      let command: WorkflowCommand
      if (input.action === 'relocate') {
        if (!existing.relocation) throw new Error('Attempt was not created by relocation.')
        const saved = relocationRecordSchema.parse(artifacts.get(existing.relocation.receipt))
        if (!isDeepStrictEqual(saved.request, request)) throw new Error('Conflicting relocation request reuse.')
        command = { action: 'relocate_attempt', attempt_id: existing.id, owner: input.owner, workspace: existing.workspace, relocation: existing.relocation }
      }
      else command = { action: 'start_attempt', attempt_id: input.attempt_id, owner: input.owner, workspace: existing.workspace }
      const workflow = new TodoStore(directory).applyWorkflow(input.todo_id, input.execution_id, {
        request_id: input.request_id, expected_revision: input.expected_revision,
        command,
      })
      return { schema_version: 1, workflow }
    }
    if (input.action === 'relocate' && (unresolvedOperations(state).length || state.closing_id)) {
      throw new Error('Unresolved operations must be reconciled before relocation.')
    }
    const config = new RepoConfig(directory).load()
    if (!config) throw new Error('Initialize the canonical repository config before binding a workspace.')
    const snapshot = captureCandidate(input.workspace)
    const origin = canonicalOrigin(snapshot.root)
    if (input.repo.platform !== 'github' || input.repo.instance !== 'https://github.com'
      || !sameRepository(config.repository, input.repo)
      || origin.toLowerCase() !== input.repo.path.toLowerCase()) {
      throw new Error(`Workspace origin ${origin} does not match managed repository ${input.repo.instance}/${input.repo.path}.`)
    }
    const storage = realpathSync(directory)
    const rel = relative(snapshot.root, storage)
    if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) throw new Error('Task storage must be outside its workspace.')
    const manifest = artifacts.put(snapshot)
    const binding = {
      repo: input.repo, root: snapshot.root, git_dir: snapshot.git_dir, common_dir: snapshot.common_dir,
      baseline: snapshot.digest, machine: localMachine(),
    }
    let command: WorkflowCommand = { action: 'start_attempt', attempt_id: input.attempt_id, owner: input.owner, workspace: binding }
    if (input.action === 'relocate') {
      const previous = state.attempts.find(attempt => attempt.id === state.attempt_id)
      if (!previous || previous.id !== input.from_attempt || previous.owner !== input.owner
        || state.plans.find(plan => plan.id === state.plan_id)?.digest !== input.plan_digest) {
        throw new Error('Relocation must identify the current attempt, original owner and exact confirmed plan.')
      }
      const record = relocationRecordSchema.parse({
        version: 1, todo_id: input.todo_id, execution_id: input.execution_id, plan_id: state.plan_id,
        from_attempt: input.from_attempt, attempt_id: input.attempt_id, owner: input.owner,
        decision: input.decision, plan_digest: input.plan_digest, from_workspace: previous.workspace,
        workspace: binding, manifest, request,
      })
      command = { action: 'relocate_attempt', attempt_id: input.attempt_id, owner: input.owner, workspace: binding,
        relocation: { from_attempt: input.from_attempt, decision: input.decision, plan_digest: input.plan_digest, receipt: artifacts.put(record) } }
    }
    const workflow = new TodoStore(directory).applyWorkflow(input.todo_id, input.execution_id, {
      request_id: input.request_id, expected_revision: input.expected_revision,
      command,
    })
    return { schema_version: 1, workflow }
  }
  if (action === 'yield' || action === 'inspect') {
    const input = action === 'yield'
      ? workspaceRequestSchemas.yield.parse(raw)
      : workspaceRequestSchemas.inspect.parse(raw)
    const state = readWorkflow(directory, input.todo_id, input.execution_id)
    const attempt = state.attempts.find(attempt => attempt.id === state.attempt_id)
    if (!attempt) throw new Error('Bind an attempt before inspecting/yielding.')
    assertLocalWorkspace(attempt.workspace)
    if (!existsSync(attempt.workspace.root)) throw new Error('Bound workspace is unavailable on this machine.')
    const snapshot = captureCandidate(attempt.workspace.root)
    const { digest, root, git_dir, common_dir } = snapshot
    const candidate = { digest, root, git_dir, common_dir }
    if (input.action === 'inspect') {
      const remote = await collectRemoteDeliveries(directory, input.todo_id, input.execution_id, state, snapshot)
      const readiness = verifyReadiness(directory, input.todo_id, input.execution_id, state, candidate, false, snapshot, remote)
      if (readWorkflow(directory, input.todo_id, input.execution_id).revision !== state.revision) {
        throw new Error('Workflow changed during inspection; inspect the current state again.')
      }
      return { schema_version: 1, candidate, readiness, completion_coverage: completionCoverage(state), workspace_observation: 'captured' }
    }
    const artifact = new ExecutionArtifacts(directory, input.execution_id).put(snapshot)
    const workflow = new TodoStore(directory).applyWorkflow(input.todo_id, input.execution_id, {
      request_id: input.request_id, expected_revision: input.expected_revision,
      command: { action: 'yield', actor: input.actor, observed_operations: input.observed_operations, note: input.note, candidate },
    })
    return { schema_version: 1, candidate, artifact, workflow }
  }
  throw new Error(`Unknown local action: ${action}.`)
}
