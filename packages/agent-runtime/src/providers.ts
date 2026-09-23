import type { RuntimeOutcome } from './transport.js'

export type AdvisorRuntime = 'claude' | 'codex'

export interface ProviderBindingInput {
  model: string | null
}

export interface ProviderProtocolBinding {
  runtime: AdvisorRuntime
  protocol: 'native-oneshot'
  argv(binding: ProviderBindingInput): string[]
  decode(stdout: string, exitCode: number | null): Pick<RuntimeOutcome, 'text' | 'outcome' | 'reason'>
  terminal(stdout: string): boolean
}

export const providerRequiredFlags: Readonly<Record<AdvisorRuntime, readonly string[]>> = {
  claude: [
    '--safe-mode', '--tools', '--strict-mcp-config', '--mcp-config', '--permission-mode', '--permission-prompts',
    '--no-session-persistence', '--disable-slash-commands', '--output-format', '--verbose',
  ],
  codex: ['--sandbox', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--json', '--skip-git-repo-check', '--color'],
}

export function providerDisclosure(runtime: AdvisorRuntime, executableHash: string, version: string, model?: string) {
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

function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const result: unknown = JSON.parse(line)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid advisor event.')
    return result as Record<string, unknown>
  })
}

const claude: ProviderProtocolBinding = {
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

const codex: ProviderProtocolBinding = {
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

export const nativeBindings: Readonly<Record<AdvisorRuntime, ProviderProtocolBinding>> = { claude, codex }
