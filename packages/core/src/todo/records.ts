import type { WorkflowState } from '../execution/contracts.js'
import { normalizeWorkflow } from '../execution/workflow.js'
import { TODO_EVIDENCE_SOURCES, TODO_EXECUTION_OUTCOMES, TODO_EXECUTION_PHASES, TODO_STATUSES } from './enums.js'
import type { TodoType, TodoStatus, TodoDifficulty, TodoEvidenceSource, TodoExecutionOutcome, TodoExecutionPhase } from './enums.js'
import { normalizeTodoPulls } from './pulls.js'
import type { TodoPull } from './pulls.js'

export interface TodoEvidence {
  source: TodoEvidenceSource
  locator: string
  observed_at: string
  digest: string
  revision?: string
  note?: string
}

export interface TodoExecution {
  id: string
  goal: string
  phase: TodoExecutionPhase
  next: string
  blocked_on: string | null
  evidence: TodoEvidence[]
  opened_at: string
  closed_at: string | null
  outcome: TodoExecutionOutcome | null
  outcome_note: string
  workflow?: WorkflowState
}

export interface TodoItem {
  id?: string
  ref: string | null
  title: string
  type: TodoType
  status: TodoStatus
  difficulty: TodoDifficulty | null
  pr: number | null
  pull_requests?: TodoPull[]
  branch: string | null
  claimed_items: string[] | null
  created: string
  updated: string
  executions: TodoExecution[]
  pending_transition?: 'restore'
  lifecycle_revision?: number
  last_cancellation?: { decision: string; at: string; lifecycle_revision: number }
}

export interface ArchivedTodoItem extends TodoItem {
  archived: string
}

export interface TodoExecutionProgress {
  phase?: TodoExecutionPhase
  next?: string
  blocked_on?: string | null
  evidence?: TodoEvidence[]
}

export function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`)
  return value.trim()
}

function validateTimestamp(value: unknown, label: string): string {
  const timestamp = requireNonEmpty(value, label)
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`${label} must be a valid ISO timestamp.`)
  return timestamp
}

export function normalizeEvidence(value: TodoEvidence, executionId: string, index: number): TodoEvidence {
  if (!value || typeof value !== 'object') throw new Error(`Execution ${executionId} evidence ${index + 1} must be an object.`)
  if (!TODO_EVIDENCE_SOURCES.includes(value.source)) {
    throw new Error(`Execution ${executionId} evidence ${index + 1} has invalid source: "${String(value.source)}".`)
  }
  const revision = value.revision === undefined ? undefined : requireNonEmpty(value.revision, 'Evidence revision')
  if (['revision', 'test', 'worktree'].includes(value.source) && !revision) {
    throw new Error(`Evidence source "${value.source}" requires a revision.`)
  }
  return {
    source: value.source,
    locator: requireNonEmpty(value.locator, 'Evidence locator'),
    observed_at: validateTimestamp(value.observed_at, 'Evidence observed_at'),
    digest: requireNonEmpty(value.digest, 'Evidence digest'),
    ...(revision ? { revision } : {}),
    ...(value.note === undefined ? {} : { note: requireNonEmpty(value.note, 'Evidence note') }),
  }
}

function normalizeExecution(value: TodoExecution): TodoExecution {
  if (!value || typeof value !== 'object') throw new Error('Todo execution must be an object.')
  const id = requireNonEmpty(value.id, 'Execution id')
  if (!TODO_EXECUTION_PHASES.includes(value.phase)) throw new Error(`Execution ${id} has invalid phase: "${String(value.phase)}".`)
  const closedAt = value.closed_at == null ? null : validateTimestamp(value.closed_at, `Execution ${id} closed_at`)
  const outcome = value.outcome == null ? null : value.outcome
  if (outcome !== null && !TODO_EXECUTION_OUTCOMES.includes(outcome)) {
    throw new Error(`Execution ${id} has invalid outcome: "${String(outcome)}".`)
  }
  if ((closedAt === null) !== (outcome === null)) {
    throw new Error(`Execution ${id} must set closed_at and outcome together.`)
  }

  const next = typeof value.next === 'string' ? value.next.trim() : ''
  if (closedAt === null && !next) throw new Error(`Open execution ${id} must have a non-empty next step.`)

  let evidence: TodoEvidence[]
  if (value.evidence === undefined) evidence = []
  else if (Array.isArray(value.evidence)) evidence = value.evidence.map((item, index) => normalizeEvidence(item, id, index))
  else throw new Error(`Execution ${id} evidence must be an array.`)

  return {
    id,
    goal: requireNonEmpty(value.goal, `Execution ${id} goal`),
    phase: value.phase,
    next,
    blocked_on: value.blocked_on == null ? null : requireNonEmpty(value.blocked_on, `Execution ${id} blocked_on`),
    evidence,
    opened_at: validateTimestamp(value.opened_at, `Execution ${id} opened_at`),
    closed_at: closedAt,
    outcome,
    outcome_note: typeof value.outcome_note === 'string' ? value.outcome_note : '',
    ...(value.workflow === undefined ? {} : { workflow: normalizeWorkflow(value.workflow) }),
  }
}

export function normalizeTodo(value: TodoItem): TodoItem {
  if (!TODO_STATUSES.includes(value.status)) {
    throw new Error(`Unsupported Todo status: "${String(value.status)}". Expected one of: ${TODO_STATUSES.join(', ')}. No data was converted.`)
  }
  if (value.lifecycle_revision !== undefined
    && (!Number.isSafeInteger(value.lifecycle_revision) || value.lifecycle_revision < 0)) {
    throw new Error('Todo lifecycle_revision must be a nonnegative safe integer.')
  }
  if (value.pending_transition !== undefined && value.pending_transition !== 'restore') {
    throw new Error(`Todo "${value.ref ?? value.title}" has invalid pending_transition: "${String(value.pending_transition)}".`)
  }
  if (value.last_cancellation !== undefined) {
    requireNonEmpty(value.last_cancellation.decision, 'Cancellation decision')
    validateTimestamp(value.last_cancellation.at, 'Cancellation timestamp')
    if (!Number.isSafeInteger(value.last_cancellation.lifecycle_revision) || value.last_cancellation.lifecycle_revision < 0) {
      throw new Error('Cancellation lifecycle_revision must be a nonnegative safe integer.')
    }
  }
  let executions: TodoExecution[]
  if (value.executions === undefined) executions = []
  else if (Array.isArray(value.executions)) executions = value.executions.map(normalizeExecution)
  else throw new Error(`Todo "${value.ref ?? value.title}" executions must be an array.`)
  const openCount = executions.filter(item => item.closed_at === null).length
  if (openCount > 1) {
    throw new Error(`Todo "${value.ref ?? value.title}" has more than one open execution.`)
  }
  return {
    ...value,
    ...(value.pull_requests === undefined ? {} : { pull_requests: normalizeTodoPulls(value.pull_requests) }),
    ...(value.id ? { id: requireNonEmpty(value.id, 'Todo id') } : {}),
    claimed_items: value.claimed_items ?? null,
    executions,
  }
}

export function validateTodoIds(todos: TodoItem[]): void {
  const todoIds = new Set<string>()
  const executionIds = new Set<string>()
  for (const todo of todos) {
    if (todo.id) {
      if (todoIds.has(todo.id)) throw new Error(`Duplicate todo id: ${todo.id}`)
      todoIds.add(todo.id)
    }
    for (const execution of todo.executions) {
      if (executionIds.has(execution.id)) throw new Error(`Duplicate execution id: ${execution.id}`)
      executionIds.add(execution.id)
    }
  }
}

export function todoArrayFromDocument(data: unknown, label: string): unknown[] {
  if (data == null) return []
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error(`${label} must contain a todos array.`)
  const raw = (data as { todos?: unknown }).todos
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error(`${label} todos must be an array.`)
  return raw
}

export function currentTodoExecution(todo: TodoItem): TodoExecution | undefined {
  return todo.executions.find(item => item.closed_at === null)
}

export function isTerminalTodo(todo: Pick<TodoItem, 'status'>): boolean {
  return todo.status === 'done' || todo.status === 'cancelled'
}
