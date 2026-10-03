import {
  normalizeInstance, parseRepositoryInput,
  type RepositoryInput, type RepositoryRef,
} from '../utils/repository-ref.js'

export const GITLAB_CREDENTIAL_BINDINGS_ENV = 'CONTRIBBOT_GITLAB_CREDENTIAL_BINDINGS'

interface GitLabCredentialBinding {
  readonly instance: string
  readonly token_env_name: string
}

interface GitLabIdentityVerifierOptions {
  bindings?: string
  readToken: (name: string) => string | undefined
  fetch: typeof fetch
}

function parseBindings(raw: string | undefined): readonly GitLabCredentialBinding[] {
  try {
    const input: unknown = raw === undefined ? [] : JSON.parse(raw)
    if (!Array.isArray(input)) throw new Error()
    const instances = new Set<string>()
    const tokenNames = new Set<string>()
    const bindings = input.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).length !== 2
        || !('instance' in entry) || typeof entry.instance !== 'string'
        || !('token_env_name' in entry) || typeof entry.token_env_name !== 'string'
        || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.token_env_name)) {
        throw new Error()
      }
      const instance = normalizeInstance(entry.instance)
      // Windows environment names are case-insensitive; aliases cannot share a secret.
      const tokenName = entry.token_env_name.toUpperCase()
      if (!instance.startsWith('https://') || instance === 'https://github.com'
        || instances.has(instance) || tokenNames.has(tokenName)) {
        throw new Error()
      }
      instances.add(instance)
      tokenNames.add(tokenName)
      return Object.freeze({ instance, token_env_name: entry.token_env_name })
    })
    return Object.freeze(bindings)
  }
  catch {
    throw new Error('GitLab credential bindings are invalid; no project was created.')
  }
}

function failure(instance: string, category: string): Error {
  return new Error(`GitLab identity verification for ${instance} failed (${category}); no project was created.`)
}

/** Metadata is captured now; validation and exact-instance token reads are lazy. */
export function createGitLabIdentityVerifier(options: GitLabIdentityVerifierOptions) {
  const { bindings: rawBindings, readToken, fetch: request } = options
  let bindings: readonly GitLabCredentialBinding[] | undefined

  return async (input: RepositoryInput): Promise<RepositoryRef> => {
    const repository = parseRepositoryInput(input)
    if (repository.platform !== 'gitlab') {
      throw new Error('This identity verifier only supports GitLab.')
    }
    bindings ??= parseBindings(rawBindings)
    const binding = bindings.find(entry => entry.instance === repository.instance)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (binding) {
      if (!repository.instance.startsWith('https://')) throw failure(repository.instance, 'credentials unavailable')
      let token: string | undefined
      try { token = readToken(binding.token_env_name) }
      catch { throw failure(repository.instance, 'credentials unavailable') }
      if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
        throw failure(repository.instance, 'credentials unavailable')
      }
      headers['PRIVATE-TOKEN'] = token
    }

    const url = `${repository.instance}/api/v4/projects/${encodeURIComponent(repository.path)}`
    let response: Response
    try {
      response = await request(url, {
        method: 'GET', headers, redirect: 'manual', credentials: 'omit',
        signal: AbortSignal.timeout(30_000),
      })
    }
    catch { throw failure(repository.instance, 'network error') }
    if (response.status !== 200 || response.redirected) {
      throw failure(repository.instance, response.redirected ? 'redirect refused' : `HTTP ${response.status}`)
    }
    let metadata: unknown
    try { metadata = await response.json() }
    catch { throw failure(repository.instance, 'invalid JSON') }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || !('path_with_namespace' in metadata) || metadata.path_with_namespace !== repository.path) {
      throw failure(repository.instance, 'identity mismatch')
    }
    return repository
  }
}

// Only non-secret binding metadata is snapshotted at startup; tokens may rotate.
export const verifyGitLabIdentity = createGitLabIdentityVerifier({
  bindings: process.env[GITLAB_CREDENTIAL_BINDINGS_ENV],
  readToken: name => process.env[name],
  fetch: (input, init) => globalThis.fetch(input, init),
})
