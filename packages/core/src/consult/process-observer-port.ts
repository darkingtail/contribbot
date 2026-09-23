import type { ProcessHandle, ProcessMachine, ProcessObservation } from 'contribbot-platform/types'
export type { ProcessHandle, ProcessMachine, ProcessObservation } from 'contribbot-platform/types'

/** Synchronous, bounded observation used by Core's local-occupancy gates. */
export interface ProcessObserverPort {
  machine(): ProcessMachine
  observe(handle: ProcessHandle): ProcessObservation
}
