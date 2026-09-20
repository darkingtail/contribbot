import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { currentTodoExecution, TodoStore } from '../storage/todo-store.js'
import { ExecutionArtifacts } from './artifacts.js'
import { captureCandidate, verifyCandidateManifest } from './candidate.js'
import type { Candidate } from './candidate.js'
import { candidateReferenceSchema, checkCommandSchema, processHandleSchema } from './contracts.js'
import type { CandidateReference, ProcessHandle, WorkflowRequest, WorkflowState } from './contracts.js'
import { assertLocalWorkspace, describeProcess, describeProcessAsync, observeProcess } from './processes.js'
import { launchCheckSupervisor } from './supervisor.js'
import { activeControl, assertDispatchAllowed, transitionWorkflow } from './workflow.js'
import {
  assertDependencyInputs, captureRunnerEnvironment, checkEnvironmentSchema,
  environmentLimitations, observeDependencyInputs, verifyDependencyObservation,
} from './environment.js'

export const runRequestSchema = z.object({
  directory: z.string().min(1),
  todo_id: z.string().min(1),
  execution_id: z.string().min(1),
  request_id: z.string().min(1),
  operation_id: z.string().min(1),
  acceptance_id: z.string().min(1),
  actor: z.string().min(1),
  expected_revision: z.number().int().nonnegative(),
}).strict()
export const observeRequestSchema = runRequestSchema.pick({ directory: true, todo_id: true, execution_id: true, operation_id: true })
export type RunCheckRequest = z.infer<typeof runRequestSchema>

const processResultSchema = z.object({
  exit_code: z.number().int().nullable(), signal: z.string().nullable(),
  timed_out: z.boolean(), output_limited: z.boolean(), error: z.string().nullable(),
  stdout: z.string(), stderr: z.string(),
  process_stopped: z.boolean(), duration_ms: z.number().nonnegative(),
}).strict()

const receiptBodySchema = z.object({
  todo_id: z.string(), execution_id: z.string(), operation_id: z.string(),
  plan_id: z.string(), attempt_id: z.string(), acceptance_id: z.string(),
  command: checkCommandSchema,
  expected: candidateReferenceSchema,
  before: candidateReferenceSchema.nullable(), after: candidateReferenceSchema.nullable(),
  before_artifact: z.string().nullable(), after_artifact: z.string().nullable(),
  process: processResultSchema.nullable(), error: z.string().nullable(),
  started_at: z.string().datetime(), ended_at: z.string().datetime(),
}).strict()
const receiptSchema = z.discriminatedUnion('version', [
  receiptBodySchema.extend({
    version: z.literal(1), environment: z.object({ platform: z.string(), node: z.string() }).strict(),
  }),
  receiptBodySchema.extend({ version: z.literal(2), environment: checkEnvironmentSchema }),
])
export type CheckReceipt = z.infer<typeof receiptSchema>
const checkProcessSchema = z.object({
  version: z.literal(1), todo_id: z.string(), execution_id: z.string(), operation_id: z.string(),
  plan_id: z.string(), attempt_id: z.string(),
  runner: processHandleSchema, child: processHandleSchema,
  supervisor: processHandleSchema.nullable().default(null),
}).strict()
const supervisorSchema = z.object({
  version: z.literal(1), todo_id: z.string(), execution_id: z.string(), operation_id: z.string(),
  request_id: z.string(), plan_id: z.string(), attempt_id: z.string(),
  runner: processHandleSchema, supervisor: processHandleSchema,
}).strict()
export interface CheckRunResult {
  outcome: 'passed' | 'failed' | 'blocked' | 'stale'
  receipt: CheckReceipt
  artifact: string
  limitations: string[]
}

const reference = (candidate: Candidate): CandidateReference => ({
  digest: candidate.digest, root: candidate.root, git_dir: candidate.git_dir, common_dir: candidate.common_dir,
})

function redact(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]')
}

function stateFor(store: TodoStore, input: RunCheckRequest) {
  const todo = store.resolveItemById(input.todo_id)?.item
  const execution = todo && currentTodoExecution(todo)
  if (!execution || execution.id !== input.execution_id || !execution.workflow) throw new Error('Managed Todo execution changed or is missing.')
  return execution.workflow
}

function checkContext(store: TodoStore, input: RunCheckRequest) {
  const state = stateFor(store, input)
  const plan = state.plans.find(plan => plan.id === state.plan_id)
  const attempt = state.attempts.find(attempt => attempt.id === state.attempt_id)
  if (!plan?.confirmation || !attempt || attempt.plan_id !== plan.id) throw new Error('Confirm a plan and start its attempt before checking.')
  const criterion = plan.content.acceptance.find(item => item.id === input.acceptance_id)
  if (!criterion || criterion.kind !== 'command' || !criterion.command) throw new Error('Local runner only executes confirmed command acceptance.')
  return { state, plan, attempt, command: criterion.command }
}

function outsideWorkspace(directory: string, root: string): void {
  const path = relative(realpathSync(root), realpathSync(directory))
  if (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)) {
    throw new Error('Execution storage must be outside the candidate workspace.')
  }
}

async function execute(
  command: z.infer<typeof checkCommandSchema>, cwd: string,
  onSpawn: (pid: number, lifetime: { spawned_at: number; alive: () => boolean }) => Promise<void>,
): Promise<z.infer<typeof processResultSchema>> {
  return new Promise((resolve) => {
    const started = performance.now()
    let finished = false
    let timedOut = false
    let outputLimited = false
    let trackingFailed = false
    let error: string | null = null
    let total = 0
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let tracking: Promise<void> = Promise.resolve()
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    const child = spawn(command.executable, command.argv, {
      cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(settleTimer)
      child.stdout.destroy()
      child.stderr.destroy()
      const duration = Math.max(0, performance.now() - started)
      // Metadata publication can finish after the command, but must precede its result receipt.
      void tracking.then(() => {
        resolve({
          exit_code: exitCode, signal, timed_out: timedOut, output_limited: outputLimited, error,
          stdout: redact(Buffer.concat(stdout).toString('utf8')), stderr: redact(Buffer.concat(stderr).toString('utf8')),
          // Killing the parent/tree is best effort; an interrupted command may have detached descendants.
          process_stopped: !timedOut && !outputLimited && !trackingFailed && signal === null,
          duration_ms: duration,
        })
      })
    }
    const terminate = () => {
      if (finished) return
      if (child.pid) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.on('error', () => { child.kill('SIGKILL') })
        }
        else {
          try { process.kill(-child.pid, 'SIGKILL') }
          catch { child.kill('SIGKILL') }
        }
      }
      settleTimer ??= setTimeout(() => { child.kill('SIGKILL'); finish(null, null) }, 2000)
    }
    const collect = (data: Buffer, target: Buffer[]) => {
      const remaining = Math.max(0, command.max_output_bytes - total)
      if (remaining) target.push(data.subarray(0, remaining))
      total += data.length
      if (total > command.max_output_bytes && !outputLimited) { outputLimited = true; terminate() }
    }
    child.stdout.on('data', data => collect(Buffer.from(data), stdout))
    child.stderr.on('data', data => collect(Buffer.from(data), stderr))
    child.on('spawn', () => {
      const lifetime = {
        spawned_at: Date.now(),
        alive: () => !finished && child.exitCode === null && child.signalCode === null,
      }
      tracking = Promise.resolve().then(() => onSpawn(child.pid!, lifetime)).catch((failure) => {
        trackingFailed = true
        error = `Process tracking failed: ${redact(failure instanceof Error ? failure.message : String(failure))}`
        terminate()
      })
    })
    child.on('error', failure => { error = redact(failure.message); finish(null, null) })
    child.on('close', finish)
    const timer = setTimeout(() => { timedOut = true; terminate() }, command.timeout_ms)
  })
}

function outcome(receipt: CheckReceipt): CheckRunResult['outcome'] {
  if (receipt.error || !receipt.process || receipt.process.error || !receipt.process.process_stopped
    || !receipt.before || !receipt.after) return 'blocked'
  if (!isDeepStrictEqual(receipt.expected, receipt.before) || !isDeepStrictEqual(receipt.before, receipt.after)) return 'stale'
  return receipt.process.exit_code === 0 ? 'passed' : 'failed'
}

function verifyEnvironment(
  artifacts: ExecutionArtifacts, receipt: CheckReceipt,
): void {
  if (receipt.version === 1) {
    if (receipt.command.dependency_inputs !== undefined) {
      throw new Error('A historical v1 receipt cannot attest newly declared dependency inputs.')
    }
    return
  }
  for (const phase of ['before', 'after'] as const) {
    const artifact = phase === 'before' ? receipt.before_artifact : receipt.after_artifact
    const candidate = artifact ? artifacts.get(artifact) as Candidate : null
    verifyDependencyObservation(receipt.command, candidate, receipt.environment.dependency_inputs[phase])
    if (phase === 'before' && candidate && receipt.process) assertDependencyInputs(receipt.command, candidate)
  }
}

export function verifyCommandResult(
  directory: string, todoId: string, executionId: string, state: WorkflowState, check: WorkflowState['checks'][number],
) {
  const artifacts = new ExecutionArtifacts(directory, executionId)
  const receipt = receiptSchema.parse(artifacts.get(check.receipt))
  const pointer = artifacts.getReceipt(check.operation_id)
  const operation = state.operations.find(operation => operation.id === check.operation_id)
  const command = state.plans.find(plan => plan.id === check.plan_id)?.content.acceptance.find(item => item.id === check.acceptance_id)?.command
  if (!pointer || pointer.digest !== check.receipt || !operation || receipt.todo_id !== todoId || receipt.execution_id !== executionId
    || receipt.operation_id !== check.operation_id || receipt.plan_id !== check.plan_id || receipt.attempt_id !== check.attempt_id
    || receipt.acceptance_id !== check.acceptance_id || !isDeepStrictEqual(receipt.command, command)
    || !isDeepStrictEqual(receipt.expected, check.candidate) || !isDeepStrictEqual(receipt.after, check.after)
    || outcome(receipt) !== check.outcome || receipt.process?.process_stopped !== true) {
    throw new Error('Actual command receipt does not support the stored check result.')
  }
  for (const [key, candidate] of [[receipt.before_artifact, receipt.before], [receipt.after_artifact, receipt.after]] as const) {
    if (!key || !candidate) throw new Error('Receipt is missing its candidate manifest.')
    verifyCandidateManifest(artifacts.get(key), candidate)
  }
  verifyEnvironment(artifacts, receipt)
  return { receipt_version: receipt.version, notes: environmentLimitations(receipt.version) }
}

export function readRecordedCheck(directory: string, todoId: string, executionId: string, state: WorkflowState, operationId: string) {
  const operation = state.operations.find(item => item.id === operationId)
  if (!operation || operation.kind !== 'check') throw new Error('Check operation not found.')
  const artifacts = new ExecutionArtifacts(directory, executionId)
  const saved = artifacts.getReceipt(operationId)
  if (!saved) return null
  const receipt = receiptSchema.parse(saved.value)
  const command = state.plans.find(plan => plan.id === operation.plan_id)?.content.acceptance
    .find(item => item.id === operation.acceptance_id)?.command
  if (receipt.todo_id !== todoId || receipt.execution_id !== executionId || receipt.operation_id !== operation.id
    || receipt.plan_id !== operation.plan_id || receipt.attempt_id !== operation.attempt_id
    || receipt.acceptance_id !== operation.acceptance_id || !isDeepStrictEqual(receipt.command, command)
    || !isDeepStrictEqual(receipt.expected, operation.candidate)) throw new Error('Receipt does not match the exact check identity.')
  for (const [key, candidate] of [[receipt.before_artifact, receipt.before], [receipt.after_artifact, receipt.after]] as const) {
    if ((key === null) !== (candidate === null)) throw new Error('Receipt is missing its candidate manifest.')
    if (key && candidate) verifyCandidateManifest(artifacts.get(key), candidate)
  }
  verifyEnvironment(artifacts, receipt)
  return { digest: saved.digest, receipt }
}

/** Publish the immutable receipt first, then reconcile state. Never re-execute an existing operation. */
export function recoverCheck(rawInput: unknown): CheckRunResult {
  const input = runRequestSchema.parse(rawInput)
  const store = new TodoStore(input.directory)
  const { state, plan, attempt } = checkContext(store, input)
  const operation = state.operations.find(operation => operation.id === input.operation_id)
  if (!operation || operation.kind !== 'check') throw new Error('No check operation to recover.')
  if (operation.reconciliation) throw new Error('This interrupted check was reconciled without verification; do not recover or rerun it.')
  if (operation.actor !== input.actor || operation.acceptance_id !== input.acceptance_id
    || operation.plan_id !== plan.id || operation.attempt_id !== attempt.id) {
    throw new Error('Receipt does not match the exact current check identity.')
  }
  const saved = readRecordedCheck(input.directory, input.todo_id, input.execution_id, state, input.operation_id)
  if (!saved) throw new Error('Check has no durable receipt; its process state is unknown. Do not automatically retry.')
  const { receipt } = saved
  const result = outcome(receipt)
  const request: WorkflowRequest = {
    request_id: `result-${createHash('sha256').update(input.operation_id).digest('hex')}`,
    expected_revision: state.revision,
    command: {
      action: 'complete_check', operation_id: input.operation_id, after: receipt.after,
      outcome: result === 'stale' ? 'blocked' : result, source: 'local_runner', receipt: saved.digest,
      summary: receipt.error ?? receipt.process?.error ?? `Local command ${result}; exit=${receipt.process?.exit_code ?? 'none'}.`,
      process_stopped: receipt.process?.process_stopped ?? true,
    },
  }
  store.applyWorkflow(input.todo_id, input.execution_id, request)
  return { outcome: result, receipt, artifact: saved.digest, limitations: environmentLimitations(receipt.version) }
}

function beginRequest(
  input: RunCheckRequest, candidate: CandidateReference, runner: ProcessHandle | null, supervised = false,
): WorkflowRequest {
  return {
    request_id: input.request_id, expected_revision: input.expected_revision,
    command: {
      action: 'begin_check', operation_id: input.operation_id, acceptance_id: input.acceptance_id,
      actor: input.actor, candidate, ...(runner ? { runner } : {}), ...(supervised ? { dispatch: 'pending' } : {}),
    },
  }
}

export async function runCheck(
  rawInput: unknown,
  supervise: (input: RunCheckRequest) => Promise<void> = launchCheckSupervisor,
): Promise<CheckRunResult> {
  const input = runRequestSchema.parse(rawInput)
  const store = new TodoStore(input.directory)
  const initial = checkContext(store, input)
  if (!initial.state.operations.some(operation => operation.id === input.operation_id)
    && initial.command.dependency_inputs?.length) {
    assertLocalWorkspace(initial.attempt.workspace)
    assertDependencyInputs(initial.command, captureCandidate(initial.attempt.workspace.root))
  }
  const runner = describeProcess(process.pid)
  const reservation = store.transaction(() => {
    const context = checkContext(store, input)
    assertLocalWorkspace(context.attempt.workspace)
    const existing = context.state.operations.find(operation => operation.id === input.operation_id)
    const candidate = existing?.candidate ?? context.state.yield?.candidate
    if (!candidate) throw new Error('Yield a candidate before starting checks.')
    outsideWorkspace(input.directory, context.attempt.workspace.root)
    store.applyWorkflow(input.todo_id, input.execution_id,
      beginRequest(input, candidate, existing ? existing.runner : runner, !existing || existing.dispatch !== null))
    const artifacts = new ExecutionArtifacts(input.directory, input.execution_id)
    // Only this protocol guarantees an unclaimed operation has not started its command.
    const pending = !existing || (existing.status === 'running' && existing.dispatch === 'pending' && !existing.supervisor)
    if (pending) assertDispatchAllowed(stateFor(store, input))
    return {
      dispatch: pending && !artifacts.getReceipt(input.operation_id, 'supervisor')
        && !artifacts.getReceipt(input.operation_id, 'process') && !artifacts.getReceipt(input.operation_id),
    }
  })
  if (reservation.dispatch) await supervise(input)
  return recoverCheck(input)
}

/** Claim once before effects and publish a real result independently of the requesting helper. */
export async function executeReservedCheck(rawInput: unknown): Promise<void> {
  const input = runRequestSchema.parse(rawInput)
  const store = new TodoStore(input.directory)
  const artifacts = new ExecutionArtifacts(input.directory, input.execution_id)
  const supervisor = describeProcess(process.pid)
  const reservation = store.transaction(() => {
    const context = checkContext(store, input)
    assertDispatchAllowed(context.state)
    assertLocalWorkspace(context.attempt.workspace)
    const operation = context.state.operations.find(item => item.id === input.operation_id)
    if (!operation || operation.kind !== 'check' || operation.status !== 'running' || operation.dispatch !== 'pending'
      || !operation.runner || !operation.candidate
      || operation.plan_id !== context.plan.id || operation.attempt_id !== context.attempt.id
      || operation.epoch !== context.state.epoch || operation.acceptance_id !== input.acceptance_id || operation.actor !== input.actor) {
      throw new Error('Supervisor requires the original still-running check reservation.')
    }
    outsideWorkspace(input.directory, context.attempt.workspace.root)
    store.applyWorkflow(input.todo_id, input.execution_id,
      beginRequest(input, operation.candidate, operation.runner, operation.dispatch !== null))
    if (operation.supervisor || artifacts.getReceipt(input.operation_id, 'supervisor') || artifacts.getReceipt(input.operation_id)) {
      throw new Error('Supervisor already claimed this operation. Recover its receipt or observe it; never launch it again.')
    }
    const claim: WorkflowRequest = {
      request_id: `supervisor-${createHash('sha256').update(input.operation_id).digest('hex')}`,
      expected_revision: context.state.revision,
      command: { action: 'claim_supervisor', operation_id: input.operation_id, supervisor },
    }
    // Validate the same transition before publishing a claim that cannot be replaced.
    transitionWorkflow(context.state, claim)
    artifacts.putReceipt(input.operation_id, {
      version: 1, todo_id: input.todo_id, execution_id: input.execution_id, operation_id: input.operation_id,
      request_id: input.request_id, plan_id: context.plan.id, attempt_id: context.attempt.id,
      runner: operation.runner, supervisor,
    }, 'supervisor')
    store.applyWorkflow(input.todo_id, input.execution_id, claim)
    return { ...context, candidate: operation.candidate, runner: operation.runner }
  })
  const receipt: Extract<CheckReceipt, { version: 2 }> = {
    version: 2, todo_id: input.todo_id, execution_id: input.execution_id, operation_id: input.operation_id,
    plan_id: reservation.plan.id, attempt_id: reservation.attempt.id, acceptance_id: input.acceptance_id,
    command: reservation.command, expected: reservation.candidate,
    before: null, after: null, before_artifact: null, after_artifact: null, process: null, error: null,
    started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
    environment: captureRunnerEnvironment(),
  }
  try {
    const before = captureCandidate(reservation.attempt.workspace.root)
    const beforeInputs = observeDependencyInputs(reservation.command, before)
    const beforeArtifact = artifacts.put(before)
    receipt.before = reference(before)
    receipt.before_artifact = beforeArtifact
    receipt.environment.dependency_inputs.before = beforeInputs
    if (!isDeepStrictEqual(receipt.before, reservation.candidate)) throw new Error('Candidate changed after yield; command was not started.')
    assertDependencyInputs(reservation.command, before)
    const onSpawn = async (pid: number, lifetime: { spawned_at: number; alive: () => boolean }) => {
      const liveBeforeQuery = lifetime.alive()
      const child = await describeProcessAsync(pid)
      // A late PID lookup may see a replacement; only bind identity within the spawned child's lifetime.
      if (!liveBeforeQuery || !lifetime.alive() || (child.started_at !== null && child.started_at > lifetime.spawned_at)) {
        child.started_at = null
      }
      await artifacts.putReceiptAsync(input.operation_id, {
        version: 1, todo_id: input.todo_id, execution_id: input.execution_id, operation_id: input.operation_id,
        plan_id: reservation.plan.id, attempt_id: reservation.attempt.id, runner: reservation.runner, supervisor, child,
      }, 'process')
    }
    // execute() calls spawn synchronously. Order stop intent vs actual startup under
    // the same mutex, but release it before waiting for command output or tracking.
    const started = store.transaction(() => {
      const current = stateFor(store, input)
      assertDispatchAllowed(current)
      const operation = current.operations.find(item => item.id === input.operation_id)
      if (operation?.status !== 'running' || current.epoch !== reservation.state.epoch
        || current.plan_id !== reservation.plan.id || current.attempt_id !== reservation.attempt.id) {
        throw new Error('Check reservation changed before command startup; command was not started.')
      }
      return { result: execute(reservation.command, before.root, onSpawn) }
    })
    receipt.process = await started.result
    const after = captureCandidate(before.root)
    const afterInputs = observeDependencyInputs(reservation.command, after)
    const afterArtifact = artifacts.put(after)
    receipt.after = reference(after)
    receipt.after_artifact = afterArtifact
    receipt.environment.dependency_inputs.after = afterInputs
  }
  catch (error) { receipt.error = redact(error instanceof Error ? error.message : String(error)) }
  receipt.ended_at = new Date().toISOString()
  artifacts.putReceipt(input.operation_id, receipt)
}

/** Observe original handles without replaying work, claiming descendant termination, or releasing occupancy. */
export function observeCheck(rawInput: unknown) {
  const input = observeRequestSchema.parse(rawInput)
  const store = new TodoStore(input.directory)
  const todo = store.resolveItemFromAll(input.todo_id)
  if (!todo || todo.id !== input.todo_id) throw new Error('Exact stable Todo id required for process observation.')
  const state = todo.executions.find(execution => execution.id === input.execution_id)?.workflow
  const operation = state?.operations.find(operation => operation.id === input.operation_id)
  if (!state || !operation || operation.kind !== 'check') throw new Error('Check operation not found for observation.')
  const artifacts = new ExecutionArtifacts(input.directory, input.execution_id)
  const savedSupervisor = artifacts.getReceipt(input.operation_id, 'supervisor')
  const supervisor = savedSupervisor ? supervisorSchema.parse(savedSupervisor.value) : null
  if (supervisor && (supervisor.todo_id !== input.todo_id || supervisor.execution_id !== input.execution_id
    || supervisor.operation_id !== operation.id || supervisor.plan_id !== operation.plan_id
    || supervisor.attempt_id !== operation.attempt_id || !isDeepStrictEqual(supervisor.runner, operation.runner)
    || (operation.supervisor && !isDeepStrictEqual(supervisor.supervisor, operation.supervisor)))) {
    throw new Error('Supervisor receipt does not match the original check operation.')
  }
  const saved = artifacts.getReceipt(input.operation_id, 'process')
  let processRecord: z.infer<typeof checkProcessSchema> | null = null
  if (saved) {
    processRecord = checkProcessSchema.parse(saved.value)
    if (processRecord.todo_id !== input.todo_id || processRecord.execution_id !== input.execution_id
      || processRecord.operation_id !== operation.id || processRecord.plan_id !== operation.plan_id
      || processRecord.attempt_id !== operation.attempt_id || !isDeepStrictEqual(processRecord.runner, operation.runner)
      || !isDeepStrictEqual(processRecord.supervisor, operation.supervisor ?? supervisor?.supervisor ?? null)) {
      throw new Error('Process receipt does not match the original check operation.')
    }
  }
  const result = artifacts.getReceipt(operation.id)
  const supervisorHandle = operation.supervisor ?? supervisor?.supervisor ?? null
  const supervisorObservation = supervisorHandle ? { handle: supervisorHandle, observation: observeProcess(supervisorHandle) } : null
  const dispatchRetryable = operation.status === 'running' && operation.dispatch === 'pending'
    && !supervisorHandle && !savedSupervisor && !saved && !result && !activeControl(state)
  return {
    schema_version: 1, operation_id: operation.id, operation_status: operation.status,
    initial_dispatch_retryable: dispatchRetryable,
    runner: operation.runner ? { handle: operation.runner, observation: observeProcess(operation.runner) } : null,
    supervisor: supervisorObservation,
    command: processRecord ? { handle: processRecord.child, observation: observeProcess(processRecord.child) } : null,
    result_receipt: result?.digest ?? null,
    automatic_release: false,
    next: result
      ? 'Recover the saved result without re-running its command; applicability and descendant liveness still need separate checks.'
      : activeControl(state)
        ? 'Stop requested. Do not dispatch or replay; account for the original operation and any late supervisor, then reconcile.'
        : dispatchRetryable
        ? 'Initial dispatch has not been claimed. Retry check with the exact original request; the one-time claim still gates command execution.'
        : supervisorObservation?.observation.state === 'running'
          ? 'The original supervisor is still running and may publish a result. Wait or inspect it; do not start a replacement.'
          : 'The supervisor is stopped or unavailable without a result. Inspect the original task, artifacts and descendants; never automatically replay it.',
    limitations: [
      'Only recorded process incarnations are observed; detached descendants can be outside this view.',
      ...(operation.supervisor && !savedSupervisor ? ['Supervisor receipt pointer is missing; its persistent ownership remains unresolved.'] : []),
    ],
  }
}
