import type { ProcessObserverPort } from './process-observer-port.js'
import type { ConsultStorePorts } from './store.js'
import { ConsultStore } from './store.js'
import { withTodoLock } from '../todo/lock.js'
import { createFileTodoReadPort } from '../todo/file-read.js'

export interface CoreConsultStoreDependencies {
  processes: ProcessObserverPort
}

/** Composition root for callers outside MCP; all callers share Core's lock and read projection. */
export function createConsultStore(directory: string, dependencies: CoreConsultStoreDependencies): ConsultStore {
  const ports: ConsultStorePorts = {
    todos: createFileTodoReadPort(directory),
    transactions: { run: operation => withTodoLock(directory, operation) },
    processes: dependencies.processes,
  }
  return new ConsultStore(directory, ports)
}
