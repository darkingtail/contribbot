import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { advisorEnvironment } from './environment.js'
import { providerDisclosure, providerRequiredFlags } from './providers.js'
import type { AdvisorRuntime } from './providers.js'

const execute = promisify(execFile)

export interface ProviderInspectionInput {
  runtime: string
  executable: string
  model?: string
}

export interface ProviderBindingDescriptor {
  runtime: AdvisorRuntime
  executable: string
  executable_digest: string
  runtime_version: string
  binding_version: '1'
  model: string | null
  protocol: 'native-oneshot'
  transport: 'pipe'
  execution_location: 'local'
  model_location: 'unknown'
  write_boundary: 'tool_free' | 'sandbox_read_only'
  read_boundary: 'tools_disabled' | 'not_confined'
  disclosure: string
  disclosure_digest: string
}

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

export async function executableDigest(executable: string): Promise<string> {
  if (!isAbsolute(executable) || /\.(?:cmd|bat|ps1)$/i.test(executable)) {
    throw new Error('Advisor requires an absolute native executable, not a shell wrapper.')
  }
  const stat = lstatSync(executable)
  if (!stat.isFile()) throw new Error('Advisor executable must be a regular file.')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(executable)) hash.update(chunk)
  return hash.digest('hex')
}

/** Probe one explicit native Provider binary without contacting a model. */
export async function inspectProviderBinding(input: ProviderInspectionInput): Promise<ProviderBindingDescriptor> {
  if (input.runtime !== 'claude' && input.runtime !== 'codex') throw new Error('Unsupported advisor runtime.')
  if (!isAbsolute(input.executable)) throw new Error('Advisor executable must be an explicit absolute path.')
  if (input.model !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(input.model)) {
    throw new Error('Invalid advisor model identifier.')
  }
  const executable = realpathSync(input.executable)
  const fingerprint = await executableDigest(executable)
  const directory = mkdtempSync(join(tmpdir(), 'contribbot-binding-'))
  try {
    const options = {
      env: advisorEnvironment(input.runtime), windowsHide: true, shell: false as const,
      cwd: directory, timeout: 10_000, maxBuffer: 256 * 1024, encoding: 'utf8' as const,
    }
    const version = (await execute(executable, ['--version'], options)).stdout.trim()
    const help = (await execute(executable, input.runtime === 'codex' ? ['exec', '--help'] : ['--help'], options)).stdout
    const missing = providerRequiredFlags[input.runtime].filter(flag => !help.includes(flag))
    if (missing.length) throw new Error(`Advisor unavailable: missing required flags ${missing.join(', ')}.`)
    const disclosure = providerDisclosure(input.runtime, fingerprint, version, input.model)
    return {
      runtime: input.runtime, executable, executable_digest: fingerprint,
      runtime_version: version, binding_version: '1', model: input.model ?? null,
      protocol: 'native-oneshot', transport: 'pipe', execution_location: 'local', model_location: 'unknown',
      write_boundary: input.runtime === 'claude' ? 'tool_free' : 'sandbox_read_only',
      read_boundary: input.runtime === 'claude' ? 'tools_disabled' : 'not_confined',
      disclosure, disclosure_digest: digest(disclosure),
    }
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
}
