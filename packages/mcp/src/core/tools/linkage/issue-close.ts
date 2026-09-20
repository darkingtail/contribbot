import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { closeIssue, createComment, getIssue, getIssueComments } from '../../clients/github.js'
import { RecordFiles } from '../../storage/record-files.js'
import type { ArchivedTodoItem, TodoItem } from '../../storage/todo-store.js'
import { currentTodoExecution, isTerminalTodo, TodoStore } from '../../storage/todo-store.js'
import { withClaimLock } from '../core/todo-claim.js'
import { getContribDir } from '../../utils/config.js'
import { todayDate } from '../../utils/format.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { ExecutionArtifacts } from '../../execution/artifacts.js'
import { closeManagedWithReadback, completionSchema, finalizeClosureWithReadback, prepareClosureWithReadback, recordClosureRemoteReceipt } from '../../execution/closure.js'
import type { ClosureRequest } from '../../execution/closure.js'
import { issueCloseLockKey, issueCloseReceiptPath, parseIssueCloseReceipt, readIssueCloseReceipt, writeIssueCloseReceipt } from '../../storage/issue-close-journal.js'
import type { IssueCloseIdentity, IssueCloseReceipt } from '../../storage/issue-close-journal.js'
import { activeControl, assertControlAllows } from '../../execution/workflow.js'
import {
  assertPlainIssueCloseRequest, findIssueCloseAccounting, interruptedIssueCloseMessage,
  publishIssueCloseAccounting, readIssueCloseJournalSnapshot, removeAccountedIssueClose,
} from '../../storage/issue-close-accounting.js'
import type { IssueCloseReadResult } from '../../storage/issue-close-accounting.js'

class PlainIssueCloseInterrupted extends Error {}

export type LinkedClosure = Omit<ClosureRequest, 'directory' | 'todo_id' | 'target'>

interface IssueCloseReceiptMatch {
  path: string
  receipt: IssueCloseReceipt
  content: string
}

function clearConfirmedCloseReceipt(contribDir: string, identity: IssueCloseIdentity): void {
  const path = issueCloseReceiptPath(
    contribDir, identity.owner, identity.repo, identity.issueNumber, identity.todoId, identity.executionId,
  )
  if (!existsSync(path)) return
  if (readIssueCloseReceipt(path, identity).state !== 'closed') {
    throw new Error('Finalized Todo has an unconfirmed issue close journal; inspect the original receipt before cleanup.')
  }
  rmSync(path)
}

function findIssueCloseReceipts(
  contribDir: string,
  base: Omit<IssueCloseIdentity, 'executionId'>,
  executionIds: Iterable<string | null>,
): IssueCloseReceiptMatch[] {
  const matches: IssueCloseReceiptMatch[] = []
  for (const executionId of executionIds) {
    const identity = { ...base, executionId }
    const path = issueCloseReceiptPath(
      contribDir,
      identity.owner,
      identity.repo,
      identity.issueNumber,
      identity.todoId,
      identity.executionId,
    )
    if (existsSync(path)) {
      const { receipt, content } = readIssueCloseJournalSnapshot(path, identity)
      matches.push({ path, receipt, content })
    }
  }
  return matches
}

function findArchivedTodo(store: TodoStore, query: string): ArchivedTodoItem | undefined {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return undefined
  const archived = store.listArchived()
  const byId = archived.find(todo => todo.id?.toLowerCase() === normalized)
  if (byId || normalized.startsWith('t-')) return byId
  return archived.find(todo => todo.ref?.toLowerCase() === normalized)
}

function archivedTodoMatchesClose(
  todo: TodoItem,
  receipt: IssueCloseReceipt,
  issueNumber: number,
): boolean {
  if (todo.status !== 'done' || (todo.lifecycle_revision ?? 0) !== receipt.lifecycleRevision) return false
  if (receipt.executionId === null) return true
  const execution = todo.executions.find(item => item.id === receipt.executionId)
  return execution?.closed_at != null
    && execution.outcome === 'done'
    && execution.outcome_note === `Linked GitHub issue #${issueNumber} was closed.`
}

async function issueCloseLocked(
  owner: string,
  name: string,
  issueNumber: number,
  comment?: string,
  todoItem?: string,
  assertOwned?: () => void,
  completion?: LinkedClosure,
): Promise<string> {
  const results: string[] = []
  const contribDir = getContribDir(owner, name)
  const store = todoItem ? new TodoStore(contribDir) : undefined
  let linkedTodo: { id: string; executionId: string | null; lifecycleRevision: number } | undefined
  let receiptIdentity: IssueCloseIdentity | undefined
  let receiptPath: string | undefined
  let currentReceipt: IssueCloseReceipt | undefined
  let currentReceiptContent: string | undefined
  let remoteAlreadyClosed = false
  let managedClosure: ClosureRequest | undefined
  let firstManagedPreparation = false
  let requiresDispatchLedger = false
  let ownsPlainInvocation = false
  const readResults: IssueCloseReadResult[] = []
  const commentDigest = createHash('sha256').update(comment ?? '').digest('hex')

  const assertRequestedReceipt = (receipt: IssueCloseReceipt) => {
    if (!receipt.closureId) assertPlainIssueCloseRequest(receipt, receipt.lifecycleRevision, commentDigest)
    if (receipt.dispatch?.effects.some(effect => !effect.result)) {
      throw new Error('Original Issue effect result remains unknown; recover its original result without redispatch.')
    }
  }

  // Call only while holding the Todo transaction, immediately before the action.
  const assertLinkedCurrent = (boundary: string, allowControlled = false) => {
    const resolved = store!.resolveItemById(linkedTodo!.id)
    if (!resolved) throw new Error(`linked todo ${linkedTodo!.id} changed or was removed ${boundary}`)
    const current = resolved.item
    const execution = currentTodoExecution(current)
    if ((execution?.id ?? null) !== linkedTodo!.executionId) {
      throw new Error(`linked todo ${linkedTodo!.id} changed execution ${boundary}`)
    }
    if ((current.lifecycle_revision ?? 0) !== linkedTodo!.lifecycleRevision) {
      throw new Error(`Linked Todo lifecycle revision changed ${boundary}. Reconcile the original operation.`)
    }
    if (isTerminalTodo(current)) throw new Error(`Linked Todo became terminal ${boundary}.`)
    if (!managedClosure && execution?.workflow && !allowControlled) {
      throw new Error(`Linked Todo became managed ${boundary}; account for its control and original operation before continuing.`)
    }
    return resolved
  }

  const snapshotCurrentJournal = () => {
    const snapshot = readIssueCloseJournalSnapshot(receiptPath!, receiptIdentity!)
    if (snapshot.content !== currentReceiptContent) {
      throw new Error('Original Issue journal changed outside this invocation; retain it for accounting.')
    }
    return snapshot
  }

  // A live admitted invocation can account only after its own awaited calls end.
  const accountPlainInterruption = () => {
    if (!ownsPlainInvocation || managedClosure || !store || !linkedTodo) return
    const accounted = store.transaction(() => {
      assertOwned?.()
      const resolved = assertLinkedCurrent('before original Issue accounting', true)
      const execution = currentTodoExecution(resolved.item)
      const state = execution?.workflow
      if (!state) return undefined
      if (!activeControl(state)) {
        throw new Error('Original plain Issue operation cannot continue after control history; a new explicit close decision is required.')
      }
      const snapshot = snapshotCurrentJournal()
      assertPlainIssueCloseRequest(snapshot.receipt, linkedTodo!.lifecycleRevision, commentDigest)
      const saved = publishIssueCloseAccounting(contribDir, snapshot, state, readResults)
      removeAccountedIssueClose(receiptPath!, snapshot)
      return saved
    })
    if (accounted) throw new PlainIssueCloseInterrupted(interruptedIssueCloseMessage(accounted))
  }

  const readRemote = async <T>(method: 'issue' | 'comments', read: () => Promise<T>): Promise<T> => {
    try { return await read() }
    catch (error) {
      if (!ownsPlainInvocation || managedClosure) throw error
      assertOwned?.()
      readResults.push({ kind: 'read-failed', method, endedAt: new Date().toISOString() })
      accountPlainInterruption()
      const message = error instanceof Error ? error.message : String(error)
      const effects = currentReceipt!.dispatch!.effects
      throw new Error(`Issue ${method} GET failed: ${message}. `
        + (effects.length === 0 ? 'No POST was admitted. ' : 'Previously returned POST results remain recorded. ')
        + 'The original journal is retained for an exact retry.', { cause: error })
    }
  }

  if (todoItem && store) {
    store.transaction(() => {
      const current = store.resolveItemForArchival(todoItem)?.item
      if (current?.id) store.resolveItemById(current.id)
    })
    const completedLocally = completion && store.list().find(todo =>
      todo.id === todoItem && todo.executions.at(-1)?.workflow?.closure != null)
    if (completedLocally) {
      const archived = await closeManagedWithReadback({
        ...completion, directory: contribDir, todo_id: todoItem,
        target: {
          kind: 'issue', repo: `${owner}/${name}`, issue_number: issueNumber,
          comment_digest: createHash('sha256').update(comment ?? '').digest('hex'),
        },
      })
      clearConfirmedCloseReceipt(contribDir, { owner, repo: name, issueNumber, todoId: todoItem, executionId: completion.execution_id })
      return `Reconciled completion of managed Todo ${archived.id}; no remote effects repeated.`
    }
    const resolved = store.transaction(() => {
      const item = store.resolveItemForArchival(todoItem)
      if (!item) return undefined
      const identified = store.ensureTodoId(item.storeIndex)
      return identified ? { ...item, item: identified } : undefined
    })
    if (!resolved) {
      const archived = findArchivedTodo(store, todoItem)
      if (completion && archived?.id === todoItem) {
        const closed = await closeManagedWithReadback({
          ...completion, directory: contribDir, todo_id: todoItem,
          target: {
            kind: 'issue', repo: `${owner}/${name}`, issue_number: issueNumber,
            comment_digest: createHash('sha256').update(comment ?? '').digest('hex'),
          },
        })
        clearConfirmedCloseReceipt(contribDir, { owner, repo: name, issueNumber, todoId: todoItem, executionId: completion.execution_id })
        return `GitHub issue #${issueNumber} and managed Todo ${closed.id} were already closed; no remote effects repeated.`
      }
      if (archived?.id) {
        const receipts = findIssueCloseReceipts(
          contribDir,
          { owner, repo: name, issueNumber, todoId: archived.id },
          new Set<string | null>([null, ...archived.executions.map(execution => execution.id)]),
        )
        const confirmed = receipts.filter(({ receipt }) =>
          receipt.state === 'closed' && archivedTodoMatchesClose(archived, receipt, issueNumber),
        )
        for (const { receipt } of receipts) assertRequestedReceipt(receipt)
        if (confirmed.length === 1 && receipts.length === 1) {
          rmSync(confirmed[0]!.path, { force: true })
          return `GitHub issue #${issueNumber} was already closed and todo ${archived.id} was already archived; cleared the recovery receipt.`
        }
        if (receipts.length > 0) {
          throw new Error(
            `Todo ${archived.id} is archived, but its issue_close journal does not prove one matching completed operation. `
            + 'Inspect the archived execution and journal before retrying remote work.',
          )
        }
      }
      throw new Error(`Todo not found: "${todoItem}". Use todo_list to see available items.`)
    }

    const identified = resolved.item
    if (!identified?.id) throw new Error(`Failed to assign a stable id to todo "${todoItem}".`)
    if (!currentTodoExecution(identified) && identified.executions.at(-1)?.workflow) {
      throw new Error('Managed history requires its original completion or a new execution after reopening. No GitHub changes were attempted.')
    }
    if (!currentTodoExecution(identified) && isTerminalTodo(identified)) {
      if (completion || identified.executions.at(-1)?.workflow) {
        throw new Error('Managed completion requires its original completion intent; terminal Todo cannot use legacy closure.')
      }
      if (identified.status !== 'done') throw new Error('Stopped Todo cannot be completed by an Issue event. Reopen explicitly.')
      const receipts = findIssueCloseReceipts(contribDir,
        { owner, repo: name, issueNumber, todoId: identified.id },
        new Set<string | null>([null, ...identified.executions.map(execution => execution.id)]))
      if (receipts.length) {
        for (const { receipt } of receipts) assertRequestedReceipt(receipt)
        if (receipts.length !== 1 || receipts[0]!.receipt.state !== 'closed'
          || !archivedTodoMatchesClose(identified, receipts[0]!.receipt, issueNumber)) {
          throw new Error('Terminal Todo has an unresolved or conflicting issue_close journal; reconcile the original operation.')
        }
        rmSync(receipts[0]!.path)
      }
      return `Todo ${identified.id} is already done locally; no GitHub effects repeated. Issue state was not refreshed. For a separate Issue action, omit todo_item.`
    }
    linkedTodo = {
      id: identified.id,
      executionId: currentTodoExecution(identified)?.id ?? null,
      lifecycleRevision: identified.lifecycle_revision ?? 0,
    }
    receiptIdentity = { owner, repo: name, issueNumber, todoId: linkedTodo.id, executionId: linkedTodo.executionId }
    const receipts = findIssueCloseReceipts(
      contribDir, { owner, repo: name, issueNumber, todoId: linkedTodo.id },
      new Set<string | null>([null, ...identified.executions.map(execution => execution.id)]),
    )
    const conflictingReceipt = receipts.find(({ receipt }) => receipt.executionId !== linkedTodo!.executionId)
    if (conflictingReceipt) {
      throw new Error(
        `Todo ${linkedTodo.id} has an unresolved issue_close receipt for execution ${conflictingReceipt.receipt.executionId ?? '(none)'}, `
        + `but its current execution is ${linkedTodo.executionId ?? '(none)'}. Reconcile the earlier close before continuing.`,
      )
    }
    const currentMatch = receipts.find(({ receipt }) => receipt.executionId === linkedTodo!.executionId)
    receiptPath = currentMatch?.path
      ?? issueCloseReceiptPath(contribDir, owner, name, issueNumber, linkedTodo.id, linkedTodo.executionId)
    currentReceipt = currentMatch?.receipt
    currentReceiptContent = currentMatch?.content
    if (currentReceipt && currentReceipt.lifecycleRevision !== linkedTodo.lifecycleRevision) {
      throw new Error('Issue close journal belongs to an earlier Todo lifecycle; reconcile the original operation.')
    }
    if (currentReceipt && !currentReceipt.closureId) {
      assertPlainIssueCloseRequest(currentReceipt, linkedTodo.lifecycleRevision, commentDigest)
      if (completion) throw new Error('Retained plain Issue operation requires its original accounting, not a new managed closure.')
      const recovered = store.transaction(() => {
        assertOwned?.()
        const current = assertLinkedCurrent('before accounted Issue replay', true)
        const state = currentTodoExecution(current.item)?.workflow
        if (!state) return undefined
        const snapshot = snapshotCurrentJournal()
        const saved = findIssueCloseAccounting(contribDir, snapshot, state)
          ?? (activeControl(state) && snapshot.receipt.dispatch!.effects.length === 0
            ? publishIssueCloseAccounting(contribDir, snapshot, state, [], 'zero-admission-recovery')
            : undefined)
        if (!saved) throw new Error('Original plain Issue accounting is unavailable; retain its journal. No remote changes were attempted.')
        removeAccountedIssueClose(receiptPath!, snapshot)
        return saved
      })
      if (recovered) throw new PlainIssueCloseInterrupted(interruptedIssueCloseMessage(recovered))
    }
    if (currentTodoExecution(identified)?.workflow) {
      if (!completion) throw new Error('Managed execution requires closure preflight before linked GitHub effects. No remote changes were attempted.')
      if (todoItem !== identified.id || completion.execution_id !== currentTodoExecution(identified)?.id) {
        throw new Error('Managed linked closure requires exact stable Todo and execution identities.')
      }
      managedClosure = {
        ...completion, directory: contribDir, todo_id: identified.id,
        target: {
          kind: 'issue', repo: `${owner}/${name}`, issue_number: issueNumber,
          comment_digest: createHash('sha256').update(comment ?? '').digest('hex'),
        },
      }
      firstManagedPreparation = !currentTodoExecution(identified)!.workflow!.closings
        .some(item => item.intent.id === completion.closure_id)
      const prepared = await prepareClosureWithReadback(managedClosure)
      requiresDispatchLedger = prepared.closings.find(item => item.intent.id === completion.closure_id)?.issue_dispatch === 'journal-v1'
    }
    else if (completion) {
      throw new Error('Explicit managed closure does not match the linked execution.')
    }
    if (identified.ref) {
      new RecordFiles(contribDir).ensureTodoRecord(
        identified.ref,
        identified.title,
        identified.type,
        todayDate(),
        identified.id,
        { adoptUnowned: !store.hasArchivedRef(identified.ref, identified.id) },
      )
    }
    if (currentReceipt?.closureId && currentReceipt.closureId !== managedClosure?.closure_id) {
      throw new Error('Issue close journal belongs to an earlier managed closure; reconcile that original request first.')
    }
    if (requiresDispatchLedger && !currentReceipt?.dispatch && !firstManagedPreparation) {
      throw new Error('Original Issue dispatch provenance is missing; retain the prepared closure and recover its original journal. No remote changes were attempted.')
    }
    if (currentReceipt && requiresDispatchLedger && !currentReceipt.dispatch) {
      throw new Error('Original Issue journal is missing dispatch provenance; do not downgrade it to legacy history.')
    }
    if (currentReceipt?.dispatch && (currentReceipt.closureId !== managedClosure?.closure_id
      || currentReceipt.dispatch.commentDigest !== createHash('sha256').update(comment ?? '').digest('hex'))) {
      throw new Error('Original Issue dispatch journal does not match this closure and comment.')
    }
    if (currentReceipt?.dispatch?.effects.some(effect => !effect.result)) {
      throw new Error('Original Issue effect result remains unknown; recover its original result without redispatch.')
    }

    const pendingArchive = store.listArchived().find(archived => archived.id === linkedTodo!.id)
    if (pendingArchive && currentReceipt?.state !== 'closed') {
      throw new Error(
        `Todo ${linkedTodo.id} has a pending archival unrelated to this issue_close operation. `
        + 'Retry todo_archive with the original confirmed selection before other updates.',
      )
    }

    if (!currentReceipt) {
      currentReceipt = {
        ...receiptIdentity,
        lifecycleRevision: linkedTodo.lifecycleRevision,
        state: 'pending',
        startedAt: new Date().toISOString(),
        ...(managedClosure ? {
          closureId: managedClosure.closure_id,
          ...(firstManagedPreparation ? {
            dispatch: { version: 1 as const, initializedAt: new Date().toISOString(),
              commentDigest: createHash('sha256').update(comment ?? '').digest('hex'), effects: [] },
          } : {}),
        } : {
          dispatch: { version: 1 as const, initializedAt: new Date().toISOString(), commentDigest, effects: [] },
        }),
      }
      try {
        store.transaction(() => {
          assertOwned?.()
          assertLinkedCurrent('before Issue operation admission')
          writeIssueCloseReceipt(receiptPath!, currentReceipt!)
          currentReceiptContent = JSON.stringify(currentReceipt, null, 2)
          ownsPlainInvocation = !managedClosure
        })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Could not persist the issue_close operation journal before GitHub work: ${message}. No remote changes were attempted.`)
      }
    }
    else if (!managedClosure) {
      store.transaction(() => {
        assertOwned?.()
        assertLinkedCurrent('before exact plain Issue retry admission')
        const snapshot = snapshotCurrentJournal()
        assertPlainIssueCloseRequest(snapshot.receipt, linkedTodo!.lifecycleRevision, commentDigest)
        if (snapshot.receipt.dispatch!.effects.some(effect => !effect.result || !effect.returnedAt)) {
          throw new Error('Original Issue effect result remains unknown; no retry admission is allowed.')
        }
        ownsPlainInvocation = true
      })
    }

    if (currentReceipt.state === 'closed') {
      remoteAlreadyClosed = true
    }
    else {
      const remoteIssue = await readRemote('issue', () => getIssue(owner, name, issueNumber))
      assertOwned?.()
      readResults.push({ kind: 'issue', returnedAt: new Date().toISOString(),
        state: remoteIssue.state.toLowerCase() as 'open' | 'closed' })
      accountPlainInterruption()
      if (remoteIssue.state.toLowerCase() === 'closed') {
        currentReceipt = {
          ...currentReceipt,
          state: 'closed',
          remoteClosedAt: new Date().toISOString(),
        }
        try {
          writeIssueCloseReceipt(receiptPath, currentReceipt)
          currentReceiptContent = JSON.stringify(currentReceipt, null, 2)
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(
            `GitHub issue #${issueNumber} is already closed, but the pending issue_close journal could not be confirmed: ${message}. `
            + `Retry issue_close with todo_item="${linkedTodo.id}"; the pending journal prevents another close call.`,
          )
        }
        remoteAlreadyClosed = true
      }
    }
  }
  else {
    const remoteIssue = await getIssue(owner, name, issueNumber)
    assertOwned?.()
    remoteAlreadyClosed = remoteIssue.state.toLowerCase() === 'closed'
  }

  const completeLinkedTodo = async (): Promise<string | undefined> => {
    if (!linkedTodo || !store) return undefined
    if (managedClosure) {
      if (!currentReceipt || currentReceipt.state !== 'closed') throw new Error('Remote close receipt is missing.')
      if (currentReceipt.dispatch?.effects.some(effect => !effect.result)) {
        throw new Error('Original Issue effects remain unknown; a closed Issue observation does not settle admitted requests.')
      }
      const receipt = new ExecutionArtifacts(contribDir, managedClosure.execution_id)
        .put(parseIssueCloseReceipt(currentReceipt, receiptIdentity!))
      recordClosureRemoteReceipt(managedClosure, receipt)
      const completed = await finalizeClosureWithReadback(managedClosure)
      return `Completed managed todo: ${completed.title} · ${completed.executions.at(-1)?.workflow?.closure?.mode} · not automatically archived · Todo ID: \`${completed.id}\``
    }
    return store.transaction(() => {
      const resolved = assertLinkedCurrent('before local completion')
      const completed = store.completeTodo(resolved.storeIndex, 'done', `Linked GitHub issue #${issueNumber} was closed.`)
      return completed ? `Done todo: ${completed.title} · not automatically archived · Todo ID: \`${completed.id}\`` : undefined
    })
  }

  let commentState: string | undefined
  const dispatchRemote = async <T>(kind: 'comment' | 'close', effect: () => Promise<T>): Promise<T> => {
    if (!store || !linkedTodo) return effect()
    const closure = managedClosure
    const dispatched = store.transaction(() => {
      assertLinkedCurrent('before Issue effect dispatch')
      if (closure) {
        const current = store.resolveItemById(closure.todo_id)?.item
        const execution = current && currentTodoExecution(current)
        if (execution?.id !== closure.execution_id || !execution.workflow
          || execution.workflow.closing_id !== closure.closure_id) throw new Error('Original managed closure changed before remote dispatch.')
        const pending = execution.workflow.closings.find(item => item.intent.id === closure.closure_id)
        if (pending?.state !== 'prepared') throw new Error('Original managed closure is not prepared for remote dispatch.')
        assertControlAllows(execution.workflow, { action: 'reserve_closure', intent: pending.intent })
      }
      if (currentReceipt?.dispatch) {
        snapshotCurrentJournal()
        if (currentReceipt.dispatch.effects.some(entry => entry.kind === kind || !entry.result)) {
          throw new Error('Original Issue effect was already admitted; recover its result without redispatch.')
        }
        const admitted = { ...currentReceipt, dispatch: { ...currentReceipt.dispatch,
          effects: [...currentReceipt.dispatch.effects, { kind, admittedAt: new Date().toISOString() }] } }
        writeIssueCloseReceipt(receiptPath!, admitted)
        currentReceipt = admitted
        currentReceiptContent = JSON.stringify(admitted, null, 2)
      }
      return { result: effect() }
    })
    const value = await dispatched.result
    assertOwned?.()
    // A stop fences new dispatch, not the durable recording of an admitted response.
    if (currentReceipt?.dispatch) {
      store.transaction(() => {
        assertOwned?.()
        snapshotCurrentJournal()
        const response = value as { id?: number; state?: string } | undefined
        const result = kind === 'comment'
          ? { kind, id: response?.id } : { kind, state: response?.state?.toLowerCase() }
        const returnedAt = new Date().toISOString()
        const returned = parseIssueCloseReceipt({ ...currentReceipt, dispatch: {
          ...currentReceipt!.dispatch!, effects: currentReceipt!.dispatch!.effects.map(entry =>
            entry.kind === kind ? { ...entry, returnedAt, result } : entry),
        }, ...(kind === 'close' && !closure ? { state: 'closed', remoteClosedAt: returnedAt } : {}) }, receiptIdentity!)
        writeIssueCloseReceipt(receiptPath!, returned)
        currentReceipt = returned
        currentReceiptContent = JSON.stringify(returned, null, 2)
      })
    }
    return value
  }
  if (!remoteAlreadyClosed && comment) {
    const digest = createHash('sha256')
      .update(`${owner}/${name}#${issueNumber}\0${linkedTodo?.id ?? ''}\0${comment}`)
      .digest('hex')
      .slice(0, 16)
    const marker = `<!-- contribbot:issue-close-comment ${digest} -->`
    const savedComment = currentReceipt?.dispatch?.effects.find(effect => effect.kind === 'comment')?.result
    if (savedComment?.kind === 'comment') {
      commentState = `Comment #${savedComment.id} was previously posted on #${issueNumber} (saved response; visibility not refreshed)`
    }
    else {
      const comments = await readRemote('comments', () => getIssueComments(owner, name, issueNumber))
      assertOwned?.()
      readResults.push({ kind: 'comments', returnedAt: new Date().toISOString(), commentIds: comments.map(item => item.id) })
      accountPlainInterruption()
      const existing = comments.find(item => item.body.includes(marker))
      if (existing) {
        commentState = `Comment #${existing.id} already existed on #${issueNumber}`
      }
      else {
        const posted = await dispatchRemote('comment', () => createComment(owner, name, issueNumber, `${comment}\n\n${marker}`))
        assertOwned?.()
        accountPlainInterruption()
        commentState = `Comment #${posted.id} was posted on #${issueNumber}`
      }
    }
    results.push(commentState)
  }

  if (remoteAlreadyClosed) {
    results.push(`GitHub issue #${issueNumber} was already closed (recorded or observed); skipped remote side effects.`)
  }
  else {
    try {
      await dispatchRemote('close', () => closeIssue(owner, name, issueNumber))
      assertOwned?.()
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!commentState) throw error
      throw new Error(
        `${commentState}, but GitHub issue #${issueNumber} could not be closed: ${message}. `
        + `Retry issue_close(issue_number=${issueNumber}, comment=${JSON.stringify(comment)}, ${linkedTodo ? `todo_item="${linkedTodo.id}", ` : ''}repo="${owner}/${name}"); the operation journal and comment marker prevent duplicate side effects.`,
      )
    }
    results.push(`Closed **${owner}/${name}#${issueNumber}**`)
    accountPlainInterruption()

    if (receiptPath && currentReceipt && currentReceipt.state !== 'closed') {
      try {
        currentReceipt = {
          ...currentReceipt,
          state: 'closed',
          remoteClosedAt: new Date().toISOString(),
        }
        writeIssueCloseReceipt(receiptPath, currentReceipt)
        currentReceiptContent = JSON.stringify(currentReceipt, null, 2)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(
          `GitHub issue #${issueNumber} was closed successfully, but its pending issue_close journal could not be confirmed: ${message}. `
          + `Retry issue_close with todo_item="${linkedTodo!.id}"; it will verify GitHub state before any close call.`,
        )
      }
    }
  }

  if (linkedTodo && store) {
    accountPlainInterruption()
    try {
      const completed = await completeLinkedTodo()
      if (completed) results.push(completed)
      if (receiptPath) rmSync(receiptPath, { force: true })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `GitHub issue #${issueNumber} was closed successfully, but local todo completion failed: ${message}. `
        + (managedClosure
          ? 'Retry the original issue_close request with its unchanged completion. To retain changed files, inspect the original request and use local reconcile-close after explicit user approval to continue locally. '
          : `Retry issue_close(issue_number=${issueNumber}, comment=${JSON.stringify(comment)}, todo_item="${linkedTodo.id}", repo="${owner}/${name}"); `)
        + 'the dedicated close journal makes the retry local-only.',
      )
    }
  }

  return results.join('\n')
}

export async function issueClose(
  issueNumber: number,
  comment?: string,
  todoItem?: string,
  repo?: string,
  completion?: LinkedClosure,
): Promise<string> {
  if (completion) {
    completion = completionSchema.parse(completion)
    if (!todoItem?.trim()) throw new Error('Managed completion requires an exact stable Todo identity; no GitHub changes were attempted.')
  }
  const { owner, name } = await resolveRepo(repo)
  const contribDir = getContribDir(owner, name)
  const lockDigest = issueCloseLockKey(owner, name, issueNumber)
  return withClaimLock(contribDir, lockDigest, async (assertOwned) => {
    assertOwned()
    return issueCloseLocked(owner, name, issueNumber, comment, todoItem, assertOwned, completion)
  })
}
