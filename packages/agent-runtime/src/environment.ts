const SYSTEM_ENV = [
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
]

const AUTH_ENV = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR'],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_HOME'],
} as const

/** Build the deliberately narrow environment passed to a local advisor. */
export function advisorEnvironment(runtime: keyof typeof AUTH_ENV, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of [...SYSTEM_ENV, ...AUTH_ENV[runtime]]) if (source[key] !== undefined) result[key] = source[key]
  result.CI = '1'
  result.NO_COLOR = '1'
  if (runtime === 'claude') result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  return result
}
