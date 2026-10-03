import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ghApi } from '../../clients/github.js'
import { RepoConfig, type ParentConfig } from '../../storage/repo-config.js'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'
import { refreshParentRelation } from './project-parent.js'

vi.mock('../../clients/github.js', () => ({ ghApi: vi.fn() }))

const repository: RepositoryRef = {
  platform: 'github',
  instance: 'https://github.com',
  path: 'darkingtail/ui',
}
const parent: RepositoryRef = { ...repository, path: 'team/ui' }
let home: string
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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'contribbot-parent-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.mocked(ghApi).mockReset()
  store = new RepoConfig(projectDirectory(repository))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

it('records an explicit non-fork without changing tracking', async () => {
  initialize()
  vi.mocked(ghApi).mockResolvedValue({ full_name: repository.path, fork: false })

  const result = await refreshParentRelation(repository)

  expect(result.status).toBe('refreshed')
  expect(result.parent).toMatchObject({ status: 'none', relation_verified_at: expect.any(String) })
  expect(store.load()?.parent).toEqual(result.parent)
  expect(store.load()?.tracking).toEqual({ status: 'pending' })
  expect(ghApi).toHaveBeenCalledWith(`/repos/${repository.path}`)
})

it('records only the direct parent of a visible fork', async () => {
  initialize()
  vi.mocked(ghApi).mockResolvedValue({
    full_name: repository.path,
    fork: true,
    parent: { full_name: parent.path },
    source: { full_name: 'original/ui' },
  })

  const result = await refreshParentRelation(repository)

  expect(result.parent).toMatchObject({ status: 'confirmed', repository: parent })
  expect(store.load()?.parent).toEqual(result.parent)
})

it.each<ParentConfig>([
  { status: 'unknown' },
  { status: 'none', relation_verified_at: '2026-09-01T00:00:00Z' },
  {
    status: 'confirmed',
    repository: parent,
    relation_verified_at: '2026-09-01T00:00:00Z',
  },
])('preserves $status config bytes when current relationship evidence is unavailable', async (previous) => {
  initialize(previous)
  const directory = projectDirectory(repository)
  const before = readFileSync(join(directory, 'config.yaml'))
  const entries = readdirSync(directory)
  for (const observed of [
    { full_name: repository.path, fork: true },
    { full_name: repository.path, fork: true, parent: null },
    { full_name: repository.path },
  ]) {
    vi.mocked(ghApi).mockResolvedValueOnce(observed)
    expect(await refreshParentRelation(repository)).toEqual({ status: 'unavailable', parent: previous })
    expect(store.load()?.parent).toEqual(previous)
    expect(readFileSync(join(directory, 'config.yaml'))).toEqual(before)
    expect(readdirSync(directory)).toEqual(entries)
  }
})

it('rejects a self-referential parent without changing config or adding files', async () => {
  initialize()
  const directory = projectDirectory(repository)
  const before = readFileSync(join(directory, 'config.yaml'))
  const entries = readdirSync(directory)
  vi.mocked(ghApi).mockResolvedValue({
    full_name: repository.path,
    fork: true,
    parent: { full_name: repository.path },
  })

  await expect(refreshParentRelation(repository)).rejects.toThrow(/self-referential parent/i)
  expect(readFileSync(join(directory, 'config.yaml'))).toEqual(before)
  expect(readdirSync(directory)).toEqual(entries)
})

it('refreshes an archived project without restoring it or changing its tracking choice', async () => {
  initialize()
  const snapshot = store.load()!
  const archived = store.update({
    lifecycle: { status: 'archived', archived_at: '2026-09-01T00:00:00Z' },
    tracking: { status: 'configured', sources: [parent] },
  }, snapshot)!
  vi.mocked(ghApi).mockResolvedValue({
    full_name: repository.path,
    fork: true,
    parent: { full_name: parent.path },
  })

  const result = await refreshParentRelation(repository)

  expect(result.status).toBe('refreshed')
  expect(store.load()).toEqual({ ...archived, parent: result.parent })
  expect(readdirSync(projectDirectory(repository))).toEqual(['config.yaml'])
})

it('preserves the previous relationship on network failure or identity change', async () => {
  const previous: ParentConfig = { status: 'none', relation_verified_at: '2026-09-01T00:00:00Z' }
  initialize(previous)
  const configPath = join(projectDirectory(repository), 'config.yaml')
  const before = readFileSync(configPath)
  vi.mocked(ghApi).mockRejectedValueOnce(new Error('offline'))
  await expect(refreshParentRelation(repository)).rejects.toThrow('offline')
  expect(readFileSync(configPath)).toEqual(before)
  vi.mocked(ghApi).mockResolvedValueOnce({ full_name: 'renamed/ui', fork: false })
  await expect(refreshParentRelation(repository)).rejects.toThrow(/identity changed/i)
  expect(store.load()?.parent).toEqual(previous)
  expect(readFileSync(configPath)).toEqual(before)
})

it('does not overwrite a config changed while the network request was running', async () => {
  initialize()
  vi.mocked(ghApi).mockImplementationOnce(async () => {
    const snapshot = store.load()!
    store.update({ tracking: { status: 'none' } }, snapshot)
    return { full_name: repository.path, fork: false }
  })

  await expect(refreshParentRelation(repository)).rejects.toThrow(/changed since it was read/i)
  expect(store.load()?.parent).toEqual({ status: 'unknown' })
  expect(store.load()?.tracking).toEqual({ status: 'none' })
})

it('does not query an uninitialized or unsupported project', async () => {
  await expect(refreshParentRelation(repository)).rejects.toThrow(/not initialized/i)
  await expect(refreshParentRelation({
    platform: 'gitlab',
    instance: 'https://internal.example/gitlab',
    path: 'team/ui',
  })).rejects.toThrow(/only repositories on GitHub\.com/)
  expect(ghApi).not.toHaveBeenCalled()
  expect(existsSync(join(home, '.contribbot'))).toBe(false)
})

it('rejects unsupported instance refresh without touching an existing config', async () => {
  const other: RepositoryRef = { ...repository, instance: 'https://github.example.invalid' }
  const directory = projectDirectory(other)
  new RepoConfig(directory).save({
    schema_version: 3, repository: other, lifecycle: { status: 'active' },
    parent: { status: 'unknown' }, tracking: { status: 'none' },
  })
  const before = readFileSync(join(directory, 'config.yaml'))

  await expect(refreshParentRelation(other)).rejects.toThrow(/only repositories on GitHub\.com/)
  expect(ghApi).not.toHaveBeenCalled()
  expect(readFileSync(join(directory, 'config.yaml'))).toEqual(before)
  expect(readdirSync(directory)).toEqual(['config.yaml'])
})

it('does not silently normalize a different instance identity', async () => {
  initialize()
  await expect(refreshParentRelation({ ...repository, instance: 'https://github.com/' }))
    .rejects.toThrow(/normalized instance URL/i)
  expect(ghApi).not.toHaveBeenCalled()
  expect(store.load()?.parent).toEqual({ status: 'unknown' })
})
