import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getLatestRelease, getReleaseByTag, searchCommits } from '../../clients/github.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { SyncReportStore } from '../../storage/sync-report-store.js'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'
import { syncHistory, upstreamSyncCheck } from './upstream-sync-check.js'

vi.mock('../../clients/github.js', async original => ({
  ...await original<typeof import('../../clients/github.js')>(),
  getLatestRelease: vi.fn().mockResolvedValue({
    tag_name: 'v1.0.0',
    body: '',
  }),
  getReleaseByTag: vi.fn(),
  searchCommits: vi.fn().mockResolvedValue([]),
}))

let home: string
const path = 'team/ui'
const first: RepositoryRef = { platform: 'gitlab', instance: 'https://code.example.com/gitlab', path }
const second: RepositoryRef = { platform: 'gitlab', instance: 'https://gitlab.com', path }
const upstream: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'upstream/ui' }

function initialize(repository: RepositoryRef): void {
  new RepoConfig(projectDirectory(repository)).save({
    schema_version: 3,
    repository,
    lifecycle: { status: 'active' },
    parent: { status: 'unknown' },
    tracking: { status: 'pending' },
  })
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'contribbot-sync-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.mocked(getLatestRelease).mockResolvedValue({
    tag_name: 'v1.0.0',
    html_url: 'https://github.com/upstream/ui/releases/tag/v1.0.0',
    body: '',
    published_at: null,
  })
  vi.mocked(searchCommits).mockResolvedValue([])
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

it.each([first, { platform: 'github', instance: 'https://github.example.com', path } satisfies RepositoryRef])(
  'rejects unsupported source $platform at $instance before release requests or local writes',
  async (source) => {
    const target: RepositoryRef = { platform: 'github', instance: 'https://github.com', path }
    initialize(target)
    await expect(upstreamSyncCheck(undefined, source, target, true))
      .rejects.toThrow(/GitHub operation does not support/)
    expect(getLatestRelease).not.toHaveBeenCalled()
    expect(getReleaseByTag).not.toHaveBeenCalled()
    expect(searchCommits).not.toHaveBeenCalled()
    expect(existsSync(join(projectDirectory(target), 'sync'))).toBe(false)
  },
)

it('reads sync history only from the requested instance', async () => {
  initialize(first)
  initialize(second)
  const directory = join(projectDirectory(first), 'sync')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'v1.md'), '**Total**: 3 | ❌ Not synced: 1')

  expect(await syncHistory(first)).toContain('legacy sync/*.md report(s) were not imported or read')
  expect(await syncHistory(second)).toContain('No records yet')
  expect(readFileSync(join(directory, 'v1.md'), 'utf-8')).toContain('Not synced: 1')
})

it('lists only identified reports, including the source instance and target branch', async () => {
  initialize(first)
  initialize(second)
  new SyncReportStore(projectDirectory(first)).save(upstream, 'v1', null, '**Total**: 3 | ❌ Not synced: 1')
  new SyncReportStore(projectDirectory(first)).save(upstream, 'v1', 'feature/ui', '**Total**: 2 | ❌ Not synced: 0')

  const result = await syncHistory(first)
  expect(result).toContain('github://github.com/upstream/ui')
  expect(result).toContain('feature/ui')
  expect(result).toContain('(all)')
  expect(result).toContain('3 PRs，1 未对齐')
  expect(await syncHistory(second)).toContain('No records yet')
})

it('saves branch-specific release reports without colliding with legacy files', async () => {
  const github: RepositoryRef = { platform: 'github', instance: 'https://github.com', path }
  initialize(github)
  const legacy = join(projectDirectory(github), 'sync', 'v1.0.0.md')
  mkdirSync(join(projectDirectory(github), 'sync'), { recursive: true })
  writeFileSync(legacy, 'legacy')
  vi.mocked(getLatestRelease).mockResolvedValue({
    tag_name: 'v1.0.0',
    html_url: 'https://github.com/upstream/ui/releases/tag/v1.0.0',
    body: '- feat: Added widget (#1234)',
    published_at: '2026-10-01T00:00:00Z',
  })
  const firstResult = await upstreamSyncCheck(undefined, upstream, github, true, 'feature/ui')
  const secondResult = await upstreamSyncCheck(undefined, upstream, github, true)

  expect(firstResult).toContain('Saved to')
  expect(secondResult).toContain('Saved to')
  expect(vi.mocked(searchCommits)).toHaveBeenCalledWith('team', 'ui', expect.any(String), 5, 'feature/ui')
  expect(new SyncReportStore(projectDirectory(github)).list().reports).toHaveLength(2)
  expect(await syncHistory(github)).toContain('feature/ui')
  expect(readFileSync(legacy, 'utf8')).toBe('legacy')
})

it('reports a saved result as partial when daily marking fails', async () => {
  const github: RepositoryRef = { platform: 'github', instance: 'https://github.com', path }
  initialize(github)
  vi.mocked(getLatestRelease).mockResolvedValue({
    tag_name: 'v1',
    html_url: 'https://github.com/upstream/ui/releases/tag/v1',
    body: '- fix: Corrected widget (#1234)',
    published_at: '2026-10-01T00:00:00Z',
  })
  writeFileSync(join(projectDirectory(github), 'upstream.yaml'), 'legacy: invalid')
  const result = await upstreamSyncCheck(undefined, upstream, github, true)
  expect(result).toContain('Report saved, but daily commit marking failed')
  expect(new SyncReportStore(projectDirectory(github)).list().reports).toHaveLength(1)
})

it('rejects orphan sync data without a verified v3 project config', async () => {
  const directory = join(projectDirectory(first), 'sync')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'v1.md'), '**Total**: 3')

  await expect(syncHistory(first)).rejects.toThrow(/not initialized/i)
  expect(readFileSync(join(directory, 'v1.md'), 'utf-8')).toBe('**Total**: 3')
})

it('rejects a project directory whose config belongs to another repository', async () => {
  initialize(first)
  const configPath = join(projectDirectory(first), 'config.yaml')
  writeFileSync(configPath, readFileSync(configPath, 'utf-8').replace(first.path, 'other/repo'))

  await expect(syncHistory(first)).rejects.toThrow(/identity does not match/i)
})

it('does not read sync history through a linked directory', async () => {
  initialize(first)
  const outside = join(home, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'v1.md'), '**Total**: 99')
  symlinkSync(outside, join(projectDirectory(first), 'sync'), process.platform === 'win32' ? 'junction' : 'dir')

  await expect(syncHistory(first)).rejects.toThrow(/symbolic link/i)
})

it.skipIf(process.platform === 'win32')('does not read a linked sync history file', async () => {
  initialize(first)
  const outside = join(home, 'outside.md')
  writeFileSync(outside, '**Total**: 99')
  const directory = join(projectDirectory(first), 'sync')
  mkdirSync(directory)
  symlinkSync(outside, join(directory, 'v1.md'), 'file')

  await expect(syncHistory(first)).rejects.toThrow(/symbolic link/i)
})

it('rejects GitLab before calling GitHub release endpoints', async () => {
  await expect(upstreamSyncCheck(undefined, upstream, first))
    .rejects.toThrow(/only repositories on GitHub\.com/)
})

it('does not save release history without an initialized project', async () => {
  const github: RepositoryRef = { platform: 'github', instance: 'https://github.com', path }

  await expect(upstreamSyncCheck(undefined, upstream, github, true))
    .rejects.toThrow(/not initialized/i)
  expect(existsSync(projectDirectory(github))).toBe(false)
})

it('compares without saving for an uninitialized GitHub.com project', async () => {
  const github: RepositoryRef = { platform: 'github', instance: 'https://github.com', path }

  expect(await upstreamSyncCheck(undefined, upstream, github)).toContain('No PRs found')
  expect(existsSync(projectDirectory(github))).toBe(false)
})

it('does not save release history through a linked sync directory', async () => {
  const github: RepositoryRef = { platform: 'github', instance: 'https://github.com', path }
  initialize(github)
  const outside = join(home, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(projectDirectory(github), 'sync'), process.platform === 'win32' ? 'junction' : 'dir')

  await expect(upstreamSyncCheck(undefined, upstream, github, true))
    .rejects.toThrow(/symbolic link/i)
  expect(existsSync(join(outside, 'v1.md'))).toBe(false)
})
