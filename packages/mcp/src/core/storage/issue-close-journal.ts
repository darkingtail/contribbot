import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { safeWriteFileSync } from '../utils/fs.js'
import { repositoryIdentityKey, repositoryRefSchema, sameRepository, type RepositoryRef } from '../utils/repository-ref.js'

export const issueDispatchSchema = z.object({
  version: z.literal(1),
  commentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  initializedAt: z.string().datetime(),
  effects: z.array(z.object({
    kind: z.enum(['comment', 'close']),
    admittedAt: z.string().datetime(),
    returnedAt: z.string().datetime().optional(),
    result: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('comment'), id: z.number().int().positive() }).strict(),
      z.object({ kind: z.literal('close'), state: z.literal('closed') }).strict(),
    ]).optional(),
  }).strict()).max(2),
}).strict().superRefine((value, ctx) => {
  const kinds = value.effects.map(effect => effect.kind)
  if (new Set(kinds).size !== kinds.length) ctx.addIssue({ code: 'custom', message: 'Duplicate Issue effect admission.' })
  for (const effect of value.effects) {
    if (Boolean(effect.result) !== Boolean(effect.returnedAt) || (effect.result && effect.result.kind !== effect.kind)
      || Date.parse(effect.admittedAt) < Date.parse(value.initializedAt)
      || (effect.returnedAt && Date.parse(effect.returnedAt) < Date.parse(effect.admittedAt))) {
      ctx.addIssue({ code: 'custom', message: 'Invalid Issue effect result or time.' })
    }
  }
})

export interface IssueCloseIdentity {
  repository: RepositoryRef
  issueNumber: number
  todoId: string
  executionId: string | null
}

const identitySchema = z.object({
  repository: repositoryRefSchema,
  issueNumber: z.number().int().positive().safe(),
  todoId: z.string().trim().min(1),
  executionId: z.string().trim().min(1).nullable(),
})

export type AllowedIssueCloseJournal = IssueCloseIdentity & {
  closureId: string
  lifecycleRevision: number
  commentDigest?: string
}

export interface IssueCloseReceipt extends IssueCloseIdentity {
  lifecycleRevision: number
  state: 'pending' | 'closed'
  startedAt: string
  remoteClosedAt?: string
  closureId?: string
  dispatch?: z.infer<typeof issueDispatchSchema>
}

export function issueCloseLockKey(repository: RepositoryRef, issueNumber: number): string {
  return createHash('sha256').update(JSON.stringify([repositoryIdentityKey(repository), issueNumber, 'issue-close'])).digest('hex').slice(0, 16)
}

export function issueCloseReceiptPath(
  directory: string, repository: RepositoryRef, issueNumber: number, todoId: string, executionId: string | null,
): string {
  const digest = createHash('sha256').update(JSON.stringify([
    repositoryIdentityKey(repository), issueNumber, todoId, executionId,
  ])).digest('hex').slice(0, 24)
  return join(directory, '.operations', `issue-close-${digest}.json`)
}

export function parseIssueCloseReceipt(raw: unknown, expected: IssueCloseIdentity): IssueCloseReceipt {
  if (!raw || typeof raw !== 'object') throw new Error('Issue close receipt must be an object.')
  identitySchema.parse(raw)
  identitySchema.parse(expected)
  const value = raw as Partial<IssueCloseReceipt>
  const { state, startedAt } = value
  if (!value.repository || !sameRepository(value.repository, expected.repository) || value.issueNumber !== expected.issueNumber
    || value.todoId !== expected.todoId || value.executionId !== expected.executionId
    || (state !== 'pending' && state !== 'closed')
    || typeof startedAt !== 'string' || (state === 'closed' && typeof value.remoteClosedAt !== 'string')) {
    throw new Error('Issue close receipt does not match the requested operation.')
  }
  if (typeof value.lifecycleRevision !== 'number'
    || !Number.isSafeInteger(value.lifecycleRevision) || value.lifecycleRevision < 0) {
    throw new Error('Issue close receipt requires an exact lifecycle revision.')
  }
  if (value.closureId !== undefined && (typeof value.closureId !== 'string' || !value.closureId)) {
    throw new Error('Invalid managed closure identity in issue close receipt.')
  }
  z.string().datetime().parse(startedAt)
  if (value.remoteClosedAt !== undefined) z.string().datetime().parse(value.remoteClosedAt)
  if (!value.closureId && !value.dispatch) throw new Error('Plain Issue close receipt requires original dispatch provenance.')
  if (value.closureId && value.executionId === null) throw new Error('Managed Issue journal requires an execution identity.')
  return { ...expected, lifecycleRevision: value.lifecycleRevision, state, startedAt,
    ...(typeof value.remoteClosedAt === 'string' ? { remoteClosedAt: value.remoteClosedAt } : {}),
    ...(value.closureId ? { closureId: value.closureId } : {}),
    ...(value.dispatch !== undefined ? { dispatch: issueDispatchSchema.parse(value.dispatch) } : {}),
  }
}

export function readIssueCloseReceipt(path: string, expected: IssueCloseIdentity): IssueCloseReceipt {
  try { return parseIssueCloseReceipt(JSON.parse(readFileSync(path, 'utf8')), expected) }
  catch (error) { throw new Error(`Invalid Issue close receipt at ${path}: ${String(error)}`) }
}

export function writeIssueCloseReceipt(path: string, receipt: IssueCloseReceipt): void {
  mkdirSync(dirname(path), { recursive: true })
  safeWriteFileSync(path, JSON.stringify(receipt, null, 2))
}

/** A retained journal means the linked operation still needs local accounting. */
export function assertNoPendingIssueClose(
  directory: string, todoId: string, allowed?: AllowedIssueCloseJournal,
): void {
  const operations = join(directory, '.operations')
  if (!existsSync(operations)) return
  const root = lstatSync(operations)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid Issue operation directory.')
  for (const entry of readdirSync(operations)) {
    if (!/^issue-close-[a-f0-9]{24}\.json$/.test(entry)) continue
    const path = join(operations, entry)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw new Error('Invalid Issue operation journal.')
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    // Even an unrelated malformed record cannot establish which Todo it blocks.
    let identity: IssueCloseIdentity
    try { identity = identitySchema.parse(raw) }
    catch {
      throw new Error(`Issue operation journal identity is unknown at ${path}; account for the original operation before this Todo transition.`)
    }
    const receipt = parseIssueCloseReceipt(raw, identity)
    if (path !== issueCloseReceiptPath(directory, identity.repository,
      identity.issueNumber, identity.todoId, identity.executionId)) {
      throw new Error('Issue operation journal filename does not match its identity.')
    }
    if (receipt.todoId === todoId) {
      if (allowed && allowed.todoId === todoId && receipt.closureId
        && sameRepository(receipt.repository, allowed.repository)
        && receipt.issueNumber === allowed.issueNumber && receipt.todoId === allowed.todoId
        && receipt.executionId === allowed.executionId && receipt.closureId === allowed.closureId
        && receipt.lifecycleRevision === allowed.lifecycleRevision
        && (allowed.commentDigest === undefined || receipt.dispatch?.commentDigest === allowed.commentDigest)) continue
      throw new Error('Pending issue_close operation must be accounted for before this Todo transition.')
    }
  }
}
