import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { advisorEnvironment } from './environment.js'

const execute = promisify(execFile)

export interface ReadonlyProbeBinding {
  executable: string
  executable_digest: string
}

const digest = (value: unknown): string =>
  createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')

/** An offline OS write probe. It does not contact a model or inspect user documents. */
export async function probeCodexReadonly(binding: ReadonlyProbeBinding) {
  const root = mkdtempSync(join(tmpdir(), 'contribbot-readonly-'))
  const inside = join(root, 'inside.txt')
  const outside = `${root}-outside.txt`
  const created = join(root, 'created.txt')
  writeFileSync(inside, 'UNCHANGED', { mode: 0o600 })
  writeFileSync(outside, 'UNCHANGED', { mode: 0o600 })
  const env = advisorEnvironment('codex')
  delete env.OPENAI_API_KEY
  delete env.OPENAI_BASE_URL
  delete env.CODEX_API_KEY
  env.CODEX_HOME = root
  const script = [
    'const fs=require("node:fs");',
    `const paths=${JSON.stringify([inside, outside, created])};`,
    'const results=paths.map(p=>{try{fs.writeFileSync(p,"CHANGED");return "writable"}catch(e){return e.code}});',
    'console.log("CONSULT_PROBE:"+JSON.stringify(results));',
  ].join('')
  let reason = 'Sandbox command did not complete.'
  let verified = false
  try {
    const platform = process.platform === 'win32'
      ? ['-P', ':read-only', '-c', 'windows.sandbox="unelevated"']
      : [process.platform === 'darwin' ? 'macos' : 'linux', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"']
    const result = await execute(binding.executable, [
      'sandbox', ...platform, '-C', root, '--', process.execPath, '-e', script,
    ], { cwd: root, env, shell: false, windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 })
    const line = result.stdout.split(/\r?\n/).find(line => line.startsWith('CONSULT_PROBE:'))
    const attempts: unknown = line ? JSON.parse(line.slice('CONSULT_PROBE:'.length)) : null
    verified = Array.isArray(attempts) && attempts.length === 3
      && attempts.every(code => code === 'EACCES' || code === 'EPERM')
      && readFileSync(inside, 'utf8') === 'UNCHANGED' && readFileSync(outside, 'utf8') === 'UNCHANGED'
      && !existsSync(created)
    reason = verified ? 'Three attempted writes denied on this machine.' : 'Sandbox did not demonstrably deny all three writes.'
  }
  catch (error) {
    reason = `Readonly probe unavailable (${error && typeof error === 'object' && 'code' in error ? String(error.code) : 'probe_error'}).`
  }
  finally {
    rmSync(root, { force: true, recursive: true })
    rmSync(outside, { force: true })
  }
  const record = { verified, reason, platform: process.platform, hostname: hostname(), executable_digest: binding.executable_digest }
  return { ...record, digest: digest(record) }
}
