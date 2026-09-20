import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ExecutionArtifacts } from './artifacts.js'
import type { RunCheckRequest } from './checks.js'

/** One bounded check, not a daemon: the supervisor can publish results after its requester exits. */
export async function launchCheckSupervisor(input: RunCheckRequest): Promise<void> {
  const artifacts = new ExecutionArtifacts(input.directory, input.execution_id)
  const request = artifacts.put(input)
  const source = fileURLToPath(new URL('../../cli/check-supervisor.ts', import.meta.url))
  const built = fileURLToPath(new URL('./cli/check-supervisor.js', import.meta.url))
  const args = existsSync(source)
    ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, source]
    : [built]
  if (!existsSync(args.at(-1)!)) throw new Error('Check supervisor entrypoint is unavailable. Build the current MCP package before checking.')
  args.push('--directory', input.directory, '--execution', input.execution_id, '--request', request)
  await new Promise<void>((resolve, reject) => {
    const supervisor = spawn(process.execPath, args, {
      detached: true, windowsHide: true, stdio: 'ignore', shell: false,
    })
    supervisor.once('error', reject)
    supervisor.once('close', (code, signal) => {
      if (code === 0 && signal === null) resolve()
      else reject(new Error('Check supervisor exited without confirming receipt publication. Observe the original operation; do not replay it.'))
    })
  })
}
