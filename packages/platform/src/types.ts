export interface ProcessMachine {
  hostname: string
  platform: string
}

/** PID plus the observed OS start time identifies one process incarnation. */
export interface ProcessHandle {
  pid: number
  machine: ProcessMachine
  started_at: number | null
  observed_at: string
}

export interface ProcessObservation {
  state: 'running' | 'stopped' | 'replaced' | 'unknown'
  observed_at: string
  reason: string
}
