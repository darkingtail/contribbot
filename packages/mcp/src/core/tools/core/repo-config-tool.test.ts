import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ghApi } from '../../clients/github.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'
import { getOrInitConfig, repoConfig } from './repo-config-tool.js'

vi.mock('../../clients/github.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../clients/github.js')>(),
  ghApi: vi.fn(),
}))

const github = (path: string): RepositoryRef => ({
  platform: 'github', instance: 'https://github.com', path,
})
const gitlab = (instance = 'https://internal.example/gitlab'): RepositoryRef => ({
  platform: 'gitlab', instance, path: 'team/subgroup/repo',
})
const fetchMock = vi.fn<typeof fetch>()

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'project-config-v3-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.mocked(ghApi).mockReset().mockResolvedValue({
    full_name: 'owner/repo', fork: false, private: false,
  })
  fetchMock.mockReset().mockImplementation(async () => Response.json({ path_with_namespace: gitlab().path }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
})

describe('schema v3 project entry', () => {
  it('views an absent project without writing anything or querying the network', async () => {
    const output = await repoConfig(github('owner/repo'))
    expect(output).toContain('not_initialized')
    expect(existsSync(join(home, '.contribbot'))).toBe(false)
    expect(ghApi).not.toHaveBeenCalled()
  })

  it('initializes the requested fork with an unknown parent and does not reset on repeat', async () => {
    vi.mocked(ghApi).mockResolvedValue({
      full_name: 'owner/repo', fork: true, parent: { full_name: 'parent/repo' },
    })
    const ref = github('owner/repo')
    const result = await getOrInitConfig(ref)
    expect(result.config.repository).toEqual(ref)
    expect(result.config.parent).toEqual({ status: 'unknown' })
    const file = join(projectDirectory(ref), 'config.yaml')
    const bytes = readFileSync(file, 'utf8')
    await getOrInitConfig(ref)
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    expect(existsSync(projectDirectory(github('parent/repo')))).toBe(false)
    expect(ghApi).toHaveBeenCalledTimes(1)
  })

  it('does not interpret a non-fork identity response as a relationship refresh', async () => {
    const result = await getOrInitConfig(github('owner/repo'))
    expect(result.config.parent).toEqual({ status: 'unknown' })
    expect(new RepoConfig(projectDirectory(github('owner/repo'))).load()?.parent).toEqual({ status: 'unknown' })
  })

  it('does not hide a same-name legacy project by creating an empty v3 project', async () => {
    const legacy = join(home, '.contribbot', 'owner', 'repo')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'todos.yaml'), 'todos: []\n')
    await expect(getOrInitConfig(github('owner/repo'))).rejects.toThrow(/旧格式|legacy/i)
    expect(existsSync(projectDirectory(github('owner/repo')))).toBe(false)
    expect(readFileSync(join(legacy, 'todos.yaml'), 'utf8')).toBe('todos: []\n')
    expect(ghApi).not.toHaveBeenCalled()
  })

  it('does not initialize over orphan data at the canonical path after a case correction', async () => {
    const requested = github('Owner/Repo')
    const canonical = github('owner/repo')
    const canonicalDir = projectDirectory(canonical)
    mkdirSync(canonicalDir, { recursive: true })
    writeFileSync(join(canonicalDir, 'todos.yaml'), 'todos: []\n')

    await expect(getOrInitConfig(requested)).rejects.toThrow(/contains data without a valid config/i)
    expect(ghApi).toHaveBeenCalledTimes(1)
    expect(existsSync(join(canonicalDir, 'config.yaml'))).toBe(false)
    expect(readFileSync(join(canonicalDir, 'todos.yaml'), 'utf8')).toBe('todos: []\n')
    expect(existsSync(projectDirectory(requested))).toBe(false)
  })

  it('rejects ambiguous or failed remote identity without creating a project', async () => {
    vi.mocked(ghApi).mockResolvedValueOnce({ fork: false })
    await expect(getOrInitConfig(github('owner/repo'))).rejects.toThrow(/identity|full_name/i)
    vi.mocked(ghApi).mockRejectedValueOnce(new Error('offline'))
    await expect(getOrInitConfig(github('owner/repo'))).rejects.toThrow('offline')
    expect(existsSync(projectDirectory(github('owner/repo')))).toBe(false)
  })

  it('requires the complete repository object before any verification', async () => {
    await expect(getOrInitConfig('owner/repo' as unknown as RepositoryRef))
      .rejects.toThrow('Repository must be an object with exactly platform, instance, and path.')
    expect(existsSync(join(home, '.contribbot'))).toBe(false)
    expect(ghApi).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed when the directory contains a different repository identity', async () => {
    const requested = github('owner/repo')
    const path = projectDirectory(requested)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'config.yaml'), JSON.stringify({
      schema_version: 3,
      repository: github('other/repo'),
      lifecycle: { status: 'active' },
      parent: { status: 'unknown' },
      tracking: { status: 'pending' },
    }))
    await expect(repoConfig(requested)).rejects.toThrow(/identity|directory/i)
  })

  it('reports a missing config when it disappears before a tracking update', async () => {
    const ref = github('owner/repo')
    await getOrInitConfig(ref)
    const update = vi.spyOn(RepoConfig.prototype, 'update').mockReturnValueOnce(null)

    try {
      await expect(repoConfig(ref, [github('source/repo')]))
        .rejects.toThrow(/no longer exists or changed/i)
    }
    finally {
      update.mockRestore()
    }
  })
})

describe('GitLab project initialization', () => {
  it('verifies an exact nested project and creates only the five-key config', async () => {
    const ref = gitlab()
    fetchMock.mockResolvedValueOnce(Response.json({
      path_with_namespace: ref.path,
      forked_from_project: { path_with_namespace: 'parent/repo' },
    }))

    const result = await getOrInitConfig(ref)
    expect(result.repository).toEqual(ref)
    expect(result.owner).toBe('team/subgroup')
    expect(result.name).toBe('repo')
    expect(result.directory).toBe(projectDirectory(ref))
    expect(result.config).toEqual({
      schema_version: 3,
      repository: ref,
      lifecycle: { status: 'active' },
      parent: { status: 'unknown' },
      tracking: { status: 'pending' },
    })
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://internal.example/gitlab/api/v4/projects/team%2Fsubgroup%2Frepo',
      expect.objectContaining({ method: 'GET', redirect: 'manual', credentials: 'omit' }),
    )
    expect(ghApi).not.toHaveBeenCalled()
    expect(readFileSync(join(projectDirectory(ref), 'config.yaml'), 'utf8')).not.toContain('forked_from')
    expect(existsSync(projectDirectory({ ...ref, path: 'parent/repo' }))).toBe(false)
  })

  it('keeps same-path projects on different instances in separate directories', async () => {
    const first = gitlab()
    const second = gitlab('https://other.example/gitlab')
    await getOrInitConfig(first)
    await getOrInitConfig(second)
    expect(projectDirectory(first)).not.toBe(projectDirectory(second))
    expect(new RepoConfig(projectDirectory(first)).load()?.repository).toEqual(first)
    expect(new RepoConfig(projectDirectory(second)).load()?.repository).toEqual(second)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(ghApi).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'non-200', response: () => new Response('private fixture body', { status: 404 }) },
    { label: 'redirect', response: () => new Response(null, { status: 302, headers: { Location: 'https://other.example' } }) },
    { label: 'malformed JSON', response: () => new Response('not JSON') },
    { label: 'missing identity', response: () => Response.json({}) },
    { label: 'different path', response: () => Response.json({ path_with_namespace: 'other/repo' }) },
    { label: 'different case', response: () => Response.json({ path_with_namespace: 'Team/subgroup/repo' }) },
  ])('does not create any project data after $label', async ({ response }) => {
    fetchMock.mockResolvedValueOnce(response())
    await expect(getOrInitConfig(gitlab())).rejects.toThrow(/GitLab/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(existsSync(join(home, '.contribbot'))).toBe(false)
    expect(ghApi).not.toHaveBeenCalled()
  })

  it('does not create data or echo a network error after verification fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network fixture-secret-value'))
    await expect(getOrInitConfig(gitlab())).rejects.toThrow(/GitLab.*network/i)
    expect(existsSync(join(home, '.contribbot'))).toBe(false)
  })

  it('rejects orphan data before attempting any remote verification', async () => {
    const ref = gitlab()
    const directory = projectDirectory(ref)
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'todos.yaml')
    writeFileSync(file, 'todos: []\n')
    await expect(getOrInitConfig(ref)).rejects.toThrow(/contains data without a valid config/i)
    expect(readFileSync(file, 'utf8')).toBe('todos: []\n')
    expect(existsSync(join(directory, 'config.yaml'))).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ghApi).not.toHaveBeenCalled()
  })

  it('rejects invalid existing config without overwriting it or verifying remotely', async () => {
    const ref = gitlab()
    const directory = projectDirectory(ref)
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'config.yaml')
    const invalid = 'schema_version: 2\n'
    writeFileSync(file, invalid)
    await expect(getOrInitConfig(ref)).rejects.toThrow(/Invalid schema v3/)
    expect(readFileSync(file, 'utf8')).toBe(invalid)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ghApi).not.toHaveBeenCalled()
  })

  it.each(['active', 'archived'] as const)('reopens a valid $status project offline without resetting its config', async status => {
    const ref = gitlab()
    const store = new RepoConfig(projectDirectory(ref))
    store.save({
      schema_version: 3,
      repository: ref,
      lifecycle: status === 'archived'
        ? { status, archived_at: '2026-10-01T00:00:00Z' }
        : { status },
      parent: { status: 'unknown' },
      tracking: { status: 'none' },
    })
    const file = join(projectDirectory(ref), 'config.yaml')
    const before = readFileSync(file)
    fetchMock.mockRejectedValue(new Error('must remain offline'))
    const result = await getOrInitConfig(ref)
    expect(result.config.lifecycle.status).toBe(status)
    expect(result.config.tracking.status).toBe('none')
    expect(readFileSync(file)).toEqual(before)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ghApi).not.toHaveBeenCalled()
  })
})

describe('instance-bound GitLab initialization through the project entry', () => {
  const tokenName = 'CONTRIBBOT_FIXTURE_GITLAB_TOKEN'
  const fakeToken = 'synthetic-project-entry-token'
  const instance = 'https://code.example.test:8443/gitlab'

  async function entry() {
    vi.stubEnv('CONTRIBBOT_GITLAB_CREDENTIAL_BINDINGS', JSON.stringify([
      { instance, token_env_name: tokenName },
    ]))
    vi.stubEnv(tokenName, fakeToken)
    // The default verifier captures its metadata when the module is loaded.
    vi.resetModules()
    return (await import('./project-init.js')).projectInitResult
  }

  it('uses the bound token once, creates only config, and repeats offline without exposing credentials', async () => {
    const initialize = await entry()
    const ref = gitlab(instance)
    const result = await initialize(ref)
    const directory = projectDirectory(ref)
    const file = join(directory, 'config.yaml')
    const bytes = readFileSync(file)

    expect(result.context).toEqual({
      schema_version: 1, repository: ref, directory,
      lifecycle: { status: 'active' }, tracking: { status: 'pending' },
    })
    expect(new RepoConfig(directory).load()).toEqual({
      schema_version: 3, repository: ref,
      lifecycle: { status: 'active' }, parent: { status: 'unknown' },
      tracking: { status: 'pending' },
    })
    expect(readdirSync(directory)).toEqual(['config.yaml'])
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${instance}/api/v4/projects/team%2Fsubgroup%2Frepo`,
      expect.objectContaining({ method: 'GET', redirect: 'manual', credentials: 'omit' }),
    )
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('PRIVATE-TOKEN')).toBe(fakeToken)
    expect(JSON.stringify(result)).not.toContain(fakeToken)
    expect(bytes.toString()).not.toContain(fakeToken)
    expect(bytes.toString()).not.toContain(tokenName)
    expect(ghApi).not.toHaveBeenCalled()

    vi.stubEnv(tokenName, '')
    fetchMock.mockRejectedValue(new Error('must remain offline'))
    expect((await initialize(ref)).context).toEqual(result.context)
    expect(readFileSync(file)).toEqual(bytes)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not create data or fall back to anonymous access when a bound token is missing', async () => {
    const initialize = await entry()
    vi.stubEnv(tokenName, '')
    await expect(initialize(gitlab(instance))).rejects.toThrow(/credentials unavailable/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(ghApi).not.toHaveBeenCalled()
    expect(existsSync(join(home, '.contribbot'))).toBe(false)
  })

  it.each([302, 401])('preserves the empty project after credentialled HTTP %s without retrying', async status => {
    const initialize = await entry()
    fetchMock.mockResolvedValueOnce(new Response(fakeToken, {
      status, headers: { Location: 'https://other.example.test/gitlab' },
    }))
    const result = await initialize(gitlab(instance)).catch(error => error as Error)
    expect(result).toBeInstanceOf(Error)
    expect(String(result)).toContain(`HTTP ${status}`)
    expect(String(result)).not.toContain(fakeToken)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ghApi).not.toHaveBeenCalled()
    expect(existsSync(join(home, '.contribbot'))).toBe(false)
  })

  it('initializes a different instance anonymously without forwarding the bound token', async () => {
    const initialize = await entry()
    const ref = gitlab('https://code.example.test:8443/gitlab-staging')
    const result = await initialize(ref)
    expect(result.context.repository).toEqual(ref)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${ref.instance}/api/v4/projects/team%2Fsubgroup%2Frepo`,
      expect.objectContaining({ method: 'GET' }),
    )
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has('PRIVATE-TOKEN')).toBe(false)
    expect(existsSync(projectDirectory(gitlab(instance)))).toBe(false)
    expect(readdirSync(projectDirectory(ref))).toEqual(['config.yaml'])
    expect(ghApi).not.toHaveBeenCalled()
  })
})
