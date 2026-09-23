import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { describeProcessAsync } from './process.js'
import type { ProcessHandle } from './process.js'

export const MAX_OUTPUT_BYTES = 1024 * 1024

export interface LaunchPlan {
  executable: string
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface RuntimeOutcome {
  outcome: 'returned' | 'failed' | 'cancelled'
  text: string | null
  stdout: string
  stderr: string
  exit_code: number | null
  signal: string | null
  integrity: 'ok' | 'truncated'
  reason: string | null
  unresolved: string[]
}

export interface RuntimeProtocolBinding {
  protocol: string
  terminal(stdout: string): boolean
  decode(stdout: string, exitCode: number | null): Pick<RuntimeOutcome, 'text' | 'outcome' | 'reason'>
}

export interface TurnControl {
  shouldTerminate(): boolean
  onProcess(handle: ProcessHandle): void
  dispatch?(start: () => ChildProcessWithoutNullStreams): ChildProcessWithoutNullStreams
}

export interface AgentEvent {
  type: 'message.final' | 'error' | 'process.started' | 'process.exited'
  text?: string
  pid?: number
}

/** Future PTY/stdio drivers normalize into this outcome, not pipe-specific stream semantics. */
export interface SessionTransport {
  transportId: string
  run(plan: LaunchPlan, input: string, binding: RuntimeProtocolBinding, control: TurnControl): Promise<RuntimeOutcome>
}

function redactOutput(text: string, env: NodeJS.ProcessEnv): string {
  const secretValues = Object.entries(env).filter(([key, value]) => value && /(?:KEY|TOKEN|SECRET)/i.test(key))
    .map(([, value]) => value!).filter(value => value.length >= 8)
  return secretValues.reduce((value, secret) => value.split(secret).join('[REDACTED]'), text)
    .replace(/\b(?:sk-[a-zA-Z0-9_*-]{4,}|gh[pousr]_[a-zA-Z0-9*]{8,}|github_pat_[a-zA-Z0-9_*]{8,})/g, '[REDACTED]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/*=-]{8,}/gi, 'Bearer [REDACTED]')
}

export const pipeTransport: SessionTransport = {
  transportId: 'pipe',
  async run(plan, input, binding, control) {
    return new Promise(resolve => {
      let stdout = '', stderr = '', total = 0, truncated = false, terminated = false, failed = false, spawned = false
      const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8')
      const collect = (chunk: Buffer, isError: boolean) => {
        const remaining = Math.max(0, MAX_OUTPUT_BYTES - total)
        const selected = chunk.subarray(0, remaining)
        total += selected.length
        if (selected.length !== chunk.length) truncated = true
        if (isError) stderr += errDecoder.write(selected)
        else stdout += outDecoder.write(selected)
      }
      const start = () => spawn(plan.executable, plan.argv, {
        cwd: plan.cwd, env: plan.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      })
      const child = control.dispatch ? control.dispatch(start) : start()
      let handlePromise: Promise<void> = Promise.resolve()
      child.on('error', () => { failed = true })
      child.stdin.on('error', () => { failed = true })
      child.stdout.on('data', (chunk: Buffer) => collect(chunk, false))
      child.stderr.on('data', (chunk: Buffer) => collect(chunk, true))
      child.once('spawn', () => {
        spawned = true
        const spawnedAt = Date.now()
        handlePromise = describeProcessAsync(child.pid!).then(handle => {
          if (child.exitCode !== null || child.signalCode !== null || (handle.started_at && handle.started_at > spawnedAt + 1000)) {
            handle.started_at = null
          }
          control.onProcess(handle)
        }).catch(() => { failed = true })
        child.stdin.end(input)
      })
      const timer = setInterval(() => {
        try {
          if (!terminated && control.shouldTerminate()) {
            terminated = true
            child.kill()
          }
        }
        catch { failed = true }
      }, 250)
      child.once('close', async (code, signal) => {
        clearInterval(timer)
        await handlePromise
        stdout = redactOutput(stdout + outDecoder.end(), plan.env)
        stderr = redactOutput(stderr + errDecoder.end(), plan.env)
        let terminal = false
        try { terminal = binding.terminal(stdout) }
        catch { /* Malformed output cannot establish terminal protocol state. */ }
        const uncertain = spawned && (terminated || signal !== null || failed || !terminal)
        const base = {
          stdout, stderr, exit_code: code, signal, integrity: truncated ? 'truncated' as const : 'ok' as const,
          unresolved: uncertain ? ['Descendant liveness and remote consumption are not established after abnormal process exit or lost tracking.'] : [],
        }
        if (terminated) {
          resolve({ ...base, text: null, outcome: 'cancelled', reason: 'User requested advisor termination.' })
          return
        }
        if (failed || truncated) {
          resolve({ ...base, text: null, outcome: 'failed', reason: truncated ? 'Advisor output byte limit exceeded.' : 'Advisor process or receipt tracking failed.' })
          return
        }
        try { resolve({ ...base, ...binding.decode(stdout, code) }) }
        catch { resolve({ ...base, text: null, outcome: 'failed', reason: 'Malformed or incomplete advisor protocol output.' }) }
      })
    })
  },
}
