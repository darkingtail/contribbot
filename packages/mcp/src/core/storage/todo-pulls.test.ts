import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { TodoStore } from './todo-store.js'
import { linkTodoPull, normalizeTodoPulls, todoPulls } from './todo-pulls.js'

describe('Todo PR relation compatibility', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'todo-pulls-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('unions the legacy scalar with stored relations without mutating its input', () => {
    const todo = { pr: 2, pull_requests: [{ repo: 'Owner/Repo', number: 1 }] }
    const before = structuredClone(todo)
    expect(todoPulls(todo, 'OWNER/REPO')).toEqual([
      { repo: 'owner/repo', number: 1 }, { repo: 'owner/repo', number: 2 },
    ])
    expect(linkTodoPull(todo, 'owner/repo', 3)).toEqual({ pr: 3, pull_requests: [
      { repo: 'owner/repo', number: 1 }, { repo: 'owner/repo', number: 2 }, { repo: 'owner/repo', number: 3 },
    ] })
    expect(todo).toEqual(before)
  })

  it('deduplicates case-insensitive identities without conflating repos', () => {
    expect(normalizeTodoPulls([
      { repo: 'Owner/Repo', number: 1 }, { repo: 'owner/repo', number: 1 },
      { repo: 'another/repo', number: 1 },
    ])).toEqual([{ repo: 'owner/repo', number: 1 }, { repo: 'another/repo', number: 1 }])
  })

  it.each([
    { repo: 'https://example.com/owner/repo', number: 1 },
    { repo: 'owner/..', number: 1 },
    { repo: 'owner/repo?token=secret', number: 1 },
    { repo: 'owner/repo', number: 0 },
    { repo: 'owner/repo', number: 1, merged: true },
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
    store.update(0, linkTodoPull(todo, 'owner/repo', 1))
    store.update(0, linkTodoPull(store.get(0)!, 'owner/repo', 2))
    store.completeTodo(0, 'done', 'Done.')
    store.archiveAndDelete(0)
    expect(store.listArchived()[0]?.pull_requests).toHaveLength(2)
    store.reopen(todo.id!)
    expect(store.get(0)).toMatchObject({ status: 'backlog', pr: 2 })
    expect(store.get(0)?.pull_requests).toHaveLength(2)
  })
})
