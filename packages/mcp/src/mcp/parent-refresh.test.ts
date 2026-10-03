import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ghApi } from '../core/clients/github.js'
import { RepoConfig, type ParentConfig } from '../core/storage/repo-config.js'
import { projectDirectory, type RepositoryRef } from '../core/utils/repository-ref.js'
import { createServer } from './server.js'

vi.mock('../core/clients/github.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../core/clients/github.js')>(),
  ghApi: vi.fn(),
}))

describe('explicit parent_refresh MCP entry', () => {
  const repository: RepositoryRef = {
    platform: 'github', instance: 'https://github.com', path: 'darkingtail/ui',
  }
  const parent: RepositoryRef = { ...repository, path: 'team/ui' }
  let home: string
  let client: Client
  let server: ReturnType<typeof createServer>
  let store: RepoConfig

  function initialize(relationship: ParentConfig = { status: 'unknown' }): void {
    store.save({
      schema_version: 3,
      repository,
      lifecycle: { status: 'active' },
      parent: relationship,
      tracking: { status: 'pending' },
    })
  }

  async function refresh(repo: unknown = repository) {
    return client.callTool({ name: 'parent_refresh', arguments: { repo } })
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-parent-entry-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.mocked(ghApi).mockReset()
    store = new RepoConfig(projectDirectory(repository))
    server = createServer()
    client = new Client({ name: 'parent-refresh-test', version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(a), server.connect(b)])
  })

  afterEach(async () => {
    await client?.close()
    await server?.close()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('registers a separate explicit tool with a required complete repository', async () => {
    const { tools } = await client.listTools()
    const tool = tools.find(item => item.name === 'parent_refresh')
    expect(tool).toBeDefined()
    expect(tool!.inputSchema).toMatchObject({
      type: 'object',
      required: ['repo'],
      properties: {
        repo: {
          type: 'object',
          required: ['platform', 'instance', 'path'],
          additionalProperties: false,
        },
      },
    })
    expect(tool!.description).toContain('unavailable')
    expect(tool!.description).toContain('previous snapshot')
    expect(tool!.description).toContain('GitHub.com')
    expect(client.getInstructions()).toContain('parent_refresh')
    expect(ghApi).not.toHaveBeenCalled()
    expect(existsSync(join(home, '.contribbot'))).toBe(false)
  })

  it.each([
    'darkingtail/ui',
    { platform: 'github', path: 'darkingtail/ui' },
    { ...repository, instance: 'https://github.com/' },
    { ...repository, extra: 'ignored' },
  ])('rejects invalid repository %j before querying or creating data', async (repo) => {
    const result = await refresh(repo)
    expect(result.isError).toBe(true)
    expect(ghApi).not.toHaveBeenCalled()
    expect(existsSync(join(home, '.contribbot'))).toBe(false)
  })

  it('does not bind a repository after project_init or accept a missing repo', async () => {
    initialize()
    const before = readFileSync(join(projectDirectory(repository), 'config.yaml'))
    await client.callTool({ name: 'project_init', arguments: { repo: repository } })
    const result = await client.callTool({ name: 'parent_refresh', arguments: {} })
    expect(result.isError).toBe(true)
    expect(ghApi).not.toHaveBeenCalled()
    expect(readFileSync(join(projectDirectory(repository), 'config.yaml'))).toEqual(before)
    expect(store.load()?.parent).toEqual({ status: 'unknown' })
  })

  it('returns structured direct parent evidence and changes only the local relationship', async () => {
    initialize()
    const directory = projectDirectory(repository)
    writeFileSync(join(directory, 'todos.yaml'), 'todos: []\n')
    const todoBytes = readFileSync(join(directory, 'todos.yaml'))
    const entries = readdirSync(directory)
    const previous = store.load()!
    vi.mocked(ghApi).mockResolvedValue({
      full_name: repository.path, fork: true,
      parent: { full_name: parent.path }, source: { full_name: 'original/ui' },
    })

    const result = await refresh()

    expect(result.isError).not.toBe(true)
    const recorded = store.load()!
    expect(result.structuredContent).toEqual({
      schema_version: 1,
      repository,
      status: 'refreshed',
      parent: recorded.parent,
    })
    expect(recorded.parent).toEqual({
      status: 'confirmed',
      repository: parent,
      relation_verified_at: expect.any(String),
    })
    expect(recorded).toEqual({ ...previous, parent: recorded.parent })
    expect(readFileSync(join(directory, 'todos.yaml'))).toEqual(todoBytes)
    expect(readdirSync(directory)).toEqual(entries)
    expect(JSON.stringify(result.content)).toContain('team/ui')
    expect(JSON.stringify(result.content)).not.toContain('original/ui')
    expect(ghApi).toHaveBeenCalledExactlyOnceWith(`/repos/${repository.path}`)
  })

  it('records none only when the supported platform explicitly reports a non-fork', async () => {
    initialize()
    vi.mocked(ghApi).mockResolvedValue({ full_name: repository.path, fork: false })

    const result = await refresh()

    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({
      schema_version: 1, repository, status: 'refreshed',
      parent: { status: 'none', relation_verified_at: expect.any(String) },
    })
    expect(result.structuredContent).toHaveProperty('parent', store.load()?.parent)
    expect(store.load()?.tracking).toEqual({ status: 'pending' })
  })

  it.each<ParentConfig>([
    { status: 'unknown' },
    { status: 'none', relation_verified_at: '2026-09-01T00:00:00Z' },
    { status: 'confirmed', repository: parent, relation_verified_at: '2026-09-01T00:00:00Z' },
  ])('returns unavailable with the unchanged $status snapshot, not fresh proof', async (previous) => {
    initialize(previous)
    const directory = projectDirectory(repository)
    const before = readFileSync(join(directory, 'config.yaml'))
    const entries = readdirSync(directory)
    for (const observation of [
      { full_name: repository.path, fork: true },
      { full_name: repository.path, fork: true, parent: null },
      { full_name: repository.path },
    ]) {
      vi.mocked(ghApi).mockResolvedValueOnce(observation)
      const result = await refresh()
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual({
        schema_version: 1, repository, status: 'unavailable', parent: previous,
      })
      expect(JSON.stringify(result.content)).toContain('not reverified')
      expect(readFileSync(join(directory, 'config.yaml'))).toEqual(before)
      expect(readdirSync(directory)).toEqual(entries)
    }
  })

  it('labels an unavailable query-start snapshot without claiming it is the current config', async () => {
    initialize()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    let finishQuery!: (value: { full_name: string, fork: boolean }) => void
    const observation = new Promise<{ full_name: string, fork: boolean }>((resolve) => { finishQuery = resolve })
    vi.mocked(ghApi)
      .mockImplementationOnce(async () => {
        markStarted()
        return observation
      })
      .mockResolvedValueOnce({
        full_name: repository.path, fork: true, parent: { full_name: parent.path },
      })

    const pending = refresh()
    await started
    const concurrent = await refresh()
    const current = store.load()!
    const before = readFileSync(join(projectDirectory(repository), 'config.yaml'))
    finishQuery({ full_name: repository.path, fork: true })
    const result = await pending

    expect(concurrent.isError).not.toBe(true)
    expect(current.parent).toEqual({
      status: 'confirmed', repository: parent, relation_verified_at: expect.any(String),
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({
      schema_version: 1, repository, status: 'unavailable', parent: { status: 'unknown' },
    })
    expect(store.load()).toEqual(current)
    expect(readFileSync(join(projectDirectory(repository), 'config.yaml'))).toEqual(before)
    expect(ghApi).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(result.content)).toContain('read before the query')
    expect(JSON.stringify(result.content)).toContain('This request did not update')
    expect(JSON.stringify(result.content)).not.toContain('are unchanged')
  })

  it('does not initialize a missing project or query its relationship', async () => {
    const result = await refresh()
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('not initialized')
    expect(ghApi).not.toHaveBeenCalled()
    expect(existsSync(join(home, '.contribbot'))).toBe(false)
  })

  it.each<RepositoryRef>([
    { platform: 'gitlab', instance: 'https://internal.example/gitlab', path: 'team/ui' },
    { ...repository, instance: 'https://github.example.invalid' },
  ])('rejects unsupported $platform instance $instance without touching its config', async (other) => {
    const directory = projectDirectory(other)
    new RepoConfig(directory).save({
      schema_version: 3, repository: other,
      lifecycle: { status: 'active' }, parent: { status: 'unknown' },
      tracking: { status: 'none' },
    })
    const before = readFileSync(join(directory, 'config.yaml'))

    const result = await refresh(other)

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('GitHub.com')
    expect(ghApi).not.toHaveBeenCalled()
    expect(readFileSync(join(directory, 'config.yaml'))).toEqual(before)
    expect(readdirSync(directory)).toEqual(['config.yaml'])
  })

  it('does not restore an archived project or alter its configured sources', async () => {
    initialize()
    const previous = store.update({
      lifecycle: { status: 'archived', archived_at: '2026-09-01T00:00:00Z' },
      tracking: { status: 'configured', sources: [parent] },
    }, store.load()!)!
    vi.mocked(ghApi).mockResolvedValue({
      full_name: repository.path, fork: true, parent: { full_name: parent.path },
    })

    const result = await refresh()

    expect(result.isError).not.toBe(true)
    const recorded = store.load()!
    expect(result.structuredContent).toHaveProperty('parent', recorded.parent)
    expect(recorded).toEqual({
      ...previous,
      parent: { status: 'confirmed', repository: parent, relation_verified_at: expect.any(String) },
    })
    expect(readdirSync(projectDirectory(repository))).toEqual(['config.yaml'])
  })

  it.each([
    { label: 'network failure', observation: new Error('offline'), message: 'offline' },
    { label: 'identity change', observation: { full_name: 'renamed/ui', fork: false }, message: 'identity changed' },
    { label: 'self reference', observation: { full_name: repository.path, fork: true, parent: { full_name: repository.path } }, message: 'self-referential' },
  ])('reports $label as an error without replacing the relationship', async ({ observation, message }) => {
    initialize({ status: 'none', relation_verified_at: '2026-09-01T00:00:00Z' })
    const directory = projectDirectory(repository)
    const before = readFileSync(join(directory, 'config.yaml'))
    if (observation instanceof Error) vi.mocked(ghApi).mockRejectedValueOnce(observation)
    else vi.mocked(ghApi).mockResolvedValueOnce(observation)

    const result = await refresh()

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain(message)
    expect(readFileSync(join(directory, 'config.yaml'))).toEqual(before)
    expect(readdirSync(directory)).toEqual(['config.yaml'])
  })

  it('does not overwrite a newer configuration after the read-only request', async () => {
    initialize()
    vi.mocked(ghApi).mockImplementationOnce(async () => {
      store.update({ tracking: { status: 'none' } }, store.load()!)
      return { full_name: repository.path, fork: false }
    })

    const result = await refresh()

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('changed since it was read')
    expect(store.load()?.parent).toEqual({ status: 'unknown' })
    expect(store.load()?.tracking).toEqual({ status: 'none' })
    expect(readdirSync(projectDirectory(repository))).toEqual(['config.yaml'])
  })

  it('refuses corrupt project data before querying and preserves its bytes', async () => {
    initialize()
    const directory = projectDirectory(repository)
    const configPath = join(directory, 'config.yaml')
    writeFileSync(configPath, 'schema_version: 2\nrepository: darkingtail/ui\n')
    const before = readFileSync(configPath)

    const result = await refresh()

    expect(result.isError).toBe(true)
    expect(ghApi).not.toHaveBeenCalled()
    expect(readFileSync(configPath)).toEqual(before)
    expect(readdirSync(directory)).toEqual(['config.yaml'])
  })
})
