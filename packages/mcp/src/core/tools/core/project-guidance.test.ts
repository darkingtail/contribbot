import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectGuidance, renderGuidance } from './project-guidance.js'

const fixture = vi.hoisted(() => ({ home: '', ghApi: vi.fn() }))
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

  const knowledge = (repo: string, name: string, content: string) => {
    const directory = join(fixture.home, '.contribbot', ...repo.split('/'), 'knowledge', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'README.md'), content)
  }

  it('loads repository guidance and only nonempty knowledge from the requested project', async () => {
    knowledge('owner/repo', 'checks', 'Project check command: pnpm test.')
    knowledge('owner/repo', 'empty', '')
    knowledge('other/repo', 'private', 'Unrelated project instructions.')
    fixture.ghApi.mockImplementation(async (path: string) => {
      if (path !== '/repos/owner/repo/contents/CONTRIBUTING.md') throw new Error('Fixture: missing')
      return { type: 'file', path: 'CONTRIBUTING.md', encoding: 'base64', content: Buffer.from('Keep user edits.').toString('base64') }
    })
    const output = await projectGuidance('owner/repo')
    expect(output).toContain('Keep user edits.')
    expect(output).toContain('Project check command: pnpm test.')
    expect(output.indexOf('repository: CONTRIBUTING.md')).toBeLessThan(output.indexOf('knowledge: knowledge/checks'))
    expect(output).not.toContain('knowledge/empty')
    expect(output).not.toContain('Unrelated project instructions.')
    expect(fixture.ghApi.mock.calls.every(([path]) => path.startsWith('/repos/owner/repo/contents/'))).toBe(true)
  })

  it('does not require a local knowledge directory to return the fallback', async () => {
    const output = await projectGuidance('owner/repo')
    expect(output).toContain('No guidance documents were found')
    expect(output).toContain('Branch naming fallback')
  })
})
