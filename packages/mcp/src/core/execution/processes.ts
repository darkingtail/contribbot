import { z } from 'zod'
import {
  describeProcess as describeRuntimeProcess,
  describeProcessAsync as describeRuntimeProcessAsync,
  localMachine as runtimeLocalMachine,
  observeProcess as observeRuntimeProcess,
} from 'contribbot-platform'
import type { ProcessObservation } from 'contribbot-platform/types'
export type { ProcessObservation } from 'contribbot-platform/types'
import { processHandleSchema } from './contracts.js'
import type { ProcessHandle, WorkspaceBinding } from './contracts.js'

export const localMachine = runtimeLocalMachine

/** Environment identity is a cooperative guard, not host authentication. */
export function assertLocalWorkspace(workspace: WorkspaceBinding): void {
  if (!workspace.machine) throw new Error('Workspace machine identity is missing. Read context and explicitly relocate settled work before new local verification.')
  const actual = localMachine()
  for (const key of ['hostname', 'platform'] as const) {
    if (workspace.machine[key] !== actual[key]) throw new Error(
      `Workspace machine ${key} differs: recorded=${workspace.machine[key]}, current=${actual[key]}. Use the original machine or explicitly relocate settled work; do not clear unknown operations.`,
    )
  }
}

/** PID plus observed OS start time identifies an incarnation, not its descendants or permissions. */
export function describeProcess(pid: number): ProcessHandle {
  z.number().int().positive().max(2 ** 31 - 1).parse(pid)
  return describeRuntimeProcess(pid)
}

/** Keep command timers and output collection responsive while OS metadata is queried. */
export async function describeProcessAsync(pid: number): Promise<ProcessHandle> {
  z.number().int().positive().max(2 ** 31 - 1).parse(pid)
  return describeRuntimeProcessAsync(pid)
}

export function observeProcess(raw: unknown): ProcessObservation {
  const handle = processHandleSchema.parse(raw)
  return observeRuntimeProcess(handle)
}
