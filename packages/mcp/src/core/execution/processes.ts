import { execFile, execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import { z } from 'zod'
import { processHandleSchema } from './contracts.js'
import type { ProcessHandle, WorkspaceBinding } from './contracts.js'

export const localMachine = () => ({ hostname: hostname(), platform: process.platform })

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

function absent(pid: number): boolean {
  try { process.kill(pid, 0); return false }
  catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
  }
}

function processQuery(pid: number) {
  const windows = process.platform === 'win32'
  return {
    files: windows ? ['pwsh.exe', 'powershell.exe'] : ['ps'],
    args: windows ? [
      '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; (Get-Process -Id ([int]$env:CONTRIBBOT_PROCESS_ID)).StartTime.ToUniversalTime().ToString("O", [System.Globalization.CultureInfo]::InvariantCulture)',
    ] : ['-p', String(pid), '-o', 'lstart='],
    options: {
      env: { ...process.env, ...(windows ? { CONTRIBBOT_PROCESS_ID: String(pid) } : { LC_ALL: 'C' }) },
      windowsHide: true, timeout: 3000, maxBuffer: 4096, encoding: 'utf8' as const,
    },
  }
}

function parseCreationTime(output: string): number | null {
  const timestamp = Date.parse(output.trim())
  return Number.isFinite(timestamp) ? timestamp : null
}

function creationTime(pid: number): number | null {
  const query = processQuery(pid)
  const deadline = performance.now() + query.options.timeout
  for (const file of query.files) {
    const timeout = Math.floor(deadline - performance.now())
    if (timeout <= 0) return null
    try {
      return parseCreationTime(execFileSync(file, query.args, { ...query.options, timeout, stdio: ['ignore', 'pipe', 'pipe'] }))
    }
    catch (error) {
      if (!missingExecutable(error)) return null
    }
  }
  return null
}

function missingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

/** PID plus observed OS start time identifies an incarnation, not its descendants or permissions. */
export function describeProcess(pid: number): ProcessHandle {
  z.number().int().positive().max(2 ** 31 - 1).parse(pid)
  return {
    pid, machine: localMachine(), started_at: creationTime(pid),
    observed_at: new Date().toISOString(),
  }
}

/** Keep command timers and output collection responsive while OS metadata is queried. */
export async function describeProcessAsync(pid: number): Promise<ProcessHandle> {
  z.number().int().positive().max(2 ** 31 - 1).parse(pid)
  const query = processQuery(pid)
  const deadline = performance.now() + query.options.timeout
  let started_at: number | null = null
  for (const file of query.files) {
    const timeout = Math.floor(deadline - performance.now())
    if (timeout <= 0) break
    const result = await new Promise<{ missing: boolean; timestamp: number | null }>((resolve) => {
      try {
        execFile(file, query.args, { ...query.options, timeout }, (error, stdout) => {
          resolve({ missing: missingExecutable(error), timestamp: error ? null : parseCreationTime(stdout) })
        })
      }
      catch (error) { resolve({ missing: missingExecutable(error), timestamp: null }) }
    })
    if (!result.missing) {
      started_at = result.timestamp
      break
    }
  }
  return { pid, machine: localMachine(), started_at, observed_at: new Date().toISOString() }
}

export interface ProcessObservation {
  state: 'running' | 'stopped' | 'replaced' | 'unknown'
  observed_at: string
  reason: string
}

export function observeProcess(raw: unknown): ProcessObservation {
  const handle = processHandleSchema.parse(raw)
  const observed_at = new Date().toISOString()
  if (handle.machine.hostname !== hostname() || handle.machine.platform !== process.platform) {
    return { state: 'unknown', observed_at, reason: 'The recorded process belongs to another machine.' }
  }
  if (absent(handle.pid)) return { state: 'stopped', observed_at, reason: 'The OS reports that the recorded PID is absent; descendant liveness is separate.' }
  const now = creationTime(handle.pid)
  if (now === null || handle.started_at === null) {
    return { state: 'unknown', observed_at, reason: 'Process incarnation could not be verified.' }
  }
  if (now !== handle.started_at) return { state: 'replaced', observed_at, reason: 'The current PID has a different creation time; do not signal it as the original process.' }
  return { state: 'running', observed_at, reason: 'The recorded process incarnation is present.' }
}
