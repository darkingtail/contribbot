import { testProjectDirectory, testRepository } from '../../utils/test-repository.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore } from '../../storage/todo-store.js'
import { UpstreamStore } from '../../storage/upstream-store.js'
import { getProjectDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { todoAdd } from '../core/todos.js'
import { issueCreate } from './issue-create.js'

const github = vi.hoisted(() => ({
  createIssue: vi.fn(),
  getIssue: vi.fn(),
  parseRepo: vi.fn(),
}))

vi.mock('../../clients/github.js', () => github)
vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockImplementation(async () => ({
    owner: 'owner', name: 'repo', directory: testProjectDirectory(),
    repository: { platform: 'github', instance: 'https://github.com', path: 'owner/repo' },
  })),
}))

describe('issueCreate', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'issue-create-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    github.createIssue.mockReset().mockResolvedValue({
      number: 123,
      html_url: 'https://github.com/owner/repo/issues/123',
    })
    github.getIssue.mockReset().mockResolvedValue({ title: 'Created issue', labels: ['bug'] })
    github.parseRepo.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('reports remote issue success and recovers locally without creating another issue', async () => {
    const dir = testProjectDirectory()
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(dir, 'todos.yaml.tmp'))

    await expect(issueCreate('Created issue', undefined, 'bug', undefined, undefined, true, testRepository))
      .rejects.toThrow(/owner\/repo#123.*todo_add/s)

    rmSync(join(dir, 'todos.yaml.tmp'), { recursive: true, force: true })
    await todoAdd('', '#123', testRepository)

    expect(github.createIssue).toHaveBeenCalledTimes(1)
    expect(new TodoStore(dir).findByRef('#123')).toMatchObject({ title: 'Created issue', type: 'bug' })
  })

  it('links only the specified source when two instances share a path and commit SHA', async () => {
    const directory = testProjectDirectory()
    const first = { platform: 'gitlab', instance: 'https://first.example.com/gitlab', path: 'team/ui' } as const
    const second = { ...first, instance: 'https://second.example.com/gitlab' } as const
    const store = new UpstreamStore(directory)
    for (const source of [first, second]) {
      store.addDailyCommits(source, [
        { sha: 'abcdef0123456789', message: source.instance, type: 'feat', date: '2026-10-02' },
      ])
    }

    await expect(issueCreate('Created issue', undefined, undefined, 'abcdef0', second, false, testRepository))
      .resolves.toContain('Linked upstream commit abcdef0')
    expect(store.getDaily(first).commits[0]).toMatchObject({ action: null, ref: null })
    expect(store.getDaily(second).commits[0]).toMatchObject({ action: 'issue', ref: '#123' })
    expect(github.createIssue).toHaveBeenCalledTimes(1)
  })

  it('rejects a shorthand source before creating a remote issue', async () => {
    await expect(issueCreate('Invalid source', undefined, undefined, 'abcdef0', 'team/ui' as never, false, testRepository))
      .rejects.toThrow()
    expect(github.createIssue).not.toHaveBeenCalled()
  })

  it.each([
    { platform: 'gitlab', instance: 'https://code.example.com/gitlab', path: 'owner/repo' },
    { platform: 'github', instance: 'https://github.example.com', path: 'owner/repo' },
  ] as const)('rejects unsupported $platform instance before remote and local effects', async (repository) => {
    const directory = getProjectDir(repository)
    vi.mocked(resolveRepo).mockResolvedValueOnce({ repository, directory, owner: 'owner', name: 'repo' })

    await expect(issueCreate('Wrong destination', undefined, undefined, undefined, undefined, true, repository))
      .rejects.toThrow(/GitHub\.com repositories only; no remote changes/)

    expect(github.createIssue).not.toHaveBeenCalled()
    expect(existsSync(directory)).toBe(false)
  })
})
