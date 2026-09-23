import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TodoReadModel } from 'contribbot-core'
import { digest } from './contracts.js'
import { ConsultStore } from './store.js'
import { localMachine, observeProcess } from '../execution/processes.js'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'consult-ports-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
const processes = { machine: localMachine, observe: observeProcess }

const activeTodo = (): TodoReadModel => ({
  id: 'todo-1', lifecycleRevision: 0, status: 'active', pendingTransition: false,
  execution: {
    id: 'execution-1', hasActiveControl: false,
    confirmedPlan: { id: 'plan-1', digest: digest('plan-1') },
  },
})

function request(expectedTodo: ReturnType<ConsultStore['todoSnapshot']>) {
  return {
    request_id: 'request-1', discussion_id: 'discussion-1', purpose: 'design' as const,
    mode: 'fresh' as const, todo_id: 'todo-1', expected_todo: expectedTodo,
    packet: {
      workspace: directory, head: null, manifest: [], body: 'Question',
      digest: digest('Question'), omitted: [],
    },
    binding: {
      runtime: 'claude' as const, executable: process.execPath, executable_digest: digest('binary'),
      runtime_version: 'fixture', binding_version: '1' as const, model: null,
      protocol: 'native-oneshot' as const, transport: 'pipe' as const,
      execution_location: 'local' as const, model_location: 'unknown' as const,
      write_boundary: 'tool_free' as const, read_boundary: 'tools_disabled' as const,
      disclosure: 'Fixture', disclosure_digest: digest('Fixture'),
    },
    authorization: { explicit_once: { source: 'fixture:user', statement: 'Ask once.' } },
  }
}

it('reads Todo identity and plan only through the injected read port', () => {
  let current: TodoReadModel | null = activeTodo()
  const read = vi.fn(() => current)
  let transactionCalls = 0
  const store = new ConsultStore(directory, {
    todos: { read },
    transactions: {
      run<T>(operation: () => T): T {
        transactionCalls++
        return operation()
      },
    },
    processes,
  })

  expect(store.todoSnapshot('todo-1')).toEqual({
    id: 'todo-1', lifecycle_revision: 0, execution_id: 'execution-1',
    plan_id: 'plan-1', plan_digest: digest('plan-1'),
  })
  current = null
  expect(() => store.todoSnapshot('todo-1')).toThrow(/exact stable Todo id/i)
  expect(existsSync(join(directory, 'todos.yaml'))).toBe(false)
  expect(read).toHaveBeenCalledWith('todo-1')
  expect(transactionCalls).toBe(0)
})

it.each(['paused', 'done', 'cancelled'] as const)('refuses new consultation for a %s Todo', status => {
  const todo = { ...activeTodo(), status }
  const store = new ConsultStore(directory, {
    todos: { read: () => todo }, transactions: { run: operation => operation() }, processes,
  })

  expect(() => store.todoSnapshot(todo.id)).toThrow(/paused, stopped, ended or transitioning/i)
  expect(store.todoSnapshot(todo.id, false)?.lifecycle_revision).toBe(0)
})

it('rejects reservation when the Todo revision changes after preview', () => {
  let todo = activeTodo()
  const store = new ConsultStore(directory, {
    todos: { read: () => todo }, transactions: { run: operation => operation() }, processes,
  })
  const preview = store.todoSnapshot(todo.id)
  todo = { ...todo, lifecycleRevision: 1 }

  expect(() => store.reserve(request(preview))).toThrow(/snapshot changed/i)
  expect(store.read().discussions).toEqual([])
})
