import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { bindingSchema, digest, runtimeInputSchema } from './contracts.js'
import type { Binding, RuntimeInput, TurnResult } from './contracts.js'

const execute = promisify(execFile)
const SYSTEM_ENV = [
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
]
const AUTH_ENV = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR'],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_HOME'],
}

export function advisorEnvironment(runtime: Binding['runtime'], source = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of [...SYSTEM_ENV, ...AUTH_ENV[runtime]]) if (source[key] !== undefined) result[key] = source[key]
  result.CI = '1'
  result.NO_COLOR = '1'
  if (runtime === 'claude') result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  return result
}

export async function executableDigest(executable: string): Promise<string> {
  if (!isAbsolute(executable) || /\.(?:cmd|bat|ps1)$/i.test(executable)) throw new Error('Advisor requires an absolute native executable, not a shell wrapper.')
  const stat = lstatSync(executable)
  if (!stat.isFile()) throw new Error('Advisor executable must be a regular file.')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(executable)) hash.update(chunk)
  return hash.digest('hex')
}

export function disclosureFor(runtime: Binding['runtime'], executableHash: string, version: string, model?: string) {
  return [
    `Runtime: ${runtime}; version: ${version}; executable SHA-256: ${executableHash}; binding: 1.`,
    `Requested model: ${model ?? 'runtime default (not independently verified)'}.`,
    runtime === 'claude'
      ? 'Model tools are disabled. This is not an OS sandbox of the CLI executable.'
      : 'Model commands use the runtime read-only sandbox with approval escalation disabled. Reads are not confined to the packet.',
    'The local CLI may send content to a remote model service. Selected packets are not a confidentiality sandbox.',
    'The runtime may read other files accessible to this OS account. It may write its own logs/auth/session metadata.',
    'Only selected content is intentionally packaged; credential screening cannot detect every possible secret.',
    'Advice is not acceptance, evidence, permission or a Todo completion decision. No automatic retry or provider fallback.',
  ].join('\n')
}

/** Runtime syntax/codec is separate from transport and the durable discussion store. */
export interface RuntimeProtocolBinding {
  runtime: Binding['runtime']
  protocol: 'native-oneshot'
  argv(binding: Binding): string[]
  decode(stdout: string, exitCode: number | null): Pick<TurnResult, 'text' | 'outcome' | 'reason'>
  terminal(stdout: string): boolean
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const result: unknown = JSON.parse(line)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid advisor event.')
    return result as Record<string, unknown>
  })
}
const claude: RuntimeProtocolBinding = {
  runtime: 'claude', protocol: 'native-oneshot',
  terminal: stdout => jsonLines(stdout).some(event => event.type === 'result' && typeof event.is_error === 'boolean'),
  argv: binding => [
    '-p', '--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--disable-slash-commands',
    '--no-session-persistence', '--output-format', 'stream-json', '--verbose',
    ...(binding.model ? ['--model', binding.model] : []),
  ],
  decode: (stdout, code) => {
    const events = jsonLines(stdout)
    const initialization = events.find(event => event.type === 'system' && event.subtype === 'init')
    if (!initialization || !Array.isArray(initialization.tools) || initialization.tools.length !== 0) {
      return { text: null, outcome: 'failed', reason: 'Advisor did not confirm an empty tool set.' }
    }
    const terminal = [...events].reverse().find(event => event.type === 'result')
    return code === 0 && terminal && !terminal.is_error && typeof terminal.result === 'string'
      ? { text: terminal.result, outcome: 'returned', reason: null }
      : { text: null, outcome: 'failed', reason: 'Missing or failed Claude terminal result.' }
  },
}
const codex: RuntimeProtocolBinding = {
  runtime: 'codex', protocol: 'native-oneshot',
  terminal: stdout => jsonLines(stdout).some(event => ['turn.completed', 'turn.failed'].includes(String(event.type))),
  argv: binding => [
    '-a', 'never', 'exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config',
    '--ignore-rules', '--skip-git-repo-check', '--color', 'never', '--json',
    '-c', 'mcp_servers={}', '-c', 'features.apps=false', '-c', 'features.plugins=false',
    '-c', 'web_search="disabled"', '-c', 'shell_environment_policy.inherit="none"',
    ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="unelevated"'] : []),
    ...(binding.model ? ['--model', binding.model] : []), '-',
  ],
  decode: (stdout, code) => {
    const events = jsonLines(stdout)
    const messages = events.filter(event => event.type === 'item.completed')
      .map(event => event.item as Record<string, unknown> | undefined)
      .filter(item => item?.type === 'agent_message' && typeof item.text === 'string')
    const terminal = [...events].reverse().find(event => ['turn.completed', 'turn.failed', 'error'].includes(String(event.type)))
    return code === 0 && terminal?.type === 'turn.completed' && messages.length
      ? { text: messages.map(item => item!.text).join('\n'), outcome: 'returned', reason: null }
      : { text: null, outcome: 'failed', reason: 'Missing or failed Codex terminal result.' }
  },
}
export const nativeBindings: Readonly<Record<Binding['runtime'], RuntimeProtocolBinding>> = { claude, codex }

export async function inspectBinding(raw: RuntimeInput): Promise<Binding> {
  const input = runtimeInputSchema.parse(raw)
  if (!isAbsolute(input.executable)) throw new Error('Advisor executable must be an explicit absolute path.')
  const executable = realpathSync(input.executable)
  const fingerprint = await executableDigest(executable)
  const directory = mkdtempSync(join(tmpdir(), 'contribbot-binding-'))
  try {
    const options = {
      env: advisorEnvironment(input.runtime), windowsHide: true, shell: false as const,
      cwd: directory,
      timeout: 10_000, maxBuffer: 256 * 1024, encoding: 'utf8' as const,
    }
    const version = (await execute(executable, ['--version'], options)).stdout.trim()
    const help = (await execute(executable, input.runtime === 'codex' ? ['exec', '--help'] : ['--help'], options)).stdout
    const required = input.runtime === 'claude'
      ? ['--safe-mode', '--tools', '--strict-mcp-config', '--mcp-config', '--permission-mode', '--permission-prompts',
          '--no-session-persistence', '--disable-slash-commands', '--output-format', '--verbose']
      : ['--sandbox', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--json', '--skip-git-repo-check', '--color']
    const missing = required.filter(flag => !help.includes(flag))
    if (missing.length) throw new Error(`Advisor unavailable: missing required flags ${missing.join(', ')}.`)
    const disclosure = disclosureFor(input.runtime, fingerprint, version, input.model)
    return bindingSchema.parse({
      runtime: input.runtime, executable, executable_digest: fingerprint,
      runtime_version: version, binding_version: '1', model: input.model ?? null,
      protocol: 'native-oneshot', transport: 'pipe', execution_location: 'local', model_location: 'unknown',
      write_boundary: input.runtime === 'claude' ? 'tool_free' : 'sandbox_read_only',
      read_boundary: input.runtime === 'claude' ? 'tools_disabled' : 'not_confined',
      disclosure, disclosure_digest: digest(disclosure),
    })
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
}
