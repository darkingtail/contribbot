import { createConsultStore as createCoreConsultStore } from 'contribbot-core'
import { observeProcess, localMachine } from 'contribbot-agent-runtime'
import { loadRepoConfig } from 'contribbot-core/repository/config'

/** Runner composition owns the host adapters; it does not load the MCP package. */
export function createConsultStore(directory: string) {
  if (!loadRepoConfig(directory)) {
    throw new Error(`Project ${directory} is not initialized. Use project_init first.`)
  }
  return createCoreConsultStore(directory, {
    processes: { machine: localMachine, observe: observeProcess },
  })
}
