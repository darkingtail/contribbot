import { createConsultStore as createCoreConsultStore } from 'contribbot-core'
import { observeProcess, localMachine } from 'contribbot-agent-runtime'

/** Runner composition owns the host adapters; it does not load the MCP package. */
export function createConsultStore(directory: string) {
  return createCoreConsultStore(directory, {
    processes: { machine: localMachine, observe: observeProcess },
  })
}
