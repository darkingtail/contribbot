import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { activeControl } from '../execution/workflow.js'
import { currentTodoExecution, normalizeTodo, requireNonEmpty, todoArrayFromDocument, validateTodoIds } from './records.js'
import type { TodoItem } from './records.js'
import type { TodoReadModel, TodoReadPort } from './read-port.js'

function readItems(path: string, label: string): TodoItem[] {
  if (!existsSync(path)) return []
  const todos = todoArrayFromDocument(parse(readFileSync(path, 'utf8')), label)
    .map(item => normalizeTodo(item as TodoItem))
  validateTodoIds(todos)
  return todos
}

function project(todo: TodoItem): TodoReadModel | null {
  if (!todo.id) return null
  const execution = currentTodoExecution(todo)
  const workflow = execution?.workflow
  const plan = workflow?.plans.find(item => item.id === workflow.plan_id)
  const hasActiveControl = Boolean(workflow && activeControl(workflow))
  return {
    id: todo.id,
    lifecycleRevision: todo.lifecycle_revision ?? 0,
    status: todo.status,
    pendingTransition: todo.pending_transition !== undefined,
    execution: execution ? {
      id: execution.id,
      hasActiveControl,
      confirmedPlan: plan?.confirmation ? { id: plan.id, digest: plan.digest } : null,
    } : null,
  }
}

/** Read-only projection of the existing Todo YAML; it never writes or creates the data root. */
export function readTodoModel(directory: string, todoId: string): TodoReadModel | null {
  requireNonEmpty(todoId, 'Todo id')
  const todo = readItems(join(directory, 'todos.yaml'), 'todos.yaml').find(item => item.id === todoId)
  if (todo) return project(todo)
  const canonicalArchive = join(directory, 'todos.archive.yaml')
  const archived = readItems(existsSync(canonicalArchive) ? canonicalArchive : join(directory, 'archive.yaml'), 'todos.archive.yaml')
    .find(item => item.id === todoId)
  return archived ? project(archived) : null
}

export function createFileTodoReadPort(directory: string): TodoReadPort {
  return { read: todoId => readTodoModel(directory, todoId) }
}
