import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { TodoStore } from './todo-store.js'
import { linkTodoPull, normalizeTodoPulls, todoPulls } from './todo-pulls.js'
import { fixtureRepository } from '../execution/__fixtures__/repository.js'

const repository = fixtureRepository('owner/repo')
const otherRepository = fixtureRepository('another/repo')

describe('Todo PR relation compatibility', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'todo-pulls-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('unions the legacy scalar with stored relations without mutating its input', () => {
    const todo = { pr: 2, pull_requests: [{ repo: repository, number: 1 }] }
    const before = structuredClone(todo)
    expect(todoPulls(todo, repository)).toEqual([
      { repo: repository, number: 1 }, { repo: repository, number: 2 },
    ])
    expect(linkTodoPull(todo, repository, 3)).toEqual({ pr: 3, pull_requests: [
      { repo: repository, number: 1 }, { repo: repository, number: 2 }, { repo: repository, number: 3 },
    ] })
    expect(todo).toEqual(before)
  })

  it('deduplicates identical identities without conflating repositories', () => {
    expect(normalizeTodoPulls([
      { repo: repository, number: 1 }, { repo: repository, number: 1 },
      { repo: otherRepository, number: 1 },
    ])).toEqual([{ repo: repository, number: 1 }, { repo: otherRepository, number: 1 }])
  })

  it.each([
    { repo: { platform: 'gitlab', instance: 'https://github.com', path: 'owner/repo' }, number: 1 },
    { repo: { platform: 'github', instance: 'https://github.com', path: 'owner/..' }, number: 1 },
    { repo: { platform: 'github', instance: 'https://github.com', path: 'owner/repo?token=secret' }, number: 1 },
    { repo: repository, number: 0 },
    { repo: repository, number: 1, merged: true },
  ])('refuses malformed new persisted relation %# rather than dropping it on save', (relation) => {
    const store = new TodoStore(dir)
    const todo = store.add({ ref: 'invalid', title: 'Invalid', type: 'docs' })
    const file = join(dir, 'todos.yaml')
    writeFileSync(file, stringify({ todos: [{ ...todo, pull_requests: [relation] }] }))
    const before = readFileSync(file, 'utf8')
    expect(() => store.list()).toThrow()
    expect(() => store.update(0, { branch: 'changed' })).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('preserves relations across archive, restore and reopen, without injecting fields into legacy reads', () => {
    const store = new TodoStore(dir)
    const todo = store.add({ ref: 'history', title: 'History', type: 'docs' })
    expect(store.get(0)).not.toHaveProperty('pull_requests')
    store.update(0, linkTodoPull(todo, repository, 1))
    store.update(0, linkTodoPull(store.get(0)!, repository, 2))
    store.completeTodo(0, 'done', 'Done.')
    store.archiveAndDelete(0)
    expect(store.listArchived()[0]?.pull_requests).toHaveLength(2)
    store.reopen(todo.id!)
    expect(store.get(0)).toMatchObject({ status: 'backlog', pr: 2 })
    expect(store.get(0)?.pull_requests).toHaveLength(2)
  })
})
