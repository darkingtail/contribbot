import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readFileSync, readdirSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { workflowSchema } from '../execution/contracts.js'
import type { WorkflowState } from '../execution/contracts.js'
import { activeControl } from '../execution/workflow.js'
import { parseIssueCloseReceipt } from './issue-close-journal.js'
import type { IssueCloseIdentity, IssueCloseReceipt } from './issue-close-journal.js'

const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex')
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const readSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('issue'), returnedAt: z.string().datetime(), state: z.enum(['open', 'closed']),
  }).strict(),
  z.object({
    kind: z.literal('comments'), returnedAt: z.string().datetime(),
    commentIds: z.array(z.number().int().positive()),
  }).strict(),
  z.object({
    kind: z.literal('read-failed'), method: z.enum(['issue', 'comments']), endedAt: z.string().datetime(),
  }).strict(),
])
const accountingSchema = z.object({
  version: z.literal(1),
  kind: z.literal('plain-issue-close-interrupted'),
  basis: z.enum(['returned-invocation', 'zero-admission-recovery']),
  journalHash: digestSchema,
  journalContent: z.string().min(1),
  control: workflowSchema.shape.control.unwrap(),
  workflowRevision: z.number().int().nonnegative().safe(),
  epoch: z.number().int().nonnegative().safe(),
  reads: z.array(readSchema).max(2),
  accountedAt: z.string().datetime(),
}).strict()

export type IssueCloseReadResult = z.infer<typeof readSchema>
type AccountingRecord = z.infer<typeof accountingSchema>
export interface IssueCloseJournalSnapshot {
  content: string
  digest: string
  receipt: IssueCloseReceipt
}
export interface AccountedIssueClose {
  digest: string
  record: AccountingRecord
}

function operationsDirectory(directory: string): string {
  const path = join(directory, '.operations')
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid Issue operation directory.')
  return path
}

function readBounded(path: string): string {
  if (lstatSync(path).isSymbolicLink()) throw new Error('Issue accounting file must not be a symbolic link.')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Issue accounting file is not a bounded regular file.')
    return readFileSync(fd, 'utf8')
  }
  finally { closeSync(fd) }
}

export function readIssueCloseJournalSnapshot(
  path: string, identity: IssueCloseIdentity,
): IssueCloseJournalSnapshot {
  const content = readBounded(path)
  return { content, digest: sha256(content), receipt: parseIssueCloseReceipt(JSON.parse(content), identity) }
}

export function assertPlainIssueCloseRequest(
  receipt: IssueCloseReceipt, lifecycleRevision: number, commentDigest: string,
): void {
  if (receipt.closureId || !receipt.dispatch) throw new Error('Original plain Issue dispatch provenance is missing.')
  if (receipt.lifecycleRevision !== lifecycleRevision) {
    throw new Error('Issue close journal belongs to an earlier Todo lifecycle; reconcile the original operation.')
  }
  if (receipt.dispatch.commentDigest !== commentDigest) {
    throw new Error('Original plain Issue close comment does not match this request.')
  }
}

function assertSettled(snapshot: IssueCloseJournalSnapshot): void {
  if (snapshot.receipt.closureId || !snapshot.receipt.dispatch
    || snapshot.receipt.dispatch.effects.some(effect => !effect.result || !effect.returnedAt)) {
    throw new Error('Original Issue effect result remains unknown; no accounting or redispatch is allowed.')
  }
}

function assertAccountingBasis(record: AccountingRecord, snapshot: IssueCloseJournalSnapshot): void {
  if (record.basis === 'zero-admission-recovery'
    && (snapshot.receipt.dispatch!.effects.length !== 0 || record.reads.length !== 0)) {
    throw new Error('Zero-admission recovery cannot contain dispatched effects or invented read outcomes.')
  }
}

function assertControlHistory(record: AccountingRecord, state: WorkflowState): void {
  const original = record.control.requests.find(request => request.id === record.control.active_id)
  const current = state.control
  if (!original || !current || !activeControl(state) || state.epoch !== record.epoch
    || record.workflowRevision > state.revision || original.at_revision > record.workflowRevision
    || !isDeepStrictEqual(current.requests.slice(0, record.control.requests.length), record.control.requests)
    || !isDeepStrictEqual(current.events.slice(0, record.control.events.length), record.control.events)) {
    throw new Error('Original Issue accounting control history no longer matches; a new close decision is required.')
  }
}

function publishImmutable(path: string, content: string): void {
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('Issue accounting receipt exceeds its size limit.')
  const temporary = `${path}.${randomUUID()}.pending`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, content, 'utf8')
      fsyncSync(fd)
    }
    finally { closeSync(fd) }
    try { linkSync(temporary, path) }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
      if (readBounded(path) !== content) throw new Error('Immutable Issue accounting receipt has conflicting content.')
    }
  }
  finally { unlinkSync(temporary) }
}

/** Caller holds both locks and owns the invocation, or proves a zero-admission recovery. */
export function publishIssueCloseAccounting(
  directory: string, snapshot: IssueCloseJournalSnapshot, state: WorkflowState, reads: IssueCloseReadResult[],
  basis: AccountingRecord['basis'] = 'returned-invocation',
): AccountedIssueClose {
  assertSettled(snapshot)
  const record = accountingSchema.parse({
    version: 1, kind: 'plain-issue-close-interrupted', basis,
    journalHash: snapshot.digest, journalContent: snapshot.content,
    control: state.control, workflowRevision: state.revision, epoch: state.epoch,
    reads, accountedAt: new Date().toISOString(),
  })
  assertAccountingBasis(record, snapshot)
  assertControlHistory(record, state)
  const content = JSON.stringify(record)
  const digest = sha256(content)
  publishImmutable(join(operationsDirectory(directory), `accounted-issue-close-${digest}.json`), content)
  return { digest, record }
}

/** A replay can consume evidence, never create it or perform fresh readback as proof. */
export function findIssueCloseAccounting(
  directory: string, snapshot: IssueCloseJournalSnapshot, state: WorkflowState,
): AccountedIssueClose | undefined {
  assertSettled(snapshot)
  const operations = operationsDirectory(directory)
  for (const entry of readdirSync(operations)) {
    const match = /^accounted-issue-close-([a-f0-9]{64})\.json$/.exec(entry)
    if (!match) continue
    let record: AccountingRecord
    let conflictingJournal = false
    try {
      const content = readBounded(join(operations, entry))
      if (sha256(content) !== match[1]) continue
      record = accountingSchema.parse(JSON.parse(content))
      if (sha256(record.journalContent) !== record.journalHash) continue
      const original = parseIssueCloseReceipt(JSON.parse(record.journalContent), snapshot.receipt)
      if (original.lifecycleRevision !== snapshot.receipt.lifecycleRevision) continue
      const recordedSnapshot = { content: record.journalContent, digest: record.journalHash, receipt: original }
      assertSettled(recordedSnapshot)
      assertAccountingBasis(record, recordedSnapshot)
      conflictingJournal = record.journalHash !== snapshot.digest || record.journalContent !== snapshot.content
    }
    catch {
      // Unrelated audit corruption is not an active operation or cleanup authority.
      continue
    }
    if (conflictingJournal) throw new Error('Original Issue journal changed from its immutable accounting; retain it for inspection.')
    assertControlHistory(record, state)
    return { digest: match[1]!, record }
  }
  return undefined
}

/** Caller retains both the Issue claim lock and the Todo transaction. */
export function removeAccountedIssueClose(path: string, snapshot: IssueCloseJournalSnapshot): void {
  if (readBounded(path) !== snapshot.content) throw new Error('Original Issue journal changed before accounted cleanup.')
  unlinkSync(path)
}

export function interruptedIssueCloseMessage(accounted: AccountedIssueClose): string {
  const record = accounted.record
  const request = record.control.requests.find(request => request.id === record.control.active_id)!
  const journal = JSON.parse(record.journalContent) as IssueCloseReceipt
  const effects = journal.dispatch!.effects.map(effect =>
    effect.result?.kind === 'comment' ? `comment #${effect.result.id} returned`
      : effect.result?.kind === 'close' ? 'close returned closed' : 'unknown')
  const failedReads = record.reads.filter(read => read.kind === 'read-failed')
    .map(read => `${read.method} GET failed`).join(', ')
  return `Plain issue_close for ${journal.repository.path}#${journal.issueNumber} was interrupted by `
    + `${request.kind} control ${request.id} (${request.decision}). `
    + `Original effects accounted: ${effects.join(', ') || 'no POST admitted'}. Receipt: ${accounted.digest}. `
    + (record.basis === 'zero-admission-recovery' ? 'Zero-admission recovery; previous GET outcomes were not recovered. ' : '')
    + (failedReads ? `Read failures: ${failedReads}; not a remote-state observation. ` : '')
    + 'Local pause/cancel remains user-controlled; this call did not complete or archive the Todo or settle control. '
    + 'Do not resume this Issue dispatch after continue; a new explicit close decision is required.'
}
