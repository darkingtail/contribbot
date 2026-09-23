import type { SynchronousTransactionPort, TodoReadPort } from 'contribbot-core'
import * as processes from '../execution/processes.js'
import { ConsultStore, createFileTodoReadPort, withTodoLock } from 'contribbot-core'
import type { ConsultStorePorts } from 'contribbot-core'

export function createTodoReadPort(directory: string): TodoReadPort {
  return createFileTodoReadPort(directory)
}

export function createConsultTransactionPort(directory: string): SynchronousTransactionPort {
  return { run: operation => withTodoLock(directory, operation) }
}

export function createConsultStorePorts(directory: string): ConsultStorePorts {
  return {
    todos: createTodoReadPort(directory),
    transactions: createConsultTransactionPort(directory),
    // Keep the adapter live so test/runtime replacement of the MCP process
    // observer remains visible without moving OS concerns back into Core.
    processes: {
      machine: () => processes.localMachine(),
      observe: handle => processes.observeProcess(handle),
    },
  }
}

export function createConsultStore(directory: string): ConsultStore {
  return new ConsultStore(directory, createConsultStorePorts(directory))
}
