import { existsSync, rmSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { getIssue, getIssueComments } from '../clients/github.js'
import { currentTodoExecution, TodoStore } from '../storage/todo-store.js'
import {
  issueCloseLockKey, issueCloseReceiptPath, issueDispatchSchema, parseIssueCloseReceipt, readIssueCloseReceipt,
} from '../storage/issue-close-journal.js'
import type { IssueCloseIdentity, IssueCloseReceipt } from '../storage/issue-close-journal.js'
import { withClaimLock } from '../tools/core/todo-claim.js'
import { ExecutionArtifacts } from './artifacts.js'
import { captureCandidate, verifyCandidateManifest } from './candidate.js'
import { candidateReferenceSchema, closingSchema, processHandleSchema } from './contracts.js'
import type { CandidateReference, WorkflowState } from './contracts.js'
import { assertLocalWorkspace, localMachine } from './processes.js'
import { activeControl, transitionWorkflow } from './workflow.js'

const text = z.string().trim().min(1).max(16_384)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const requestSchema = z.object({
  directory: text, repo: text, todo_id: text, execution_id: text, closure_id: text,
  request_id: text, expected_revision: z.number().int().nonnegative(), actor: text, decision: text,
  control_id: text.optional(),
  report: z.object({
    source: z.enum(['host_report', 'user']), actor: text, locator: text,
    observed_at: z.string().datetime(), reviewed_candidate: digest,
    raw: text, quiescence_basis: text, changes_review: text.optional(), unresolved: z.array(text).max(100),
  }).strict(),
}).strict()
export { requestSchema as closureReconciliationRequestSchema }
type Request = z.infer<typeof requestSchema>
type Closing = WorkflowState['closings'][number]
const recordedRequestSchema = requestSchema.omit({ directory: true, expected_revision: true })
const journalSchema = z.object({
  owner: text, repo: text, issueNumber: z.number().int().positive(), todoId: text,
  lifecycleRevision: z.number().int().nonnegative().safe(),
  executionId: text.nullable(), state: z.enum(['pending', 'closed']), startedAt: text,
  remoteClosedAt: text.optional(), closureId: text.optional(),
  dispatch: issueDispatchSchema.optional(),
}).strict()
const observationSchema = z.object({
  kind: z.literal('observed_closed'), identity: journalSchema.pick({
    owner: true, repo: true, issueNumber: true, todoId: true, executionId: true,
  }), closure_id: text, observed_at: z.string().datetime(),
  state: z.literal('closed'), source: z.literal('github:getIssue'),
}).strict()
const continuationRecordSchema = z.object({
  version: z.literal(1), original: closingSchema, request: recordedRequestSchema,
  candidate: candidateReferenceSchema, manifest: digest, machine: processHandleSchema.shape.machine,
  journal: journalSchema.nullable(),
  remote: z.object({ kind: z.enum(['recorded_closed', 'observed_closed']), receipt: digest }).strict(),
  captured_at: z.string().datetime(),
}).strict()
const cancellationObservationSchema = z.object({
  kind: z.literal('cancellation_observation'),
  identity: observationSchema.shape.identity, closure_id: text,
  state: z.enum(['open', 'closed']), observed_at: z.string().datetime(),
  source: z.literal('github:getIssue+getIssueComments'),
  comments: z.array(z.object({ id: z.number().int().positive(), body: z.string() }).strict()).max(1000),
}).strict()
const cancellationRecordSchema = continuationRecordSchema.extend({
  version: z.literal(2),
  control: z.object({
    id: text, kind: z.literal('cancel'), decision: text, note: text,
    at_revision: z.number().int().nonnegative(), at: z.string().datetime(),
  }).strict(),
  workflow_revision: z.number().int().nonnegative(),
  historical_receipt: digest.nullable(),
  remote: z.object({ kind: z.literal('cancellation_observation'), receipt: digest }).strict(),
}).strict()
const pauseObservationSchema = cancellationObservationSchema.extend({ kind: z.literal('pause_observation') })
const pauseRecordSchema = cancellationRecordSchema.extend({
  version: z.literal(3),
  control: cancellationRecordSchema.shape.control.extend({ kind: z.literal('pause') }),
  remote: z.object({ kind: z.literal('pause_observation'), receipt: digest }).strict(),
})
const recordSchema = z.discriminatedUnion('version', [continuationRecordSchema, cancellationRecordSchema, pauseRecordSchema])
type Record = z.infer<typeof recordSchema>
type ControlRecord = z.infer<typeof cancellationRecordSchema> | z.infer<typeof pauseRecordSchema>

function historicalReceipt(record: Record): string | null {
  return record.version === 1 ? record.remote.receipt : record.historical_receipt
}

const receiptKey = (input: Pick<Request, 'closure_id' | 'request_id'>) => JSON.stringify([input.closure_id, input.request_id])
function storedRequest(input: Request) {
  const { directory: _directory, expected_revision: _revision, ...request } = input
  return request
}

function identity(input: Pick<Request, 'todo_id' | 'execution_id'>, closing: Closing): IssueCloseIdentity {
  if (closing.intent.target.kind !== 'issue') throw new Error('Only a linked Issue closure can be reconciled locally.')
  const parts = closing.intent.target.repo.split('/')
  if (parts.length !== 2 || parts.some(part => !/^[\w.-]+$/.test(part))) throw new Error('Invalid closure repository.')
  return { owner: parts[0]!, repo: parts[1]!, issueNumber: closing.intent.target.issue_number,
    todoId: input.todo_id, executionId: input.execution_id }
}

function load(store: TodoStore, input: Request) {
  const todo = store.resolveItemFromAll(input.todo_id)
  const execution = todo?.executions.find(item => item.id === input.execution_id)
  const state = execution?.workflow
  const closing = state?.closings.find(item => item.intent.id === input.closure_id)
  const attempt = state?.attempts.find(item => item.id === closing?.attempt_id)
  if (!todo || todo.id !== input.todo_id || !state || !closing || !attempt) {
    throw new Error('Exact original Todo, execution, closure and attempt are required.')
  }
  if (closing.intent.target.kind !== 'issue' || closing.intent.target.repo !== input.repo
    || attempt.workspace.repo !== input.repo || attempt.owner !== input.actor) {
    throw new Error('Closure reconciliation requires the original repository and accountable owner.')
  }
  return { todo, execution, state, closing, attempt }
}

function validateReport(input: Request, closing: Closing, candidate: CandidateReference, now: string) {
  if (input.report.reviewed_candidate !== candidate.digest) throw new Error('Review the exact current candidate before continuing locally.')
  if (Date.parse(input.report.observed_at) < Date.parse(closing.at) || Date.parse(input.report.observed_at) > Date.parse(now)) {
    throw new Error('Use a current report after the closing started, not stale or future observations.')
  }
  if (input.report.unresolved.length) throw new Error('Unresolved original requests or writers prevent local continuation.')
  if (!isDeepStrictEqual(candidate, closing.candidate) && !input.report.changes_review) {
    throw new Error('Explicitly review the changed workspace before local continuation.')
  }
}

function journalPath(directory: string, value: IssueCloseIdentity) {
  return issueCloseReceiptPath(directory, value.owner, value.repo, value.issueNumber, value.todoId, value.executionId)
}

function readJournal(directory: string, value: IssueCloseIdentity): IssueCloseReceipt | null {
  const path = journalPath(directory, value)
  return existsSync(path) ? readIssueCloseReceipt(path, value) : null
}

export function issueClosureAccounting(directory: string, todoId: string, executionId: string, closing: Closing) {
  try {
    const journal = readJournal(directory, identity({ todo_id: todoId, execution_id: executionId }, closing))
    assertJournalBinding(journal, closing)
    return {
      closure_id: closing.intent.id, journal_state: journal?.state ?? 'missing',
      dispatch: journal?.dispatch ?? null,
      note: journal?.dispatch?.effects.some(effect => !effect.result)
        ? 'An original admitted request has no returned result. Keep pending; do not redispatch or release on timeout or current Issue state.'
        : !journal?.dispatch
          ? 'Dispatch provenance is missing. Preserve the reservation; missing records do not prove no effect.'
          : 'Stored facts only. Account for the original invocation and writers before local reconciliation.',
    }
  }
  catch (error) {
    return { closure_id: closing.intent.id, journal_state: 'unreadable', dispatch: null,
      note: `Preserve the original reservation and repair its journal: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function assertJournalBinding(journal: IssueCloseReceipt | null, closing: Closing) {
  if (journal?.closureId && journal.closureId !== closing.intent.id) throw new Error('Journal belongs to another closure intent.')
}

function assertControlBinding(input: Request, state: WorkflowState) {
  const control = activeControl(state)
  if (!control || control.id !== input.control_id || control.decision !== input.decision) {
    throw new Error('Stop reconciliation requires the exact active control and decision.')
  }
  if (Date.parse(input.report.observed_at) < Date.parse(control.at)) throw new Error('Use a report after the stop request.')
  return control
}

function assertKnownEffects(journal: IssueCloseReceipt | null, historical: IssueCloseReceipt | null, closing: Closing, observedAt: string) {
  if (journal?.dispatch) {
    if (journal.closureId !== closing.intent.id || closing.intent.target.kind !== 'issue'
      || journal.dispatch.commentDigest !== closing.intent.target.comment_digest) {
      throw new Error('Dispatch ledger differs from the exact original closure and comment.')
    }
    if (journal.dispatch.effects.some(effect => !effect.result)) {
      throw new Error('Unknown admitted Issue effects remain unresolved; current Issue state and a report cannot settle them.')
    }
    const times = [journal.dispatch.initializedAt, ...journal.dispatch.effects.map(effect => effect.returnedAt!)]
    if (times.some(at => Date.parse(at) > Date.parse(observedAt))) throw new Error('Report predates the original Issue effect results.')
  }
  else {
    throw new Error('Missing dispatch provenance: legacy or absent journals, including closed observations, do not prove original requests settled.')
  }
  if (historical?.remoteClosedAt && Date.parse(historical.remoteClosedAt) > Date.parse(observedAt)) {
    throw new Error('Report predates the historical close result.')
  }
}

function verifyRecord(record: Record, artifacts: ExecutionArtifacts, state: WorkflowState, closing: Closing) {
  const request = record.request
  const attempt = state.attempts.find(item => item.id === closing.attempt_id)
  const { state: _state, remote_receipt: _remote, reconciliation: _reconciliation, ...unchanged } = closing
  const { state: _originalState, remote_receipt: _originalRemote, reconciliation: _originalReconciliation, ...original } = record.original
  if (record.original.state !== 'prepared' || record.original.reconciliation
    || !isDeepStrictEqual(unchanged, original) || !attempt || request.actor !== attempt.owner
    || request.closure_id !== closing.intent.id || closing.intent.target.kind !== 'issue'
    || request.repo !== closing.intent.target.repo || request.repo !== attempt.workspace.repo
    || !isDeepStrictEqual(record.machine, attempt.workspace.machine)
    || record.candidate.root !== attempt.workspace.root || record.candidate.git_dir !== attempt.workspace.git_dir
    || record.candidate.common_dir !== attempt.workspace.common_dir) {
    throw new Error('Closure reconciliation evidence differs from its original identity or workspace.')
  }
  validateReport({ ...request, directory: '', expected_revision: 0 }, record.original, record.candidate, record.captured_at)
  verifyCandidateManifest(artifacts.get(record.manifest), record.candidate)
  const expected = identity(request, closing)
  assertJournalBinding(record.journal, closing)
  if (record.journal) parseIssueCloseReceipt(record.journal, expected)
  if (record.version === 1 && (record.original.issue_dispatch || record.journal?.dispatch)) {
    assertKnownEffects(record.journal, null, record.original, request.report.observed_at)
  }
  if (record.version !== 1) {
    const control = state.control?.requests.find(item => item.id === request.control_id)
    if (!isDeepStrictEqual(control, record.control) || control?.kind !== record.control.kind
      || control.decision !== request.decision || request.control_id !== record.control.id
      || Date.parse(request.report.observed_at) < Date.parse(control.at)
      || record.workflow_revision < control.at_revision) {
      throw new Error('Stop reconciliation record differs from its exact historical control.')
    }
    const historical = record.historical_receipt ? parseIssueCloseReceipt(artifacts.get(record.historical_receipt), expected) : null
    if (historical) {
      assertJournalBinding(historical, closing)
      if (historical.state !== 'closed'
        || (record.original.remote_receipt !== null
          ? record.original.remote_receipt !== record.historical_receipt
          : !isDeepStrictEqual(historical, record.journal))) {
        throw new Error('Historical close receipt does not match the original stop reconciliation record.')
      }
    }
    else if (record.original.remote_receipt !== null || record.journal?.state === 'closed') {
      throw new Error('Stop reconciliation must retain the original closed receipt.')
    }
    assertKnownEffects(record.journal, historical, record.original, request.report.observed_at)
    const observed = (record.version === 2 ? cancellationObservationSchema : pauseObservationSchema)
      .parse(artifacts.get(record.remote.receipt))
    if (!isDeepStrictEqual(observed.identity, expected) || observed.closure_id !== request.closure_id
      || Date.parse(observed.observed_at) < Date.parse(request.report.observed_at)
      || Date.parse(observed.observed_at) > Date.parse(record.captured_at)) {
      throw new Error('Stop observation differs from its original identity or time.')
    }
    return
  }
  if (request.control_id) throw new Error('Legacy continuation cannot contain stop control.')
  const remote = artifacts.get(record.remote.receipt)
  if (record.remote.kind === 'recorded_closed') {
    const receipt = parseIssueCloseReceipt(remote, expected)
    assertJournalBinding(receipt, closing)
    if (receipt.state !== 'closed') throw new Error('Historical remote receipt is not closed.')
    if (record.original.remote_receipt !== null) {
      if (record.original.remote_receipt !== record.remote.receipt) throw new Error('Original remote receipt changed.')
    }
    else if (!isDeepStrictEqual(receipt, record.journal)) throw new Error('Historical journal differs from its immutable copy.')
  }
  else {
    const observed = observationSchema.parse(remote)
    if (!isDeepStrictEqual(observed.identity, expected) || observed.closure_id !== closing.intent.id
      || record.original.remote_receipt !== null || record.journal?.state === 'closed') {
      throw new Error('Read-only observation cannot replace an existing historical receipt.')
    }
  }
}

export function verifyClosureReconciliation(
  directory: string, todoId: string, executionId: string, state: WorkflowState, closing: Closing,
): string {
  const link = closing.reconciliation
  if (!link || closing.state !== 'reconciled') throw new Error('Closure is not reconciled.')
  const artifacts = new ExecutionArtifacts(directory, executionId)
  const record = recordSchema.parse(artifacts.get(link.receipt))
  if (record.request.todo_id !== todoId || record.request.execution_id !== executionId
    || link.actor !== record.request.actor || link.decision !== record.request.decision
    || closing.remote_receipt !== historicalReceipt(record) || !isDeepStrictEqual(link.candidate, record.candidate)
    || artifacts.getReceipt(receiptKey(record.request), 'closure-reconciliation')?.digest !== link.receipt) {
    throw new Error('Closure reconciliation link differs from its immutable record.')
  }
  verifyRecord(record, artifacts, state, closing)
  if (record.version !== 1) {
    if (link.control_id !== record.control.id) throw new Error('Stop reconciliation link lost its control binding.')
    transitionWorkflow(state, {
      request_id: record.request.request_id, expected_revision: record.workflow_revision,
      command: { action: 'reconcile_closure', closure_id: closing.intent.id, actor: record.request.actor,
        decision: record.request.decision, control_id: record.control.id, candidate: record.candidate,
        receipt: link.receipt, remote_receipt: record.historical_receipt },
    })
  }
  else if (link.control_id) throw new Error('Legacy continuation has an unexpected control binding.')
  return link.receipt
}

async function controlRecord(
  input: Request, initial: ReturnType<typeof load>, artifacts: ExecutionArtifacts,
  journal: IssueCloseReceipt | null, candidate: CandidateReference,
  snapshot: ReturnType<typeof captureCandidate>, assertOwned: () => void,
): Promise<ControlRecord> {
  const control = assertControlBinding(input, initial.state)
  const expected = identity(input, initial.closing)
  let historical = initial.closing.remote_receipt
  if (historical) {
    const saved = parseIssueCloseReceipt(artifacts.get(historical), expected)
    assertJournalBinding(saved, initial.closing)
    if (saved.state !== 'closed' || (journal && !isDeepStrictEqual(saved, journal))) {
      throw new Error('Conflicting historical remote receipt and current journal.')
    }
  }
  else if (journal?.state === 'closed' && journal.closureId === input.closure_id) historical = artifacts.put(journal)
  assertKnownEffects(journal, historical ? parseIssueCloseReceipt(artifacts.get(historical), expected) : null,
    initial.closing, input.report.observed_at)
  const issue = await getIssue(expected.owner, expected.repo, expected.issueNumber)
  assertOwned()
  if (issue.number !== undefined && issue.number !== expected.issueNumber) throw new Error('Issue readback identity mismatch.')
  const comments = await getIssueComments(expected.owner, expected.repo, expected.issueNumber)
  assertOwned()
  const kind = control.kind === 'pause' ? 'pause_observation' : 'cancellation_observation'
  const remote = artifacts.put((control.kind === 'pause' ? pauseObservationSchema : cancellationObservationSchema).parse({
    kind, identity: expected, closure_id: input.closure_id,
    state: issue.state.toLowerCase(), source: 'github:getIssue+getIssueComments',
    observed_at: new Date().toISOString(), comments: comments.map(({ id, body }) => ({ id, body })),
  }))
  return (control.kind === 'pause' ? pauseRecordSchema : cancellationRecordSchema).parse({
    version: control.kind === 'pause' ? 3 : 2, original: initial.closing, request: storedRequest(input), candidate,
    manifest: artifacts.put(snapshot), machine: localMachine(), journal,
    control, workflow_revision: input.expected_revision, historical_receipt: historical,
    remote: { kind, receipt: remote }, captured_at: new Date().toISOString(),
  })
}

function cleanupJournal(directory: string, record: Record) {
  const expected = identity(record.request, record.original)
  const current = readJournal(directory, expected)
  // A later closure in the same execution has its own journal. Never delete it on an old retry.
  if (current && record.journal && isDeepStrictEqual(current, record.journal)) {
    rmSync(journalPath(directory, expected))
  }
}

/** Local continuation is not remote authorship, command success or task completion. */
export async function reconcileClosure(raw: unknown) {
  const input = requestSchema.parse(raw)
  const store = new TodoStore(input.directory)
  const first = load(store, input)
  const expected = identity(input, first.closing)
  return withClaimLock(input.directory, issueCloseLockKey(expected.owner, expected.repo, expected.issueNumber), async assertOwned => {
    assertOwned()
    const initial = load(store, input)
    const artifacts = new ExecutionArtifacts(input.directory, input.execution_id)
    const saved = artifacts.getReceipt(receiptKey(input), 'closure-reconciliation')
    let record = saved ? recordSchema.parse(saved.value) : null
    if (record && !isDeepStrictEqual(record.request, storedRequest(input))) throw new Error('Conflicting closure reconciliation request reuse.')
    if (initial.closing.reconciliation) {
      if (!saved || saved.digest !== initial.closing.reconciliation.receipt) throw new Error('Closure was reconciled by another request.')
      verifyClosureReconciliation(input.directory, input.todo_id, input.execution_id, initial.state, initial.closing)
      assertOwned()
      cleanupJournal(input.directory, record!)
      return result(initial.state, input.closure_id, saved.digest)
    }
    if (currentTodoExecution(initial.todo)?.id !== input.execution_id || initial.state.closure
      || initial.state.closing_id !== input.closure_id || initial.closing.state !== 'prepared'
      || initial.state.attempt_id !== initial.attempt.id || initial.state.revision !== input.expected_revision) {
      throw new Error('Reconciliation requires the current prepared closure and exact revision.')
    }
    assertLocalWorkspace(initial.attempt.workspace)
    if (input.control_id) assertControlBinding(input, initial.state)
    else if (activeControl(initial.state)) {
      throw new Error('Use the exact active control_id; continuation cannot override a pause or cancellation.')
    }
    const journal = readJournal(input.directory, expected)
    assertJournalBinding(journal, initial.closing)
    const snapshot = captureCandidate(initial.attempt.workspace.root)
    const { digest: candidateDigest, root, git_dir, common_dir } = snapshot
    const candidate = { digest: candidateDigest, root, git_dir, common_dir }
    validateReport(input, initial.closing, candidate, new Date().toISOString())
    if (!input.control_id && (initial.closing.issue_dispatch || journal?.dispatch)) {
      assertKnownEffects(journal, null, initial.closing, input.report.observed_at)
    }
    if (input.control_id) {
      if (record) {
        if (record.version === 1) throw new Error('Original record is not stop reconciliation.')
        verifyRecord(record, artifacts, initial.state, initial.closing)
        if (!isDeepStrictEqual(record.candidate, candidate) || !isDeepStrictEqual(record.journal, journal)
          || record.workflow_revision !== input.expected_revision) {
          throw new Error('Stop reconciliation candidate or journal changed; review again with a new request.')
        }
      }
      else record = await controlRecord(input, initial, artifacts, journal, candidate, snapshot, assertOwned)
    }
    else {
      let remote: z.infer<typeof continuationRecordSchema>['remote']
      if (initial.closing.remote_receipt) {
        const historical = parseIssueCloseReceipt(artifacts.get(initial.closing.remote_receipt), expected)
        assertJournalBinding(historical, initial.closing)
        if (historical.state !== 'closed' || (journal && !isDeepStrictEqual(historical, journal))) {
          throw new Error('Conflicting historical remote close receipt and live journal.')
        }
        remote = { kind: 'recorded_closed', receipt: initial.closing.remote_receipt }
      }
      else if (journal?.state === 'closed') remote = { kind: 'recorded_closed', receipt: artifacts.put(journal) }
      else {
        const issue = await getIssue(expected.owner, expected.repo, expected.issueNumber)
        assertOwned()
        if (issue.state.toLowerCase() !== 'closed') throw new Error('Issue is not observed closed; reconcile the original public request before continuing.')
        remote = { kind: 'observed_closed', receipt: artifacts.put(observationSchema.parse({
          kind: 'observed_closed', identity: expected, closure_id: input.closure_id,
          observed_at: new Date().toISOString(), state: 'closed', source: 'github:getIssue',
        })) }
      }
      if (record) {
        verifyRecord(record, artifacts, initial.state, initial.closing)
        if (!isDeepStrictEqual(record.candidate, candidate) || !isDeepStrictEqual(record.journal, journal)
          || record.remote.kind !== remote.kind
          || (remote.kind === 'recorded_closed' && remote.receipt !== record.remote.receipt)) {
          throw new Error('Candidate or remote records changed after publication; review again with a new request.')
        }
      }
      else {
        record = recordSchema.parse({
          version: 1, original: initial.closing, request: storedRequest(input),
          candidate, manifest: artifacts.put(snapshot), machine: localMachine(), journal, remote,
          captured_at: new Date().toISOString(),
        })
      }
    }
    const receipt = saved?.digest ?? artifacts.putReceipt(receiptKey(input), record, 'closure-reconciliation')
    const latest = captureCandidate(initial.attempt.workspace.root)
    if (!isDeepStrictEqual(candidate, { digest: latest.digest, root: latest.root, git_dir: latest.git_dir, common_dir: latest.common_dir })) {
      throw new Error('Workspace changed during closure reconciliation; review again with a new request.')
    }
    assertOwned()
    const workflow = store.transaction(() => {
      const current = load(store, input)
      if (current.state.revision !== input.expected_revision || !isDeepStrictEqual(current.closing, record!.original)
        || !isDeepStrictEqual(readJournal(input.directory, expected), record!.journal)) {
        throw new Error('Closure or journal changed during reconciliation; no occupancy was released.')
      }
      if (record!.version !== 1) {
        assertControlBinding(input, current.state)
        assertLocalWorkspace(current.attempt.workspace)
        const captured = captureCandidate(current.attempt.workspace.root)
        if (!isDeepStrictEqual(candidate, { digest: captured.digest, root: captured.root,
          git_dir: captured.git_dir, common_dir: captured.common_dir })) {
          throw new Error('Workspace changed during stop reconciliation; no reservation was released.')
        }
      }
      return store.applyWorkflow(input.todo_id, input.execution_id, {
        request_id: input.request_id, expected_revision: input.expected_revision,
        command: { action: 'reconcile_closure', closure_id: input.closure_id, actor: input.actor,
          decision: input.decision, candidate, receipt, remote_receipt: historicalReceipt(record!),
          ...(input.control_id ? { control_id: input.control_id } : {}) },
      })
    })
    assertOwned()
    cleanupJournal(input.directory, record)
    return result(workflow, input.closure_id, receipt)
  })
}

function result(workflow: WorkflowState, closureId: string, receipt: string) {
  const controlId = workflow.closings.find(closing => closing.intent.id === closureId)?.reconciliation?.control_id
  const control = workflow.control?.requests.find(request => request.id === controlId)
  return {
    schema_version: 1, closure_id: closureId, reconciliation_receipt: receipt, verification: 'not_verified', workflow,
    limitations: [
      'Historical close records and read-only remote observations are separate facts; neither proves authenticated authorship.',
      'Accounting for original public requests and untracked writers relies on the actual host/user report, not its wording.',
      'No Issue was closed, reopened or commented on. Comment readback is a limited listing, not proof of absence or authorship.',
      control?.kind === 'pause'
        ? 'Pause reconciliation does not settle pause. Yield again and use settle-pause. Explicit continuation never redispatches the original Issue close; a new close needs a new explicit decision.'
        : control?.kind === 'cancel'
          ? 'Cancellation retains its active stop intent. Yield again and close locally with the same cancellation decision; this reconciliation is not task completion.'
          : 'Yield and run fresh checks before local delivery; this reconciliation is not task completion.',
    ],
  }
}
