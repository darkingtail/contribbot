import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore } from '../../storage/todo-store.js'
import { getContribDir } from '../../utils/config.js'
import { todoAdd } from '../core/todos.js'
import { issueCreate } from './issue-create.js'

const github = vi.hoisted(() => ({
  createIssue: vi.fn(),
  getIssue: vi.fn(),
  parseRepo: vi.fn(),
}))

vi.mock('../../clients/github.js', () => github)
vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockResolvedValue({ owner: 'owner', name: 'repo' }),
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
    const dir = getContribDir('owner', 'repo')
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(dir, 'todos.yaml.tmp'))

    await expect(issueCreate('Created issue', undefined, 'bug', undefined, undefined, true, 'owner/repo'))
      .rejects.toThrow(/owner\/repo#123.*todo_add/s)

    rmSync(join(dir, 'todos.yaml.tmp'), { recursive: true, force: true })
    await todoAdd('', '#123', 'owner/repo')

    expect(github.createIssue).toHaveBeenCalledTimes(1)
    expect(new TodoStore(dir).findByRef('#123')).toMatchObject({ title: 'Created issue', type: 'bug' })
  })
})
