import { testRepository } from '../../utils/test-repository.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepoConfig } from '../../storage/repo-config.js'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'
import { projectDashboard } from './project-dashboard.js'

vi.mock('../../clients/github.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../clients/github.js')>(),
  getRepoIssues: vi.fn().mockResolvedValue([]),
  getRepoPulls: vi.fn().mockResolvedValue([]),
  getRepoCommits: vi.fn().mockResolvedValue([]),
  getLatestRelease: vi.fn().mockResolvedValue(null),
}))

const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'project-dashboard-home-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
})

afterEach(() => {
  process.env.HOME = originalHome
  process.env.USERPROFILE = originalUserProfile
  rmSync(home, { recursive: true, force: true })
})

function addKnowledge(repository: RepositoryRef, name: string): void {
  const directory = projectDirectory(repository)
  new RepoConfig(directory).save({
    schema_version: 3,
    repository,
    lifecycle: { status: 'active' },
    parent: { status: 'unknown' },
    tracking: { status: 'pending' },
  })
  const knowledgeDir = join(directory, 'knowledge', name)
  mkdirSync(knowledgeDir, { recursive: true })
  writeFileSync(join(knowledgeDir, 'README.md'), `---\ndescription: ${name} summary\n---\n# ${name}\n`)
}

describe('projectDashboard knowledge', () => {
  it('reads only the v3 GitHub.com project and does not mix identical paths on other instances', async () => {
    addKnowledge({ platform: 'github', instance: 'https://github.com', path: 'owner/repo' }, 'main-note')
    addKnowledge({ platform: 'gitlab', instance: 'https://code.example.com/gitlab', path: 'owner/repo' }, 'private-note')
    mkdirSync(join(home, '.contribbot', 'owner', 'repo', 'knowledge', 'legacy-note'), { recursive: true })
    writeFileSync(
      join(home, '.contribbot', 'owner', 'repo', 'knowledge', 'legacy-note', 'README.md'),
      '# Legacy\n',
    )

    const output = await projectDashboard(testRepository)
    expect(output).toContain('main-note summary')
    expect(output).not.toContain('private-note')
    expect(output).not.toContain('legacy-note')
    expect(output).not.toContain('knowledge://owner/repo')
  })
})
