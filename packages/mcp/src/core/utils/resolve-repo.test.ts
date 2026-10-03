import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RepoConfig } from '../storage/repo-config.js'
import { TodoStore } from '../storage/todo-store.js'
import { projectStatus } from '../tools/core/project-lifecycle.js'
import { todoAdd, todoList } from '../tools/core/todos.js'
import { projectDirectory, type RepositoryRef } from './repository-ref.js'

const repository: RepositoryRef = {
  platform: 'github',
  instance: 'https://github.com',
  path: 'owner/repo',
}

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'resolve-repo-v3-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

it('does not read orphan Todo data or initialize a project through Todo tools', async () => {
  const dir = projectDirectory(repository)
  new TodoStore(dir).add({ ref: 'orphan', title: 'Orphan Todo', type: 'chore' })
  const before = readFileSync(join(dir, 'todos.yaml'), 'utf8')

  await expect(todoList(repository)).rejects.toThrow(/not initialized/i)
  await expect(todoAdd('Another Todo', 'another', repository)).rejects.toThrow(/not initialized/i)
  expect(readFileSync(join(dir, 'todos.yaml'), 'utf8')).toBe(before)
  expect(existsSync(join(dir, 'config.yaml'))).toBe(false)
})

it('rejects a project whose config belongs to a different repository before reading Todos', async () => {
  const dir = projectDirectory(repository)
  new RepoConfig(dir).save({
    schema_version: 3,
    repository,
    lifecycle: { status: 'active' },
    parent: { status: 'unknown' },
    tracking: { status: 'pending' },
  })
  new TodoStore(dir).add({ ref: 'orphan', title: 'Orphan Todo', type: 'chore' })
  const path = join(dir, 'config.yaml')
  writeFileSync(path, readFileSync(path, 'utf8').replace('owner/repo', 'other/repo'))

  await expect(todoList(repository)).rejects.toThrow(/identity does not match/i)
  await expect(todoAdd('Another Todo', 'another', repository)).rejects.toThrow(/identity does not match/i)
})

it('accepts a valid project and leaves uninitialized status lookup read-only', async () => {
  const missing: RepositoryRef = { ...repository, path: 'owner/missing' }
  expect(JSON.parse(await projectStatus(missing))).toMatchObject({ configured: false, status: 'not_initialized' })
  expect(existsSync(projectDirectory(missing))).toBe(false)

  const dir = projectDirectory(repository)
  new RepoConfig(dir).save({
    schema_version: 3,
    repository,
    lifecycle: { status: 'active' },
    parent: { status: 'unknown' },
    tracking: { status: 'pending' },
  })
  expect(await todoAdd('Local task', 'local-task', repository)).toContain('Added todo')
  expect(await todoList(repository)).toContain('Local task')
})
