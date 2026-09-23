import { execFile, execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import type { ProcessHandle, ProcessMachine, ProcessObservation } from './types.js'

export const localMachine = (): ProcessMachine => ({ hostname: hostname(), platform: process.platform })

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) {
    throw new Error('Process id must be a positive 32-bit integer.')
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

function missingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
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

export function describeProcess(pid: number): ProcessHandle {
  assertPid(pid)
  return { pid, machine: localMachine(), started_at: creationTime(pid), observed_at: new Date().toISOString() }
}

/** Keep command timers and output collection responsive while OS metadata is queried. */
export async function describeProcessAsync(pid: number): Promise<ProcessHandle> {
  assertPid(pid)
  const query = processQuery(pid)
  const deadline = performance.now() + query.options.timeout
  let started_at: number | null = null
  for (const file of query.files) {
    const timeout = Math.floor(deadline - performance.now())
    if (timeout <= 0) break
    const result = await new Promise<{ missing: boolean; timestamp: number | null }>(resolve => {
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

function parseHandle(raw: unknown): ProcessHandle {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid process handle.')
  const value = raw as Record<string, unknown>
  const machine = value.machine
  if (!machine || typeof machine !== 'object' || Array.isArray(machine)) throw new Error('Invalid process handle machine.')
  const machineValue = machine as Record<string, unknown>
  const pid = value.pid
  const started = value.started_at
  if (!Number.isInteger(pid) || (pid as number) <= 0 || (pid as number) > 2 ** 31 - 1
    || typeof machineValue.hostname !== 'string' || typeof machineValue.platform !== 'string'
    || (started !== null && (!Number.isInteger(started) || (started as number) < 0))
    || typeof value.observed_at !== 'string') {
    throw new Error('Invalid process handle.')
  }
  return {
    pid: pid as number,
    machine: { hostname: machineValue.hostname, platform: machineValue.platform },
    started_at: started as number | null,
    observed_at: value.observed_at,
  }
}

export function observeProcess(raw: unknown): ProcessObservation {
  const handle = parseHandle(raw)
  const observed_at = new Date().toISOString()
  const machine = localMachine()
  if (handle.machine.hostname !== machine.hostname || handle.machine.platform !== machine.platform) {
    return { state: 'unknown', observed_at, reason: 'The recorded process belongs to another machine.' }
  }
  if (absent(handle.pid)) {
    return { state: 'stopped', observed_at, reason: 'The OS reports that the recorded PID is absent; descendant liveness is separate.' }
  }
  const current = creationTime(handle.pid)
  if (current === null || handle.started_at === null) {
    return { state: 'unknown', observed_at, reason: 'Process incarnation could not be verified.' }
  }
  if (current !== handle.started_at) {
    return { state: 'replaced', observed_at, reason: 'The current PID has a different creation time; do not signal it as the original process.' }
  }
  return { state: 'running', observed_at, reason: 'The recorded process incarnation is present.' }
}
