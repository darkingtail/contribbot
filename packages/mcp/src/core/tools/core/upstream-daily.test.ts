import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { UpstreamStore } from '../../storage/upstream-store.js'
import { upstreamDaily, upstreamDailyAct, upstreamDailySkipNoise } from './upstream-daily.js'

const github = vi.hoisted(() => ({ listReleases: vi.fn(), listTags: vi.fn(), getCompareCommits: vi.fn(), searchIssues: vi.fn() }))
vi.mock('../../clients/github.js', async (original) => ({
  ...await original<typeof import('../../clients/github.js')>(),
  ...github,
}))

let home: string
const source: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'source/ui' }
const unsupportedSources: RepositoryRef[] = [
  { platform: 'gitlab', instance: 'https://code.example.com/gitlab', path: 'source/ui' },
  { platform: 'github', instance: 'https://github.example.com', path: 'source/ui' },
]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'contribbot-daily-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

it.each(unsupportedSources)('rejects unsupported source $platform at $instance before GitHub requests or local writes', async (unsupportedSource) => {
  const repository: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'owner/repo' }
  const directory = projectDirectory(repository)
  new RepoConfig(directory).save({
    schema_version: 3, repository,
    lifecycle: { status: 'active' }, parent: { status: 'unknown' }, tracking: { status: 'pending' },
  })

  await expect(upstreamDaily(unsupportedSource, repository, 'v1')).rejects.toThrow(/GitHub operation does not support/)
  expect(github.listReleases).not.toHaveBeenCalled()
  expect(github.listTags).not.toHaveBeenCalled()
  expect(github.getCompareCommits).not.toHaveBeenCalled()
  expect(github.searchIssues).not.toHaveBeenCalled()
  expect(existsSync(join(directory, 'upstream.yaml'))).toBe(false)
})

it.each([
  { platform: 'gitlab', instance: 'https://code.example.com/gitlab', path: 'group/subgroup/ui' },
  { platform: 'github', instance: 'https://github.example.com', path: 'team/ui' },
] satisfies RepositoryRef[])('rejects unsupported target $platform at $instance before GitHub requests or local writes', async (repository) => {
  await expect(upstreamDaily(source, repository, 'v1')).rejects.toThrow(/only repositories on GitHub\.com/)
  expect(github.listReleases).not.toHaveBeenCalled()
  expect(github.listTags).not.toHaveBeenCalled()
  expect(github.getCompareCommits).not.toHaveBeenCalled()
  expect(github.searchIssues).not.toHaveBeenCalled()
  expect(existsSync(projectDirectory(repository))).toBe(false)
})

it('requires an initialized GitHub.com project before querying releases or writing an anchor', async () => {
  const repository: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'owner/repo' }
  await expect(upstreamDaily(source, repository, 'v1')).rejects.toThrow(/not initialized.*project_init/i)
  expect(github.listReleases).not.toHaveBeenCalled()
  expect(github.listTags).not.toHaveBeenCalled()
  expect(github.getCompareCommits).not.toHaveBeenCalled()
  expect(github.searchIssues).not.toHaveBeenCalled()
  expect(existsSync(projectDirectory(repository))).toBe(false)
})

const unsupportedTargets = [
  { platform: 'gitlab', instance: 'https://code.example.com/gitlab', path: 'group/subgroup/ui' },
  { platform: 'github', instance: 'https://github.example.com', path: 'team/ui' },
] satisfies RepositoryRef[]

it.each(unsupportedTargets.flatMap(repository => ['act', 'skip-noise'].map(action => ({ repository, action }))))(
  'rejects $action for unsupported target $repository.platform at $repository.instance without changing stored commits',
  async ({ repository, action }) => {
    const directory = projectDirectory(repository)
    new RepoConfig(directory).save({
      schema_version: 3, repository,
      lifecycle: { status: 'active' }, parent: { status: 'unknown' }, tracking: { status: 'pending' },
    })
    const store = new UpstreamStore(directory)
    store.addDailyCommits(source, [{ sha: 'abcdef0123456789', message: 'ci: update workflow', type: 'ci', date: '2026-10-01' }])
    const file = join(directory, 'upstream.yaml')
    const before = readFileSync(file, 'utf8')

    const operation = action === 'act'
      ? upstreamDailyAct(source, 'abcdef0', 'todo', undefined, repository)
      : upstreamDailySkipNoise(source, repository)
    await expect(operation).rejects.toThrow(/only repositories on GitHub\.com/)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(github.listReleases).not.toHaveBeenCalled()
    expect(github.listTags).not.toHaveBeenCalled()
    expect(github.getCompareCommits).not.toHaveBeenCalled()
    expect(github.searchIssues).not.toHaveBeenCalled()
  },
)

it('continues to update daily commits for an initialized GitHub.com project', async () => {
  const repository: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'owner/repo' }
  const directory = projectDirectory(repository)
  new RepoConfig(directory).save({
    schema_version: 3, repository,
    lifecycle: { status: 'active' }, parent: { status: 'unknown' }, tracking: { status: 'pending' },
  })
  const store = new UpstreamStore(directory)
  store.addDailyCommits(source, [
    { sha: 'abcdef0123456789', message: 'feat: button', type: 'feat', date: '2026-10-01' },
    { sha: '123456789abcdef0', message: 'ci: update workflow', type: 'ci', date: '2026-10-01' },
  ])

  await expect(upstreamDailyAct(source, 'abcdef0', 'todo', undefined, repository)).resolves.toContain('action')
  await expect(upstreamDailySkipNoise(source, repository)).resolves.toContain('Skipped **1**')
  expect(store.getDaily(source).commits.map(commit => commit.action)).toEqual(['todo', 'skip'])
})

it('fetches GitHub commits into the exact source identity without touching a same-path source', async () => {
  const repository: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'owner/repo' }
  const directory = projectDirectory(repository)
  new RepoConfig(directory).save({
    schema_version: 3, repository,
    lifecycle: { status: 'active' }, parent: { status: 'unknown' }, tracking: { status: 'pending' },
  })
  const other: RepositoryRef = { ...source, instance: 'https://github.example.com' }
  const store = new UpstreamStore(directory)
  store.addVersion(other, 'other-anchor', [])
  store.addDailyCommits(other, [
    { sha: 'abcdef0123456789', message: 'other instance', type: 'feat', date: '2026-10-01' },
  ])
  github.listReleases.mockResolvedValue([])
  github.getCompareCommits.mockResolvedValue({
    commits: [{
      sha: 'abcdef0123456789',
      commit: { message: 'feat: new | widget', author: { date: '2026-10-02T00:00:00Z' } },
    }],
  })
  github.searchIssues.mockResolvedValue([])

  const output = await upstreamDaily(source, repository, 'v1')
  expect(output).toContain('1 new')
  expect(output).toContain('feat: new \\| widget')
  expect(github.getCompareCommits).toHaveBeenCalledWith('source', 'ui', 'v1', 'HEAD')
  expect(store.getLatestVersionTag(source)).toBe('v1')
  expect(store.getDaily(source).commits[0]).toMatchObject({ message: 'feat: new | widget', action: null })
  expect(store.getLatestVersionTag(other)).toBe('other-anchor')
  expect(store.getDaily(other).commits[0]).toMatchObject({ message: 'other instance', action: null })
})
