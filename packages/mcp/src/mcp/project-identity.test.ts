import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from './server.js'
import { RepoConfig } from '../core/storage/repo-config.js'
import { UpstreamStore } from '../core/storage/upstream-store.js'
import { projectDirectory, repositoryDigest, type RepositoryRef } from '../core/utils/repository-ref.js'

describe('structured project identity', () => {
  let home: string
  let client: Client
  let server: ReturnType<typeof createServer>
  const repository: RepositoryRef = {
    platform: 'gitlab',
    instance: 'http://code.example.com:8080/gitlab',
    path: 'team/subgroup/app',
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'project-identity-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    new RepoConfig(projectDirectory(repository)).save({
      schema_version: 3,
      repository,
      lifecycle: { status: 'active' },
      parent: { status: 'unknown' },
      tracking: { status: 'pending' },
    })
    server = createServer()
    client = new Client({ name: 'identity-test', version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(a), server.connect(b)])
  })

  afterEach(async () => {
    await client?.close()
    await server?.close()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('returns complete initialization metadata independently from presentation text', async () => {
    const result = await client.callTool({ name: 'project_init', arguments: { repo: repository } })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({
      schema_version: 1,
      repository,
      directory: projectDirectory(repository),
      lifecycle: { status: 'active' },
      tracking: { status: 'pending' },
    })
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('Contribbot Context') }),
    ])
  })

  it('keeps canonical identities separate when their display names collide', async () => {
    const other: RepositoryRef = {
      ...repository,
      instance: 'http://code.example.com:8080',
      path: 'gitlab/team/subgroup/app',
    }
    new RepoConfig(projectDirectory(other)).save({
      schema_version: 3,
      repository: other,
      lifecycle: { status: 'active' },
      parent: { status: 'unknown' },
      tracking: { status: 'none' },
    })
    const first = await client.callTool({ name: 'project_init', arguments: { repo: repository } })
    const second = await client.callTool({ name: 'project_init', arguments: { repo: other } })
    expect(first.structuredContent).toHaveProperty('repository', repository)
    expect(second.structuredContent).toHaveProperty('repository', other)
    expect(first.structuredContent).not.toHaveProperty('directory', projectDirectory(other))
    const listed = await client.callTool({ name: 'project_list', arguments: {} })
    expect(listed.structuredContent).toMatchObject({
      schema_version: 1,
      filter: 'active',
      problems: [],
      projects: expect.arrayContaining([
        { repository, digest: repositoryDigest(repository), status: 'active' },
        { repository: other, digest: repositoryDigest(other), status: 'active' },
      ]),
    })
  })

  it('preserves archived lifecycle and does not establish a default repository', async () => {
    const store = new RepoConfig(projectDirectory(repository))
    store.update({ lifecycle: { status: 'archived', archived_at: '2026-10-01T00:00:00Z' } }, store.load()!)
    const result = await client.callTool({ name: 'project_init', arguments: { repo: repository } })
    expect(result.structuredContent).toHaveProperty('lifecycle.status', 'archived')
    expect(store.load()?.lifecycle.status).toBe('archived')
    expect((await client.callTool({ name: 'todo_list', arguments: {} })).isError).toBe(true)
  })

  it('uses the complete upstream identity in MCP filters and rejects a shorthand', async () => {
    const first: RepositoryRef = { platform: 'gitlab', instance: 'https://one.example.com/gitlab', path: 'team/ui' }
    const second: RepositoryRef = { ...first, instance: 'https://two.example.com/gitlab' }
    const store = new UpstreamStore(projectDirectory(repository))
    store.addVersion(first, 'v1', [{ title: 'First only', type: 'feature' }])
    store.addVersion(second, 'v1', [{ title: 'Second only', type: 'feature' }])

    const result = await client.callTool({
      name: 'upstream_list', arguments: { repo: repository, upstream_repo: first },
    })
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result.content)).toContain('one.example.com')
    expect(JSON.stringify(result.content)).not.toContain('two.example.com')

    const invalid = await client.callTool({
      name: 'upstream_list', arguments: { repo: repository, upstream_repo: 'team/ui' },
    })
    expect(invalid.isError).toBe(true)
    expect(store.listRepos()).toEqual([first, second])
  })

  it('exposes the same complete source schema on every upstream entry point', async () => {
    const { tools } = await client.listTools()
    const required = [
      'upstream_sync_check', 'upstream_detail', 'upstream_update', 'upstream_daily',
      'upstream_daily_act', 'upstream_daily_skip_noise', 'upstream_compact',
    ]
    const optional = ['upstream_list', 'issue_create']
    for (const name of [...required, ...optional]) {
      const tool = tools.find(item => item.name === name)
      expect(tool, name).toBeDefined()
      let schema = tool!.inputSchema.properties?.upstream_repo
      if (schema && typeof schema === 'object' && '$ref' in schema) {
        expect(schema.$ref, name).toBe('#/properties/repo')
        schema = tool!.inputSchema.properties?.repo
      }
      expect(schema, name).toMatchObject({
        type: 'object',
        properties: {
          platform: { enum: ['github', 'gitlab'] },
          instance: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['platform', 'instance', 'path'],
        additionalProperties: false,
      })
      expect(tool!.inputSchema.required?.includes('upstream_repo'), name).toBe(required.includes(name))
    }
  })

  it.each([
    { name: 'upstream_sync_check', args: {} },
    { name: 'upstream_list', args: {} },
    { name: 'upstream_detail', args: { version: 'v1' } },
    { name: 'upstream_update', args: { version: 'v1', item_index: 1, status: 'done' } },
    { name: 'upstream_daily', args: {} },
    { name: 'upstream_daily_act', args: { sha: 'abc123', action: 'skip' } },
    { name: 'upstream_daily_skip_noise', args: {} },
    { name: 'upstream_compact', args: { keep: 0 } },
    { name: 'issue_create', args: { title: 'Invalid source', upstream_sha: 'abc123' } },
  ])('rejects incomplete and shorthand sources at the $name MCP boundary', async ({ name, args }) => {
    for (const invalidSource of ['team/ui', { platform: 'gitlab', path: 'team/ui' }]) {
      const result = await client.callTool({
        name,
        arguments: { ...args, repo: repository, upstream_repo: invalidSource },
      })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('upstream_repo')
    }
    expect(new UpstreamStore(projectDirectory(repository)).listRepos()).toEqual([])
  })

  it('reads, updates, and archives matching paths on different source instances independently', async () => {
    const first: RepositoryRef = { platform: 'gitlab', instance: 'https://one.example.com/gitlab', path: 'team/ui' }
    const second: RepositoryRef = { ...first, instance: 'https://two.example.com/gitlab' }
    const store = new UpstreamStore(projectDirectory(repository))
    store.addVersion(first, 'v1', [{ title: 'First only', type: 'feature' }])
    store.addVersion(second, 'v1', [{ title: 'Second only', type: 'feature' }])
    for (const source of [first, second]) {
      store.addDailyCommits(source, [{ sha: 'abc123', message: source.instance, type: 'feat', date: '2026-10-01' }])
      store.updateDailyCommit(source, 'abc123', { action: 'skip' })
    }

    const update = await client.callTool({
      name: 'upstream_update',
      arguments: { repo: repository, upstream_repo: first, version: 'v1', item_index: 1, status: 'done' },
    })
    expect(update.isError).not.toBe(true)
    const detail = await client.callTool({
      name: 'upstream_detail', arguments: { repo: repository, upstream_repo: second, version: 'v1' },
    })
    expect(detail.isError).not.toBe(true)
    expect(JSON.stringify(detail.content)).toContain('Second only')
    expect(JSON.stringify(detail.content)).not.toContain('First only')
    expect(store.listVersions(first)[0]?.status).toBe('done')
    expect(store.listVersions(second)[0]?.status).toBe('active')

    const compact = await client.callTool({
      name: 'upstream_compact', arguments: { repo: repository, upstream_repo: first, keep: 0 },
    })
    expect(compact.isError).not.toBe(true)
    expect(store.listArchived(first)).toHaveLength(1)
    expect(store.listArchived(second)).toEqual([])
    expect(store.getDaily(second).commits).toHaveLength(1)
  })
})

describe('first GitLab initialization through MCP', () => {
  let home: string
  let client: Client
  let server: ReturnType<typeof createServer>
  const repository: RepositoryRef = {
    platform: 'gitlab',
    instance: 'https://code.example:8443/gitlab',
    path: 'team/subgroup/new-app',
  }
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'gitlab-mcp-init-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    fetchMock.mockReset().mockImplementation(async () => Response.json({
      path_with_namespace: repository.path,
      forked_from_project: { path_with_namespace: 'parent/app' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    server = createServer()
    client = new Client({ name: 'gitlab-init-test', version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([client.connect(a), server.connect(b)])
  })

  afterEach(async () => {
    await client?.close()
    await server?.close()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    rmSync(home, { recursive: true, force: true })
  })

  it('creates only the exact project config and returns structured identity without an implicit binding', async () => {
    const result = await client.callTool({ name: 'project_init', arguments: { repo: repository } })
    expect(result.isError).not.toBe(true)
    const directory = projectDirectory(repository)
    expect(result.structuredContent).toEqual({
      schema_version: 1,
      repository,
      directory,
      lifecycle: { status: 'active' },
      tracking: { status: 'pending' },
    })
    expect(new RepoConfig(directory).load()).toEqual({
      schema_version: 3,
      repository,
      lifecycle: { status: 'active' },
      parent: { status: 'unknown' },
      tracking: { status: 'pending' },
    })
    expect(readdirSync(directory)).toEqual(['config.yaml'])
    expect(existsSync(projectDirectory({ ...repository, path: 'parent/app' }))).toBe(false)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://code.example:8443/gitlab/api/v4/projects/team%2Fsubgroup%2Fnew-app',
      expect.objectContaining({ method: 'GET', redirect: 'manual', credentials: 'omit' }),
    )

    const bytes = readFileSync(join(directory, 'config.yaml'))
    fetchMock.mockRejectedValue(new Error('offline synthetic response'))
    const repeated = await client.callTool({ name: 'project_init', arguments: { repo: repository } })
    expect(repeated.structuredContent).toEqual(result.structuredContent)
    expect(readFileSync(join(directory, 'config.yaml'))).toEqual(bytes)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await client.callTool({ name: 'todo_list', arguments: {} })).isError).toBe(true)
  })

  it('returns a redacted verification error without creating data or falling back to another project', async () => {
    fetchMock.mockRejectedValueOnce(new Error('synthetic-token-in-network-error'))
    const result = await client.callTool({ name: 'project_init', arguments: { repo: repository } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('network error')
    expect(JSON.stringify(result)).not.toContain('synthetic-token-in-network-error')
    expect(result.structuredContent).toBeUndefined()
    expect(existsSync(join(home, '.contribbot'))).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await client.callTool({ name: 'todo_list', arguments: {} })).isError).toBe(true)
  })
})
