import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepoConfig } from '../../storage/repo-config.js'
import { TodoStore } from '../../storage/todo-store.js'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'
import { todoActivate } from './todo-activate.js'
import { todoDetail } from './todo-detail.js'
import { todoUpdate } from './todo-update.js'
import { todoAdd, todoList } from './todos.js'

const github = vi.hoisted(() => ({
  getIssue: vi.fn(),
  getIssueComments: vi.fn(),
  getPull: vi.fn(),
  getPullReviews: vi.fn(),
}))
vi.mock('../../clients/github.js', () => github)

const repositories: RepositoryRef[] = [
  { platform: 'gitlab', instance: 'https://code.example.test/gitlab', path: 'team/repo' },
  { platform: 'github', instance: 'https://github.example.test', path: 'team/repo' },
]

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'todo-platform-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  github.getIssue.mockReset()
  github.getIssueComments.mockReset()
  github.getPull.mockReset()
  github.getPullReviews.mockReset()
  for (const repository of repositories) {
    new RepoConfig(projectDirectory(repository)).save({
      schema_version: 3,
      repository,
      lifecycle: { status: 'active' },
      parent: { status: 'unknown' },
      tracking: { status: 'pending' },
    })
  }
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

it.each(repositories)('rejects issue-backed creation before local or GitHub effects: $platform', async repository => {
  await expect(todoAdd('', '#17', repository)).rejects.toThrow(/GitHub\.com repositories only/)
  await expect(todoAdd('#17 Test issue', undefined, repository)).rejects.toThrow(/GitHub\.com repositories only/)
  expect(existsSync(join(projectDirectory(repository), 'todos.yaml'))).toBe(false)
  expect(github.getIssue).not.toHaveBeenCalled()
})

it.each(repositories)('rejects issue-backed activation without changing the Todo: $platform', async repository => {
  const store = new TodoStore(projectDirectory(repository))
  const todo = store.add({ ref: '#17', title: 'Linked issue', type: 'bug' })
  const before = store.findByRef('#17')

  await expect(todoActivate(todo.id!, undefined, repository)).rejects.toThrow(/GitHub\.com repositories only/)
  expect(store.findByRef('#17')).toEqual(before)
  expect(github.getIssue).not.toHaveBeenCalled()
  expect(github.getIssueComments).not.toHaveBeenCalled()
})

it('does not restore an archived GitLab issue Todo while rejecting activation', async () => {
  const repository = repositories[0]!
  const store = new TodoStore(projectDirectory(repository))
  const todo = store.add({ ref: '#17', title: 'Archived issue', type: 'bug' })
  store.cancelTodo(todo.id!, todo.lifecycle_revision ?? 0, 'user:cancel')
  store.archiveAndDelete(0)
  const before = store.listArchived()

  await expect(todoActivate(todo.id!, undefined, repository)).rejects.toThrow(/GitHub\.com repositories only/)
  expect(store.list()).toEqual([])
  expect(store.listArchived()).toEqual(before)
  expect(github.getIssue).not.toHaveBeenCalled()
})

it('still supports a local Todo in a self-hosted GitLab project', async () => {
  const repository = repositories[0]!
  const added = await todoAdd('Local maintenance', 'local-maintenance', repository)
  expect(added).toContain('Added todo')
  const activated = await todoActivate('local-maintenance', undefined, repository)
  expect(activated).toContain('Activated')
  expect(new TodoStore(projectDirectory(repository)).findByRef('local-maintenance')?.status).toBe('active')
  expect(github.getIssue).not.toHaveBeenCalled()
})

it.each(repositories)('reads a local Todo without attempting GitHub PR calls: $platform', async repository => {
  const todo = new TodoStore(projectDirectory(repository)).add({
    ref: 'local-maintenance', title: 'Local maintenance', type: 'chore',
  })

  const detail = await todoDetail(todo.id!, repository)
  expect(detail).toContain('Local maintenance')
  expect(github.getPull).not.toHaveBeenCalled()
  expect(github.getPullReviews).not.toHaveBeenCalled()
})

it.each(repositories)('rejects unsupported PR observations before GitHub calls: $platform', async repository => {
  const store = new TodoStore(projectDirectory(repository))
  const todo = store.add({ ref: 'linked-pr', title: 'Linked PR', type: 'chore' })
  store.update(0, {
    pr: 42,
    pull_requests: [{
      repo: { platform: 'github', instance: 'https://github.com', path: 'other/explicit' },
      number: 7,
    }],
  })
  const before = store.get(0)

  await expect(todoDetail(todo.id!, repository)).rejects.toThrow(/GitHub\.com repositories only/)
  expect(store.get(0)).toEqual(before)
  expect(github.getPull).not.toHaveBeenCalled()
  expect(github.getPullReviews).not.toHaveBeenCalled()
})

it.each(repositories)('rejects implicit PR linkage without changing a Todo: $platform', async repository => {
  const store = new TodoStore(projectDirectory(repository))
  const todo = store.add({ ref: 'local-maintenance', title: 'Local maintenance', type: 'chore' })
  const before = store.get(0)

  await expect(todoUpdate(todo.id!, { pr: 42 }, repository)).rejects.toThrow(/GitHub\.com repositories only/)
  expect(store.get(0)).toEqual(before)
  expect(github.getPull).not.toHaveBeenCalled()
  expect(github.getPullReviews).not.toHaveBeenCalled()
})

it.each(repositories)('lists old numeric associations without fabricating GitHub links: $platform', async repository => {
  const store = new TodoStore(projectDirectory(repository))
  store.add({ ref: '#17', title: 'Existing local work', type: 'chore' })
  store.update(0, {
    pr: 42,
    pull_requests: [{
      repo: { platform: 'github', instance: 'https://github.com', path: 'other/explicit' },
      number: 7,
    }],
  })
  const before = store.get(0)

  const listing = await todoList(repository)
  expect(listing).toContain('Existing local work')
  expect(listing).toContain('#17')
  expect(listing).toContain('#42 (implicit PR unavailable)')
  expect(listing).toContain('https://github.com/other/explicit/pull/7')
  expect(listing).not.toContain('https://github.com/team/repo/issues/17')
  expect(listing).not.toContain('https://github.com/team/repo/pull/42')
  expect(store.get(0)).toEqual(before)
  expect(github.getPull).not.toHaveBeenCalled()
})
