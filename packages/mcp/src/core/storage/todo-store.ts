import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parse, stringify } from 'yaml'
import { todayDate } from '../utils/format.js'
import { safeWriteFileSync } from '../utils/fs.js'
import { assertSafeTodoRef } from '../utils/todo-ref.js'
import { withTodoLock } from './todo-lock.js'
import { withWorkspaceTransition } from './workspace-occupancy.js'
import { RecordFiles } from './record-files.js'
import { assertRemoteEffectsSettled } from './remote-effects.js'
import { assertNoPendingIssueClose } from './issue-close-journal.js'
import type { AllowedIssueCloseJournal } from './issue-close-journal.js'
import { normalizeTodoPulls } from './todo-pulls.js'
import type { WorkflowState } from '../execution/contracts.js'
import { workflowRequestSchema } from '../execution/contracts.js'
import { activeControl, controlIsPaused, createWorkflow, transitionWorkflow, unresolvedOperations } from '../execution/workflow.js'
import {
  currentTodoExecution, isTerminalTodo, normalizeEvidence, normalizeTodo,
  requireNonEmpty, todoArrayFromDocument, validateTodoIds,
} from 'contribbot-core/todo/records'
import type { ArchivedTodoItem, TodoExecution, TodoExecutionProgress, TodoItem } from 'contribbot-core/todo/records'
export { currentTodoExecution, isTerminalTodo } from 'contribbot-core/todo/records'
export type { ArchivedTodoItem, TodoEvidence, TodoExecution, TodoExecutionProgress, TodoItem } from 'contribbot-core/todo/records'

export type { TodoType, TodoStatus, TodoDifficulty } from '../enums.js'
import {
  TODO_EXECUTION_OUTCOMES,
  TODO_EXECUTION_PHASES,
  TODO_STATUSES,
} from '../enums.js'
import type {
  TodoType,
  TodoStatus,
  TodoExecutionOutcome,
} from '../enums.js'

interface TodosFile {
  todos: TodoItem[]
}

function stableId(prefix: 't' | 'te'): string {
  return `${prefix}-${randomUUID()}`
}

function isTodoIdSelector(value: string): boolean {
  return /^t-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function nextLifecycleRevision(todo: TodoItem): number {
  const revision = todo.lifecycle_revision ?? 0
  if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Todo lifecycle revision exhausted; refusing to reuse archival approval.')
  return revision + 1
}

function archiveRetryComparable(todo: ArchivedTodoItem) {
  const { archived: _archived, updated: _updated, ...rest } = todo
  return rest
}

function restoredTodoFromArchive(todo: ArchivedTodoItem, status: TodoStatus = 'backlog'): TodoItem {
  const { archived: _archived, pending_transition: _pending, ...active } = todo
  return { ...active, status, updated: todayDate(), pending_transition: 'restore' }
}

function restorationComparable(todo: TodoItem) {
  const { updated: _updated, pending_transition: _pending, ...rest } = todo
  return rest
}

// Sort order: #N (by number) → slug (alphabetical, at Number.MAX_SAFE_INTEGER) → null (Infinity)
export function refSortKey(ref: string | null): number {
  if (!ref) return Infinity
  if (ref.startsWith('#')) {
    const num = Number.parseInt(ref.slice(1), 10)
    return Number.isNaN(num) ? Number.MAX_SAFE_INTEGER : num
  }
  return Number.MAX_SAFE_INTEGER
}

function compareRefs(a: string | null, b: string | null): number {
  const keyDiff = refSortKey(a) - refSortKey(b)
  if (keyDiff !== 0) return keyDiff
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

function statusGroup(status: TodoStatus): number {
  if (status === 'active') return 0
  if (status === 'idea' || status === 'backlog' || status === 'paused') return 1
  if (status === 'done') return 2
  return 3
}

export class TodoStore {
  private yamlPath: string
  private baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.yamlPath = join(baseDir, 'todos.yaml')
  }

  transaction<T>(run: () => T): T {
    return withTodoLock(this.baseDir, run)
  }

  applyWorkflow(todoId: string, executionId: string, requestInput: unknown): WorkflowState {
    return this.transaction(() => {
      const request = workflowRequestSchema.parse(requestInput)
      const todos = this.list()
      const todo = todos.find(item => item.id === todoId)
      if (!todo) throw new Error(`Todo not found: ${todoId}.`)
      this.assertNotPendingArchival(todo)
      if (todo.pending_transition) throw new Error('Reconcile pending Todo restoration first.')
      const execution = currentTodoExecution(todo)
      if (!execution || execution.id !== executionId) throw new Error('Todo execution changed or is no longer open.')
      if (!execution.workflow && !['propose_plan', 'request_control'].includes(request.command.action)) {
        throw new Error('Propose a plan to enter managed execution.')
      }
      const before = execution.workflow ?? createWorkflow()
      const next = transitionWorkflow(before, request)
      if (next.revision !== before.revision && [
        'settle_pause', 'resume_control', 'reserve_closure', 'prepare_closure', 'finish_closure', 'relocate_attempt',
      ].includes(request.command.action)) {
        assertRemoteEffectsSettled(this.baseDir, todo.id)
        const command = request.command
        const intent = command.action === 'reserve_closure' ? command.intent
          : (command.action === 'prepare_closure' || command.action === 'finish_closure')
            && before.closing_id === command.closure_id
            ? before.closings.find(closing => closing.intent.id === command.closure_id)?.intent
            : undefined
        let allowed: AllowedIssueCloseJournal | undefined
        // Only the exact managed Issue closure may account for its own retained journal.
        if (intent?.target.kind === 'issue') {
          const [owner, repo, extra] = intent.target.repo.split('/')
          if (owner && repo && extra === undefined) {
            allowed = {
              owner, repo, issueNumber: intent.target.issue_number, todoId, executionId,
              closureId: intent.id, lifecycleRevision: todo.lifecycle_revision ?? 0,
              commentDigest: intent.target.comment_digest,
            }
          }
        }
        assertNoPendingIssueClose(this.baseDir, todoId, allowed)
      }
      return withWorkspaceTransition({
        directory: this.baseDir, todoId, before, next, command: request.command,
        readStore: directory => new TodoStore(directory).listForOccupancy(),
      }, () => {
        if (next.revision === before.revision) {
          new RecordFiles(this.baseDir).projectWorkflow(todo, true)
          return next
        }
        execution.workflow = next
        execution.phase = next.closure ? 'finish' : !next.attempt_id ? 'understand' : next.yield ? 'check' : 'execute'
        const unknown = next.operations.filter(operation => operation.status === 'unknown')
        execution.blocked_on = unknown.length ? `Unknown operations: ${unknown.map(operation => operation.id).join(', ')}` : null
        execution.next = execution.blocked_on ?? (execution.phase === 'understand'
          ? 'Confirm the exact plan and bind a local workspace.'
          : execution.phase === 'check'
            ? 'Run outstanding acceptance checks against the yielded candidate.'
            : 'Continue the confirmed plan; reconcile returned work before yielding.')
        const plan = next.plans.find(plan => plan.id === next.plan_id)
        if (!next.closure && !execution.blocked_on && next.yield && plan?.content.completion_scope === 'stage') {
          execution.next = `Check this stage without completing the Todo. Remaining goals: ${plan.content.remaining_scope!.join('; ')}`
        }
        if (next.closure) {
          execution.closed_at = next.closure.at
          execution.outcome = next.closure.mode === 'stopped' ? 'abandoned' : 'done'
          execution.outcome_note = `${next.closure.mode}: ${next.closure.note}`
          execution.next = 'Execution closed. Archive only after a separate user decision.'
          todo.status = next.closure.mode === 'stopped' ? 'cancelled' : 'done'
        }
        else todo.status = controlIsPaused(next) ? 'paused' : 'active'
        const control = activeControl(next)
        if (control) {
          execution.blocked_on = `${control.kind} requested: ${control.id}${next.closing_id ? `; pending closure: ${next.closing_id}` : ''}`
          execution.next = controlIsPaused(next)
            ? 'Paused. Continue only after an explicit user decision and local workspace reinspection.'
            : 'Stop requested, not settled. Do not dispatch new work; recover and account for existing operations before settlement.'
        }
        todo.updated = todayDate()
        this.save(todos)
        return next
      })
    })
  }

  list(): TodoItem[] {
    if (!existsSync(this.yamlPath)) return []
    const content = readFileSync(this.yamlPath, 'utf-8')
    const todos = todoArrayFromDocument(parse(content), 'todos.yaml').map(item => normalizeTodo(item as TodoItem))
    validateTodoIds(todos)
    return todos
  }

  listSorted(): TodoItem[] {
    const todos = this.list()
    return [...todos].sort((a, b) => compareRefs(a.ref, b.ref) || a.title.localeCompare(b.title))
  }

  private listForOccupancy(): TodoItem[] {
    const data: unknown = parse(readFileSync(this.yamlPath, 'utf8'))
    if (!data || typeof data !== 'object' || !Array.isArray((data as TodosFile).todos)) {
      throw new Error('Registered Todo snapshot must contain a todos array.')
    }
    const todos = (data as TodosFile).todos.map(normalizeTodo)
    validateTodoIds(todos)
    return todos
  }

  recordProjection(todo: TodoItem) {
    return new RecordFiles(this.baseDir).projectWorkflow(todo)
  }

  refreshRecord(todoId: string) {
    return this.transaction(() => {
      const todo = this.resolveItemFromAll(todoId)
      if (!todo || todo.id !== todoId) throw new Error('Exact stable Todo id required to refresh its document.')
      return new RecordFiles(this.baseDir).projectWorkflow(todo, true)
    })
  }

  /**
   * Stable order shared by todo_list and numeric item resolution.
   * Active work is shown first, then backlog/ideas/paused, done and cancelled.
   */
  listForDisplay(): TodoItem[] {
    return this.displayEntries(true).map(({ item }) => item)
  }

  get(index: number): TodoItem | undefined {
    return this.list()[index]
  }

  findByText(text: string): TodoItem | undefined {
    return this.list().find(t => t.title.toLowerCase().includes(text.toLowerCase()))
  }

  findByRef(ref: string): TodoItem | undefined {
    const normalized = ref.trim().toLowerCase()
    if (!normalized) return undefined
    return this.list().find(todo => todo.ref?.toLowerCase() === normalized)
  }

  hasArchivedRef(ref: string, exceptTodoId?: string): boolean {
    const normalized = ref.trim().toLowerCase()
    if (!normalized) return false
    return this.listArchived().some(todo =>
      todo.ref?.toLowerCase() === normalized
      && (!exceptTodoId || todo.id !== exceptTodoId),
    )
  }

  private pendingArchiveFor(todo: TodoItem): ArchivedTodoItem | undefined {
    if (!todo.id) return undefined
    return this.listArchived().find(archived => archived.id === todo.id)
  }

  private assertNotPendingArchival(todo: TodoItem): void {
    if (todo.pending_transition === 'restore') return
    const pending = this.pendingArchiveFor(todo)
    if (pending) {
      throw new Error(`Todo id ${todo.id} has a pending archival. Retry todo_archive with its original confirmed selection before other updates.`)
    }
  }

  private displayEntries(includeClosed: boolean): Array<{ storeIndex: number; item: TodoItem }> {
    const allTodos = this.list()
    return allTodos
      .map((item, storeIndex) => ({ storeIndex, item }))
      .filter(({ item }) => includeClosed || !isTerminalTodo(item))
      .sort((a, b) =>
        statusGroup(a.item.status) - statusGroup(b.item.status)
        || compareRefs(a.item.ref, b.item.ref)
        || a.item.title.localeCompare(b.item.title),
      )
  }

  private resolveFromEntries(
    query: string,
    entries: Array<{ storeIndex: number; item: TodoItem }>,
  ): { storeIndex: number; item: TodoItem } | undefined {
    const normalized = query.trim().toLowerCase()
    if (!normalized || entries.length === 0) return undefined

    // Explicit custom refs and #issue refs are unambiguous and take precedence.
    const exactId = entries.find(({ item }) => item.id?.toLowerCase() === normalized)
    if (exactId) return exactId
    if (isTodoIdSelector(normalized)) return undefined

    const exactRef = entries.find(({ item }) => item.ref?.toLowerCase() === normalized)
    if (exactRef) return exactRef

    // Preserve numeric index compatibility, but require the whole query to be numeric.
    if (/^\d+$/.test(normalized)) {
      const index = Number.parseInt(normalized, 10)
      if (index >= 1 && index <= entries.length) return entries[index - 1]

      // A number outside the visible index range can still identify issue ref #N.
      const numericRef = entries.find(({ item }) => item.ref?.toLowerCase() === `#${normalized}`)
      if (numericRef) return numericRef
    }

    const exactTitle = entries.find(({ item }) => item.title.trim().toLowerCase() === normalized)
    if (exactTitle) return exactTitle

    return entries.find(({ item }) => item.title.toLowerCase().includes(normalized))
  }

  /**
   * Resolve an open item by exact ref, display index, exact title, or title substring.
   * Returns the original storage index so callers can safely update/delete the item.
   */
  resolveItem(query: string): { storeIndex: number; item: TodoItem } | undefined {
    const resolved = this.resolveFromEntries(query, this.displayEntries(false))
    if (resolved?.item.pending_transition === 'restore') {
      throw new Error(`Todo id ${resolved.item.id} has a pending archive restoration. Retry todo_activate to reconcile it before other updates.`)
    }
    if (resolved) this.assertNotPendingArchival(resolved.item)
    return resolved
  }

  resolveItemById(id: string): { storeIndex: number; item: TodoItem } | undefined {
    const normalized = id.trim().toLowerCase()
    if (!normalized) return undefined
    const todos = this.list()
    const storeIndex = todos.findIndex(item => item.id?.toLowerCase() === normalized)
    if (storeIndex < 0) return undefined
    const item = todos[storeIndex]!
    if (item.pending_transition === 'restore') {
      throw new Error(`Todo id ${item.id} has a pending archive restoration. Retry todo_activate to reconcile it before other updates.`)
    }
    this.assertNotPendingArchival(item)
    return { storeIndex, item }
  }

  resolveItemForArchival(query: string): { storeIndex: number; item: TodoItem } | undefined {
    const resolved = this.resolveFromEntries(query, this.displayEntries(true))
    if (resolved?.item.pending_transition === 'restore') {
      throw new Error(`Todo id ${resolved.item.id} has a pending archive restoration. Retry todo_activate to reconcile it before archival.`)
    }
    return resolved
  }

  resolveItemByIdForArchival(id: string): { storeIndex: number; item: TodoItem } | undefined {
    const normalized = id.trim().toLowerCase()
    if (!normalized) return undefined
    const todos = this.list()
    const storeIndex = todos.findIndex(item => item.id?.toLowerCase() === normalized)
    if (storeIndex < 0) return undefined
    const item = todos[storeIndex]!
    if (item.pending_transition === 'restore') {
      throw new Error(`Todo id ${item.id} has a pending archive restoration. Retry todo_activate to reconcile it before archival.`)
    }
    return { storeIndex, item }
  }

  resolveItemForActivation(query: string): { storeIndex: number; item: TodoItem; restored: boolean } | undefined {
    return this.transaction(() => this.resolveItemForActivationUnlocked(query))
  }

  private resolveItemForActivationUnlocked(query: string): { storeIndex: number; item: TodoItem; restored: boolean } | undefined {
    const active = this.resolveFromEntries(query, this.displayEntries(false))
    if (active) this.assertNotPendingArchival(active.item)

    const restoredById = this.restoreArchivedForActivation(query)
    if (restoredById) return { ...restoredById, restored: true }

    const closed = this.list().find(todo => todo.id?.toLowerCase() === query.trim().toLowerCase() && isTerminalTodo(todo))
    if (closed?.id) {
      const reopened = this.reopen(closed.id)
      return { ...reopened, restored: false }
    }

    const resolved = this.resolveFromEntries(query, this.displayEntries(false))
    if (!resolved) return undefined
    if (!resolved.item.id) return { ...resolved, restored: false }

    const reconciled = this.restoreArchivedForActivation(resolved.item.id)
    return reconciled ? { ...reconciled, restored: true } : { ...resolved, restored: false }
  }

  /**
   * Resolve an item from all todos (including done), sorted by ref.
   * Used by todoDetail which needs to find done items too.
   */
  resolveItemFromAll(query: string): TodoItem | undefined {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return undefined

    const activeEntries = this.displayEntries(true)
    const exactActiveId = activeEntries.find(({ item }) => item.id?.toLowerCase() === normalized)
    if (exactActiveId) return exactActiveId.item

    const archived = this.listArchived()
    const exactArchivedId = archived.find(todo => todo.id?.toLowerCase() === normalized)
    if (exactArchivedId) return exactArchivedId
    if (isTodoIdSelector(normalized)) return undefined

    const active = this.resolveFromEntries(query, activeEntries)?.item
    if (active) return active
    return this.resolveArchivedItem(query, archived)
  }

  private resolveArchivedItem(query: string, archived = this.listArchived()): ArchivedTodoItem | undefined {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return undefined

    const exactId = archived.find(todo => todo.id?.toLowerCase() === normalized)
    if (exactId) return exactId
    if (isTodoIdSelector(normalized)) return undefined

    const requireUnique = (matches: ArchivedTodoItem[]): ArchivedTodoItem | undefined => {
      if (matches.length <= 1) return matches[0]
      const ids = matches.map(todo => todo.id ?? '(legacy todo without id)').join(', ')
      throw new Error(`Multiple archived todos match "${query}". Use a stable todo id: ${ids}`)
    }

    const exactRef = requireUnique(archived.filter(todo => todo.ref?.toLowerCase() === normalized))
    if (exactRef) return exactRef

    if (/^\d+$/.test(normalized)) {
      const numericRef = requireUnique(archived.filter(todo => todo.ref?.toLowerCase() === `#${normalized}`))
      if (numericRef) return numericRef
    }

    const exactTitle = requireUnique(archived.filter(todo => todo.title.trim().toLowerCase() === normalized))
    if (exactTitle) return exactTitle
    return requireUnique(archived.filter(todo => todo.title.toLowerCase().includes(normalized)))
  }

  /**
   * Restore an archived Todo only when addressed by its exact stable id.
   * Active data is written first; a failed archive removal is reconciled on retry.
   */
  restoreArchivedForActivation(query: string): { storeIndex: number; item: TodoItem } | undefined {
    return this.transaction(() => {
      const restored = this.restoreArchivedUnlocked(query, true)
      if (restored && isTerminalTodo(restored.item)) return this.reopen(restored.item.id!)
      return restored
    })
  }

  restoreArchived(query: string): { storeIndex: number; item: TodoItem } | undefined {
    return this.transaction(() => this.restoreArchivedUnlocked(query, false))
  }

  private restoreArchivedUnlocked(query: string, reopen: boolean): { storeIndex: number; item: TodoItem } | undefined {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return undefined

    const archived = this.listArchived()
    const archiveIndex = archived.findIndex(todo => todo.id?.toLowerCase() === normalized)
    const todos = this.list()
    if (archiveIndex < 0) {
      const pendingIndex = todos.findIndex(todo => todo.id?.toLowerCase() === normalized && todo.pending_transition === 'restore')
      if (pendingIndex < 0) return undefined
      const pending = todos[pendingIndex]!
      pending.lifecycle_revision ??= nextLifecycleRevision(pending)
      delete pending.pending_transition
      pending.updated = todayDate()
      this.save(todos)
      return { storeIndex: pendingIndex, item: pending }
    }

    const archivedTodo = archived[archiveIndex]!
    const pendingRestore = todos.find(todo => todo.id === archivedTodo.id && todo.pending_transition === 'restore')
    const restoreStatus = pendingRestore?.status ?? (reopen ? 'backlog' : archivedTodo.status)
    if (restoreStatus !== archivedTodo.status && restoreStatus !== 'backlog') {
      throw new Error('Pending restoration has a conflicting target status.')
    }
    const restored = restoredTodoFromArchive(archivedTodo, restoreStatus)
    const legacyRestore = pendingRestore
      && pendingRestore.lifecycle_revision === undefined && archivedTodo.lifecycle_revision === undefined
    if (!legacyRestore) {
      restored.lifecycle_revision = nextLifecycleRevision(archivedTodo)
      if (pendingRestore && pendingRestore.lifecycle_revision !== restored.lifecycle_revision) {
        throw new Error('Pending restoration has a conflicting lifecycle revision.')
      }
    }
    const refOwner = archivedTodo.ref
      ? todos.find(todo => todo.id !== archivedTodo.id && todo.ref?.toLowerCase() === archivedTodo.ref!.toLowerCase())
      : undefined
    if (refOwner) {
      throw new Error(`Cannot restore todo id ${archivedTodo.id}: ref "${archivedTodo.ref}" already belongs to active todo ${refOwner.id ?? refOwner.title}.`)
    }
    let storeIndex = todos.findIndex(todo => todo.id?.toLowerCase() === normalized)

    if (storeIndex >= 0) {
      const active = todos[storeIndex]!
      if (active.pending_transition !== 'restore' || !isDeepStrictEqual(restorationComparable(active), restorationComparable(restored))) {
        throw new Error(`Todo id ${archivedTodo.id} exists in active and archived data with different content. Resolve the conflict manually.`)
      }
      if (legacyRestore) {
        // Upgrade only this pending move before removing its archived source.
        active.lifecycle_revision = nextLifecycleRevision(archivedTodo)
        this.save(todos)
      }
    }
    else {
      todos.push(restored)
      this.save(todos)
      storeIndex = todos.length - 1
    }

    archived.splice(archiveIndex, 1)
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    safeWriteFileSync(this.archiveWritePath, stringify({ todos: archived }))

    const active = todos[storeIndex]!
    delete active.pending_transition
    active.updated = todayDate()
    this.save(todos)

    return { storeIndex, item: active }
  }

  ensureTodoId(index: number): TodoItem | undefined {
    return this.transaction(() => this.ensureTodoIdUnlocked(index))
  }

  private ensureTodoIdUnlocked(index: number): TodoItem | undefined {
    const todos = this.list()
    const todo = todos[index]
    if (!todo) return undefined
    if (!todo.id) {
      todo.id = stableId('t')
      todo.updated = todayDate()
      this.save(todos)
    }
    return todo
  }

  add(input: { ref: string | null; title: string; type: TodoType }): TodoItem {
    return this.transaction(() => this.addUnlocked(input))
  }

  private addUnlocked(input: { ref: string | null; title: string; type: TodoType }): TodoItem {
    const today = todayDate()
    const todos = this.list()
    if (input.ref) {
      assertSafeTodoRef(input.ref)
      const normalizedRef = input.ref.toLowerCase()
      const existing = todos.find(todo => todo.ref?.toLowerCase() === normalizedRef)
      if (existing) {
        throw new Error(`Todo ref already exists: ${existing.ref} belongs to ${existing.id ?? existing.title}.`)
      }
    }
    const item: TodoItem = {
      id: stableId('t'),
      ref: input.ref,
      title: input.title,
      type: input.type,
      status: 'idea',
      difficulty: null,
      pr: null,
      branch: null,
      claimed_items: null,
      created: today,
      updated: today,
      executions: [],
    }
    todos.push(item)
    this.save(todos)
    return item
  }

  update(
    index: number,
    fields: Partial<Pick<TodoItem, 'status' | 'difficulty' | 'pr' | 'pull_requests' | 'branch' | 'title' | 'type' | 'claimed_items'>>,
  ): TodoItem | undefined {
    return this.transaction(() => this.updateUnlocked(index, fields))
  }

  private updateUnlocked(index: number, fields: Parameters<TodoStore['update']>[1]): TodoItem | undefined {
    if (fields.status !== undefined && !TODO_STATUSES.includes(fields.status)) {
      throw new Error(`Unsupported Todo status: "${String(fields.status)}".`)
    }
    const todos = this.list()
    const todo = todos[index]
    if (index < 0 || index >= todos.length || !todo) return undefined
    this.assertNotPendingArchival(todo)
    if (fields.status !== undefined && ['done', 'cancelled', 'paused'].includes(fields.status)) {
      assertRemoteEffectsSettled(this.baseDir, todo.id)
    }
    const workflow = currentTodoExecution(todo)?.workflow
    if (fields.status === 'paused' || fields.status === 'cancelled'
      || (fields.status !== undefined && workflow && activeControl(workflow))) {
      throw new Error('Use the control request and safe settlement path; generic status updates cannot bypass pause/cancellation.')
    }
    if (isTerminalTodo(todo) && fields.status !== undefined && fields.status !== todo.status) {
      throw new Error('Reopen the terminal Todo explicitly before changing its status.')
    }
    if (currentTodoExecution(todo)?.workflow && fields.status === 'done') {
      throw new Error('Managed execution requires verified closure or an explicit unverified outcome.')
    }
    const today = todayDate()
    if (fields.status !== undefined) todo.status = fields.status
    if (fields.difficulty !== undefined) todo.difficulty = fields.difficulty
    if (fields.pr !== undefined) todo.pr = fields.pr
    if (fields.pull_requests !== undefined) todo.pull_requests = normalizeTodoPulls(fields.pull_requests)
    if (fields.branch !== undefined) todo.branch = fields.branch
    if (fields.title !== undefined) todo.title = fields.title
    if (fields.type !== undefined) todo.type = fields.type
    if (fields.claimed_items !== undefined) todo.claimed_items = fields.claimed_items
    todo.updated = today
    this.save(todos)
    return todo
  }

  delete(index: number, options: { force?: boolean } = {}): TodoItem | undefined {
    return this.transaction(() => this.deleteUnlocked(index, options))
  }

  private deleteUnlocked(index: number, options: { force?: boolean }): TodoItem | undefined {
    const todos = this.list()
    if (index < 0 || index >= todos.length) return undefined
    const todo = todos[index]!
    assertRemoteEffectsSettled(this.baseDir, todo.id)
    this.assertNotPendingArchival(todo)
    if (currentTodoExecution(todo)?.workflow) {
      throw new Error('Managed execution must be safely closed before deleting its history.')
    }
    if (todo.executions.length > 0 && !options.force) {
      throw new Error(`Todo "${todo.ref ?? todo.title}" has execution history. Pass force=true only after explicit confirmation.`)
    }
    const [removed] = todos.splice(index, 1)
    this.save(todos)
    return removed
  }

  activateExecution(
    index: number,
    input: { goal?: string; next?: string } = {},
  ): { item: TodoItem; execution: TodoExecution; created: boolean } {
    return this.transaction(() => this.activateExecutionUnlocked(index, input))
  }

  private activateExecutionUnlocked(
    index: number, input: { goal?: string; next?: string },
  ): { item: TodoItem; execution: TodoExecution; created: boolean } {
    const todos = this.list()
    const todo = todos[index]
    if (index < 0 || index >= todos.length || !todo) throw new Error(`Todo not found at index ${index}.`)
    this.assertNotPendingArchival(todo)
    assertRemoteEffectsSettled(this.baseDir, todo.id)
    if (isTerminalTodo(todo)) throw new Error('Reopen the terminal Todo before starting a new execution.')

    const existing = currentTodoExecution(todo)
    if (existing?.workflow && activeControl(existing.workflow)) {
      throw new Error('A control request is active. Inspect it and use explicit local continuation after safe settlement.')
    }
    if (existing) {
      if (!todo.id) {
        todo.id = stableId('t')
        todo.updated = todayDate()
        this.save(todos)
      }
      return { item: todo, execution: existing, created: false }
    }

    todo.id ??= stableId('t')
    const now = new Date().toISOString()
    const execution: TodoExecution = {
      id: stableId('te'),
      goal: input.goal?.trim() || todo.title,
      phase: 'understand',
      next: input.next?.trim() || 'Review context and confirm the implementation plan.',
      blocked_on: null,
      evidence: [],
      opened_at: now,
      closed_at: null,
      outcome: null,
      outcome_note: '',
    }
    todo.executions.push(execution)
    todo.updated = todayDate()
    this.save(todos)
    return { item: todo, execution, created: true }
  }

  progressExecution(index: number, fields: TodoExecutionProgress): TodoExecution {
    return this.transaction(() => this.progressExecutionUnlocked(index, fields))
  }

  private progressExecutionUnlocked(index: number, fields: TodoExecutionProgress): TodoExecution {
    const todos = this.list()
    const todo = todos[index]
    if (index < 0 || index >= todos.length || !todo) throw new Error(`Todo not found at index ${index}.`)
    const execution = currentTodoExecution(todo)
    if (!execution) throw new Error(`Todo "${todo.ref ?? todo.title}" has no open execution. Use todo_activate first.`)
    if (execution.workflow && fields.phase !== undefined) {
      throw new Error('Managed execution phase is derived from its workflow, not manually assigned.')
    }

    if (fields.phase !== undefined) {
      if (!TODO_EXECUTION_PHASES.includes(fields.phase)) throw new Error(`Invalid execution phase: "${fields.phase}".`)
      execution.phase = fields.phase
    }
    if (fields.next !== undefined) execution.next = requireNonEmpty(fields.next, 'Execution next')
    if ('blocked_on' in fields) {
      execution.blocked_on = fields.blocked_on == null ? null : requireNonEmpty(fields.blocked_on, 'Execution blocked_on')
    }
    if (fields.evidence !== undefined) {
      if (!Array.isArray(fields.evidence)) throw new Error('Execution evidence must be an array.')
      execution.evidence.push(...fields.evidence.map((item, evidenceIndex) => normalizeEvidence(item, execution.id, execution.evidence.length + evidenceIndex)))
    }
    if (fields.phase === undefined && fields.next === undefined && !('blocked_on' in fields) && fields.evidence === undefined) {
      throw new Error('No execution progress fields were provided.')
    }

    todo.updated = todayDate()
    this.save(todos)
    return execution
  }

  closeExecution(index: number, outcome: TodoExecutionOutcome, outcomeNote = ''): TodoExecution | undefined {
    return this.transaction(() => this.closeExecutionUnlocked(index, outcome, outcomeNote))
  }

  completeTodo(index: number, outcome: 'done' | 'abandoned', note: string): TodoItem | undefined {
    if (outcome !== 'done') throw new Error('Use cancelTodo with an explicit cancellation decision and lifecycle revision.')
    return this.transaction(() => {
      const todos = this.list()
      const todo = todos[index]
      if (!todo) return undefined
      assertRemoteEffectsSettled(this.baseDir, todo.id)
      if (todo.pending_transition === 'restore') throw new Error('Reconcile pending archive restoration first.')
      const status = 'done'
      if (currentTodoExecution(todo)?.workflow
        || todo.executions.at(-1)?.workflow) {
        throw new Error('Managed execution requires its original explicit completion or a new execution after reopening.')
      }
      this.assertNotPendingArchival(todo)
      if (isTerminalTodo(todo)) {
        if (todo.status !== status || currentTodoExecution(todo)) throw new Error('Terminal outcome conflicts; reconcile or reopen explicitly.')
        this.recordProjection(todo)
        return todo
      }
      todo.id ??= stableId('t')
      const execution = this.closeOpenExecution(todo, outcome, note)
      if (execution) {
        execution.next = 'Execution closed. Archive only after a separate user decision.'
        execution.blocked_on = null
      }
      todo.status = status
      todo.updated = todayDate()
      this.save(todos)
      return todo
    })
  }

  cancelTodo(todoId: string, expectedLifecycleRevision: number, decisionInput: string): TodoItem {
    const decision = requireNonEmpty(decisionInput, 'Cancellation decision')
    if (!Number.isSafeInteger(expectedLifecycleRevision) || expectedLifecycleRevision < 0) {
      throw new Error('Expected lifecycle revision must be a nonnegative safe integer.')
    }
    return this.transaction(() => {
      const todos = this.list()
      const todo = todos.find(item => item.id === todoId)
      if (!todo) throw new Error('Exact stable Todo id required to cancel.')
      if ((todo.lifecycle_revision ?? 0) !== expectedLifecycleRevision) {
        throw new Error('Todo lifecycle revision changed; inspect it and obtain a new cancellation decision.')
      }
      this.assertNotPendingArchival(todo)
      if (todo.pending_transition) throw new Error('Reconcile pending Todo restoration before cancellation.')
      assertRemoteEffectsSettled(this.baseDir, todo.id)
      assertNoPendingIssueClose(this.baseDir, todoId)
      if (todo.executions.some(execution => execution.workflow
        && (!execution.workflow.closure || execution.workflow.closing_id || unresolvedOperations(execution.workflow).length))) {
        throw new Error('Managed execution requires todo_control and its safe stopped completion.')
      }
      if (todo.status === 'cancelled') {
        if (todo.last_cancellation?.lifecycle_revision !== expectedLifecycleRevision
          || todo.last_cancellation.decision !== decision) {
          throw new Error('Todo was cancelled by another decision; the original cancellation is unchanged.')
        }
        return todo
      }
      if (todo.status === 'done') throw new Error('Reopen the completed Todo before cancelling it.')
      const execution = this.closeOpenExecution(todo, 'abandoned', decision)
      if (execution) {
        execution.next = 'Execution cancelled. Archive only after a separate user decision.'
        execution.blocked_on = null
      }
      todo.status = 'cancelled'
      todo.last_cancellation = { decision, at: new Date().toISOString(), lifecycle_revision: expectedLifecycleRevision }
      todo.updated = todayDate()
      this.save(todos)
      return todo
    })
  }

  reopen(todoId: string): { storeIndex: number; item: TodoItem } {
    return this.transaction(() => {
      if (this.resolveItemFromAll(todoId)?.id !== todoId) throw new Error('Exact stable Todo id required to reopen.')
      assertRemoteEffectsSettled(this.baseDir, todoId)
      const restored = this.restoreArchivedForActivation(todoId)
      if (restored) return restored
      const resolved = this.resolveItemById(todoId)
      if (!resolved || resolved.item.id !== todoId) throw new Error('Exact stable Todo id required to reopen.')
      const todos = this.list()
      const todo = todos[resolved.storeIndex]!
      if (currentTodoExecution(todo)) throw new Error('Todo already has an open execution; resume it instead of reopening.')
      if (!isTerminalTodo(todo) && todo.status !== 'backlog') throw new Error('Only a terminal Todo can be reopened.')
      if (todo.status !== 'backlog') {
        todo.lifecycle_revision = nextLifecycleRevision(todo)
        todo.status = 'backlog'
        todo.updated = todayDate()
        this.save(todos)
      }
      return { storeIndex: resolved.storeIndex, item: todo }
    })
  }

  private closeExecutionUnlocked(index: number, outcome: TodoExecutionOutcome, outcomeNote: string): TodoExecution | undefined {
    const todos = this.list()
    const todo = todos[index]
    if (index < 0 || index >= todos.length || !todo) return undefined
    this.assertNotPendingArchival(todo)
    const execution = this.closeOpenExecution(todo, outcome, outcomeNote)
    if (!execution) return undefined
    todo.updated = todayDate()
    this.save(todos)
    return execution
  }

  private closeOpenExecution(todo: TodoItem, outcome: TodoExecutionOutcome, outcomeNote: string): TodoExecution | undefined {
    assertRemoteEffectsSettled(this.baseDir, todo.id)
    if (!TODO_EXECUTION_OUTCOMES.includes(outcome)) throw new Error(`Invalid execution outcome: "${outcome}".`)
    const execution = currentTodoExecution(todo)
    if (!execution) return undefined
    if (execution.workflow) {
      throw new Error('Managed execution requires the unified closure gate; legacy completion cannot bypass verification.')
    }
    execution.phase = 'finish'
    execution.closed_at = new Date().toISOString()
    execution.outcome = outcome
    execution.outcome_note = outcomeNote.trim()
    return execution
  }

  private get archiveWritePath(): string {
    return join(this.baseDir, 'todos.archive.yaml')
  }

  private get archiveReadPath(): string | undefined {
    if (existsSync(this.archiveWritePath)) return this.archiveWritePath
    const legacyPath = join(this.baseDir, 'archive.yaml')
    return existsSync(legacyPath) ? legacyPath : undefined
  }

  /**
   * Archive a todo: append to todos.archive.yaml, then delete from todos.yaml.
   * Callers must complete or cancel first and explicitly select a terminal item.
   * Returns the archived item or undefined if index is invalid.
   */
  archiveAndDelete(index: number): ArchivedTodoItem | undefined {
    return this.transaction(() => this.archiveAndDeleteUnlocked(index))
  }

  private archiveAndDeleteUnlocked(index: number): ArchivedTodoItem | undefined {
    const todos = this.list()
    const todo = todos[index]
    if (index < 0 || index >= todos.length || !todo) return undefined
    assertRemoteEffectsSettled(this.baseDir, todo.id)
    const today = todayDate()

    if (currentTodoExecution(todo)) {
      throw new Error(`Cannot archive todo "${todo.ref ?? todo.title}" with an open execution.`)
    }
    if (!isTerminalTodo(todo)) throw new Error('Only an already terminal Todo can be archived.')

    if (!todo.id) {
      todo.id = stableId('t')
      todo.updated = today
      this.save(todos)
      return this.archiveAndDelete(index)
    }

    let archivedItem: ArchivedTodoItem = { ...todo, archived: today }
    delete archivedItem.pending_transition

    const archiveReadPath = this.archiveReadPath
    let archived: ArchivedTodoItem[] = []
    if (archiveReadPath) {
      const content = readFileSync(archiveReadPath, 'utf-8')
      archived = todoArrayFromDocument(parse(content), 'todos.archive.yaml')
        .map(item => ({ ...normalizeTodo(item as ArchivedTodoItem), archived: (item as ArchivedTodoItem).archived }))
      validateTodoIds(archived)
    }

    let shouldWriteArchive = archiveReadPath !== this.archiveWritePath
    const existing = archived.find(item => item.id === archivedItem.id)
    if (existing) {
      if (!isDeepStrictEqual(
        archiveRetryComparable(existing),
        archiveRetryComparable(archivedItem),
      )) {
        throw new Error(`Archive already contains todo id ${archivedItem.id} with different content. Resolve the conflict manually.`)
      }
      archivedItem = existing
    }
    else {
      archived.push(archivedItem)
      validateTodoIds(archived)
      shouldWriteArchive = true
    }

    if (shouldWriteArchive) {
      if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
      safeWriteFileSync(this.archiveWritePath, stringify({ todos: archived }))
    }
    new RecordFiles(this.baseDir).projectWorkflow(archivedItem, true)

    // Delete from active only after archive write succeeds.
    todos.splice(index, 1)
    this.save(todos)

    return archivedItem
  }

  listArchived(): ArchivedTodoItem[] {
    const archiveReadPath = this.archiveReadPath
    if (!archiveReadPath) return []
    const content = readFileSync(archiveReadPath, 'utf-8')
    const todos = todoArrayFromDocument(parse(content), 'todos.archive.yaml')
      .map(item => ({ ...normalizeTodo(item as ArchivedTodoItem), archived: (item as ArchivedTodoItem).archived }))
    validateTodoIds(todos)
    return todos
  }

  /**
   * Compact archive: remove old entries by date or keep count.
   * Exactly one of `before` or `keep` must be provided.
   */
  compact(options: { before?: string; keep?: number; force?: boolean }): { removed: number; remaining: number } {
    return this.transaction(() => this.compactUnlocked(options))
  }

  private compactUnlocked(options: Parameters<TodoStore['compact']>[0]): { removed: number; remaining: number } {
    const archived = this.listArchived()
    if (archived.length === 0) return { removed: 0, remaining: 0 }
    if (options.before && options.keep !== undefined) throw new Error('Cannot use both "before" and "keep".')

    let kept: ArchivedTodoItem[]

    if (options.before) {
      kept = archived.filter(t => t.archived >= options.before!)
    } else if (options.keep !== undefined) {
      kept = options.keep === 0 ? [] : archived.slice(-options.keep)
    } else {
      throw new Error('Exactly one of "before" or "keep" must be provided.')
    }

    const removedItems = archived.filter(todo => !kept.includes(todo))
    if (!options.force && removedItems.some(todo => todo.executions.length > 0)) {
      throw new Error('Archive compaction would remove Todo execution history. Pass force=true only after explicit confirmation.')
    }

    const removed = removedItems.length
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    safeWriteFileSync(this.archiveWritePath, stringify({ todos: kept }))
    return { removed, remaining: kept.length }
  }

  private save(todos: TodoItem[]): void {
    const previous = new Map(this.list().map(todo => [todo.id, todo]))
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    const normalized = todos.map(normalizeTodo)
    validateTodoIds(normalized)
    const data: TodosFile = { todos: normalized }
    safeWriteFileSync(this.yamlPath, stringify(data))
    for (const todo of normalized) {
      if (!isDeepStrictEqual(previous.get(todo.id), todo)) {
        new RecordFiles(this.baseDir).projectWorkflow(todo, true)
      }
    }
  }
}
