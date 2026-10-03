import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RepoConfig } from '../../storage/repo-config.js'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'
import { projectGuidance, renderGuidance } from './project-guidance.js'

const fixture = vi.hoisted(() => ({ home: '', ghApi: vi.fn() }))
const github: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'owner/repo' }
const gitlab: RepositoryRef = { platform: 'gitlab', instance: 'https://code.example.com/gitlab', path: 'owner/repo' }
const otherInstance: RepositoryRef = { platform: 'github', instance: 'https://github.example.com', path: 'owner/repo' }
vi.mock('node:os', async (original) => ({
  ...await original<typeof import('node:os')>(), homedir: () => fixture.home,
}))
vi.mock('../../clients/github.js', async (original) => ({
  ...await original<typeof import('../../clients/github.js')>(), ghApi: fixture.ghApi,
}))

describe('renderGuidance', () => {
  it('explains the fallback when no guidance exists', () => {
    const output = renderGuidance('owner/repo', [])

    expect(output).toContain('No guidance documents were found')
    expect(output).toContain('Branch naming fallback')
  })

  it('renders repository guidance before local knowledge', () => {
    const output = renderGuidance('owner/repo', [
      { source: 'repository', path: 'CONTRIBUTING.md', content: 'Use feature/* branches.', url: 'https://github.com/owner/repo/blob/HEAD/CONTRIBUTING.md' },
      { source: 'knowledge', path: 'knowledge/branching', content: 'Prefer short branch names.' },
    ])

    expect(output.indexOf('repository: CONTRIBUTING.md')).toBeLessThan(output.indexOf('knowledge: knowledge/branching'))
    expect(output).toContain('Use feature/* branches.')
    expect(output).toContain('Prefer short branch names.')
  })
})

describe('projectGuidance loading', () => {
  beforeEach(() => {
    fixture.home = mkdtempSync(join(tmpdir(), 'contribbot-guidance-'))
    fixture.ghApi.mockReset()
    fixture.ghApi.mockRejectedValue(new Error('Fixture: guidance file not found'))
  })
  afterEach(() => { rmSync(fixture.home, { recursive: true, force: true }) })

  const knowledge = (repository: RepositoryRef, name: string, content: string) => {
    const directory = join(projectDirectory(repository), 'knowledge', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'README.md'), content)
  }

  it('loads repository guidance and only nonempty knowledge from the requested project', async () => {
    new RepoConfig(projectDirectory(github)).save({
      schema_version: 3, repository: github, lifecycle: { status: 'active' },
      parent: { status: 'unknown' }, tracking: { status: 'pending' },
    })
    knowledge(github, 'checks', 'Project check command: pnpm test.')
    knowledge(github, 'empty', '')
    knowledge({ ...github, path: 'other/repo' }, 'private', 'Unrelated project instructions.')
    knowledge(gitlab, 'gitlab-only', 'Private GitLab knowledge.')
    knowledge(otherInstance, 'self-hosted', 'Different instance knowledge.')
    const legacy = join(fixture.home, '.contribbot', 'owner', 'repo', 'knowledge', 'legacy')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'README.md'), 'Old directory knowledge.')
    fixture.ghApi.mockImplementation(async (path: string) => {
      if (path !== '/repos/owner/repo/contents/CONTRIBUTING.md') throw new Error('Fixture: missing')
      return { type: 'file', path: 'CONTRIBUTING.md', encoding: 'base64', content: Buffer.from('Keep user edits.').toString('base64') }
    })
    const output = await projectGuidance(github)
    expect(output).toContain('Keep user edits.')
    expect(output).toContain('Project check command: pnpm test.')
    expect(output.indexOf('repository: CONTRIBUTING.md')).toBeLessThan(output.indexOf('knowledge: knowledge/checks'))
    expect(output).not.toContain('knowledge/empty')
    expect(output).not.toContain('Unrelated project instructions.')
    expect(output).not.toContain('Private GitLab knowledge.')
    expect(output).not.toContain('Different instance knowledge.')
    expect(output).not.toContain('Old directory knowledge.')
    expect(fixture.ghApi.mock.calls.every(([path]) => path.startsWith('/repos/owner/repo/contents/'))).toBe(true)
  })

  it('does not require a local knowledge directory to return the fallback', async () => {
    const output = await projectGuidance(github)
    expect(output).toContain('No guidance documents were found')
    expect(output).toContain('Branch naming fallback')
  })

  it('does not read local guidance through a linked knowledge directory', async () => {
    new RepoConfig(projectDirectory(github)).save({
      schema_version: 3, repository: github, lifecycle: { status: 'active' },
      parent: { status: 'unknown' }, tracking: { status: 'pending' },
    })
    const outside = join(fixture.home, 'outside')
    mkdirSync(join(outside, 'private'), { recursive: true })
    writeFileSync(join(outside, 'private', 'README.md'), 'Private guidance')
    symlinkSync(outside, join(projectDirectory(github), 'knowledge'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(projectGuidance(github)).rejects.toThrow(/symbolic link/i)
  })

  it('rejects unsupported platform and instance before calling GitHub', async () => {
    await expect(projectGuidance(gitlab)).rejects.toThrow(/only.*GitHub\.com/i)
    await expect(projectGuidance(otherInstance)).rejects.toThrow(/only.*GitHub\.com/i)
    expect(fixture.ghApi).not.toHaveBeenCalled()
  })

  it('requires the complete repository object instead of an owner/repo shorthand', async () => {
    await expect(projectGuidance('owner/repo' as unknown as RepositoryRef))
      .rejects.toThrow('Repository must be an object with exactly platform, instance, and path.')
    expect(fixture.ghApi).not.toHaveBeenCalled()
  })
})
