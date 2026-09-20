import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ghApi } from '../../clients/github.js'
import { repoInfo } from './repo-info.js'

vi.mock('../../clients/github.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../clients/github.js')>(),
  ghApi: vi.fn(),
}))

const repository = {
  full_name: 'verified/component-library',
  html_url: 'https://github.com/verified/component-library',
  description: 'A component library',
  stargazers_count: 1,
  forks_count: 0,
  watchers_count: 1,
  open_issues_count: 0,
  topics: [],
  created_at: '2026-01-01T00:00:00Z',
  pushed_at: '2026-01-01T00:00:00Z',
  visibility: 'public',
  default_branch: 'main',
  fork: false,
}

beforeEach(() => { vi.resetAllMocks() })

describe('repoInfo upstream candidate identity', () => {
  it('shows the API-returned identity and URL, including after a rename', async () => {
    vi.mocked(ghApi).mockImplementation(async path => (
      path.endsWith('/contributors') ? [] : repository
    ))

    const result = await repoInfo('old-name/library')

    expect(ghApi).toHaveBeenCalledWith('/repos/old-name/library')
    expect(result).toContain(`[${repository.full_name}](${repository.html_url})`)
    expect(result).toContain(repository.description)
    expect(result).not.toContain('https://github.com/old-name/library')
  })

  it('keeps the verified URL when optional contributors are unavailable', async () => {
    vi.mocked(ghApi).mockImplementation(async path => {
      if (path.endsWith('/contributors')) throw new Error('Forbidden')
      return repository
    })
    expect(await repoInfo('verified/component-library')).toContain(repository.html_url)
  })

  it('does not produce a verified candidate when repository lookup fails', async () => {
    vi.mocked(ghApi).mockRejectedValue(new Error('Repository lookup unavailable'))
    await expect(repoInfo('unknown/library')).rejects.toThrow('Repository lookup unavailable')
  })
})
