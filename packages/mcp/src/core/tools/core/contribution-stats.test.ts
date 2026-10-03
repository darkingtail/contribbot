import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'
import { contributionStats } from './contribution-stats.js'

const github = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  searchIssues: vi.fn(),
}))

vi.mock('../../clients/github.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../clients/github.js')>(),
  ...github,
}))

describe('contributionStats across configured projects', () => {
  let home: string

  function addProject(repository: RepositoryRef): string {
    const directory = projectDirectory(repository, join(home, '.contribbot'))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'config.yaml'), stringify({
      schema_version: 3,
      repository,
      lifecycle: { status: 'active' },
      parent: { status: 'unknown' },
      tracking: { status: 'pending' },
    }))
    return directory
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'contribution-stats-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    github.getCurrentUser.mockReset().mockResolvedValue({ login: 'tester' })
    github.searchIssues.mockReset().mockResolvedValue([])
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('reads v3 GitHub.com projects and ignores old owner/repo directories', async () => {
    addProject({ platform: 'github', instance: 'https://github.com', path: 'team/project' })
    mkdirSync(join(home, '.contribbot', 'old-owner', 'old-project'), { recursive: true })

    const result = await contributionStats(7, 'tester')

    expect(result).toContain('team/project')
    expect(result).not.toContain('old-project')
    expect(github.searchIssues).toHaveBeenCalledTimes(3)
    expect(github.searchIssues.mock.calls.every(([query]) => query.includes('repo:team/project'))).toBe(true)
  })

  it.each([
    { platform: 'gitlab', instance: 'https://code.example.com/gitlab', path: 'team/project' },
    { platform: 'github', instance: 'https://github.enterprise.test', path: 'team/project' },
  ] as const)('rejects an unsupported $platform instance before any GitHub request', async repository => {
    addProject({ platform: 'github', instance: 'https://github.com', path: 'team/project' })
    addProject(repository)

    await expect(contributionStats(7)).rejects.toThrow(/GitHub\.com/)
    expect(github.getCurrentUser).not.toHaveBeenCalled()
    expect(github.searchIssues).not.toHaveBeenCalled()
  })

  it('rejects an invalid v3 project instead of reporting incomplete statistics', async () => {
    const directory = addProject({ platform: 'github', instance: 'https://github.com', path: 'team/project' })
    writeFileSync(join(directory, 'config.yaml'), 'schema_version: 2\n')

    await expect(contributionStats(7, 'tester')).rejects.toThrow(/schema v3/)
    expect(github.searchIssues).not.toHaveBeenCalled()
  })

  it('queries a complete GitHub.com repository identity when explicitly scoped', async () => {
    const repo = { platform: 'github', instance: 'https://github.com', path: 'team/project' } as const
    const result = await contributionStats(7, 'tester', repo)

    expect(result).toContain('team/project')
    expect(github.searchIssues).toHaveBeenCalledTimes(3)
    expect(github.searchIssues.mock.calls.every(([query]) => query.includes('repo:team/project'))).toBe(true)
  })

  it.each([
    { platform: 'gitlab', instance: 'https://code.example.com/gitlab', path: 'team/project' },
    { platform: 'github', instance: 'https://github.enterprise.test', path: 'team/project' },
  ] as const)('rejects explicit unsupported $platform repositories before GitHub requests', async repository => {
    await expect(contributionStats(7, undefined, repository)).rejects.toThrow(/does not support/)
    expect(github.getCurrentUser).not.toHaveBeenCalled()
    expect(github.searchIssues).not.toHaveBeenCalled()
  })
})
