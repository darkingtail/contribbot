import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore } from '../../storage/todo-store.js'
import { RecordFiles } from '../../storage/record-files.js'
import { getContribDir } from '../../utils/config.js'
import { todoActivate } from './todo-activate.js'
import { todoUpdate } from './todo-update.js'
import { todoAdd, todoDelete } from './todos.js'

const github = vi.hoisted(() => ({
  getIssue: vi.fn(),
}))

vi.mock('../../clients/github.js', () => github)

vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockResolvedValue({ owner: 'owner', name: 'repo' }),
}))

describe('todoAdd', () => {
  let home: string

  function seedLegacyArchivedRecord(contribDir: string, records: RecordFiles): string {
    mkdirSync(contribDir, { recursive: true })
    writeFileSync(join(contribDir, 'todos.archive.yaml'), `todos:
  - ref: shared-ref
    title: Legacy historical owner
    type: chore
    status: done
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2025-01-01"
    updated: "2025-01-01"
    archived: "2025-01-02"
`, 'utf-8')
    return records.createTodoRecord('shared-ref', 'Legacy historical owner', 'chore', '2025-01-01')
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'todo-add-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    github.getIssue.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('does not create or overwrite a second todo when concurrent issue lookups finish later', async () => {
    const releases: Array<(issue: {
      title: string
      labels: string[]
    }) => void> = []
    github.getIssue.mockImplementation(() => new Promise(resolve => releases.push(resolve)))

    const firstAdd = todoAdd('', '#42', 'owner/repo')
    const secondAdd = todoAdd('', '#42', 'owner/repo')
    await vi.waitFor(() => expect(github.getIssue).toHaveBeenCalledTimes(2))

    releases[0]!({ title: 'First issue title', labels: ['bug'] })
    await firstAdd

    const contribDir = getContribDir('owner', 'repo')
    const recordPath = join(contribDir, 'todos', '42.md')
    appendFileSync(recordPath, '\nFirst owner note.\n', 'utf-8')

    releases[1]!({ title: 'Second issue title', labels: ['feature'] })
    const result = await secondAdd

    const todos = new TodoStore(contribDir).list()
    expect(todos).toHaveLength(1)
    expect(todos[0]).toMatchObject({ ref: '#42', title: 'First issue title' })
    expect(result).toContain('Todo already exists')
    expect(readFileSync(recordPath, 'utf-8')).toContain('First owner note.')
    expect(readFileSync(recordPath, 'utf-8')).not.toContain('Second issue title')
  })

  it('recreates a missing owner-specific record when duplicate todo_add is retried', async () => {
    const contribDir = getContribDir('owner', 'repo')
    const store = new TodoStore(contribDir)
    const records = new RecordFiles(contribDir)
    const legacyPath = seedLegacyArchivedRecord(contribDir, records)

    const createRecord = vi.spyOn(RecordFiles.prototype, 'createTodoRecord')
      .mockImplementationOnce(() => { throw new Error('injected record failure') })
    await expect(todoAdd('Current owner', 'shared-ref', 'owner/repo')).rejects.toThrow('injected record failure')
    createRecord.mockRestore()

    const current = store.findByRef('shared-ref')!
    expect(records.readRecord('shared-ref', current.id)).toBeNull()

    const result = await todoAdd('Ignored retry title', 'shared-ref', 'owner/repo')
    expect(result).toContain('Todo already exists')
    expect(records.readRecord('shared-ref', current.id)).toContain('# Current owner')
    expect(readFileSync(legacyPath, 'utf-8')).toContain('# Legacy historical owner')

    await todoDelete(current.id!, 'owner/repo')
    expect(existsSync(legacyPath)).toBe(true)
    expect(readFileSync(legacyPath, 'utf-8')).toContain('# Legacy historical owner')
  })

  it('recreates a missing owner-specific record before appending a note', async () => {
    const contribDir = getContribDir('owner', 'repo')
    const store = new TodoStore(contribDir)
    const records = new RecordFiles(contribDir)
    const legacyPath = seedLegacyArchivedRecord(contribDir, records)

    const createRecord = vi.spyOn(RecordFiles.prototype, 'createTodoRecord')
      .mockImplementationOnce(() => { throw new Error('injected record failure') })
    await expect(todoAdd('Current owner', 'shared-ref', 'owner/repo')).rejects.toThrow('injected record failure')
    createRecord.mockRestore()

    const current = store.findByRef('shared-ref')!
    await todoUpdate(current.id!, { note: 'Recovered note.' }, 'owner/repo')

    expect(records.readRecord('shared-ref', current.id)).toContain('Recovered note.')
    expect(readFileSync(legacyPath, 'utf-8')).not.toContain('Recovered note.')
  })

  it('recreates a missing owner-specific record during activation', async () => {
    const contribDir = getContribDir('owner', 'repo')
    const store = new TodoStore(contribDir)
    const records = new RecordFiles(contribDir)
    const legacyPath = seedLegacyArchivedRecord(contribDir, records)

    const createRecord = vi.spyOn(RecordFiles.prototype, 'createTodoRecord')
      .mockImplementationOnce(() => { throw new Error('injected record failure') })
    await expect(todoAdd('Current owner', 'shared-ref', 'owner/repo')).rejects.toThrow('injected record failure')
    createRecord.mockRestore()

    const current = store.findByRef('shared-ref')!
    await todoActivate(current.id!, undefined, 'owner/repo')

    expect(records.readRecord('shared-ref', current.id)).toContain('# Current owner')
    expect(readFileSync(legacyPath, 'utf-8')).toContain('# Legacy historical owner')
  })

  it('reports an existing legacy todo even when its canonical record has an orphan owner marker', async () => {
    const contribDir = getContribDir('owner', 'repo')
    mkdirSync(contribDir, { recursive: true })
    writeFileSync(join(contribDir, 'todos.yaml'), `todos:
  - ref: orphan-record
    title: Legacy active owner
    type: chore
    status: idea
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2025-01-01"
    updated: "2025-01-01"
`, 'utf-8')
    const records = new RecordFiles(contribDir)
    records.createTodoRecord('orphan-record', 'Stale owner', 'chore', '2025-01-01', 't-stale-owner')

    const result = await todoAdd('Ignored title', 'orphan-record', 'owner/repo')
    const current = new TodoStore(contribDir).findByRef('orphan-record')!

    expect(result).toContain('Todo already exists')
    expect(current.id).toMatch(/^t-/)
    expect(records.readRecord('orphan-record', current.id)).toContain('# Legacy active owner')
  })

  it('keeps unambiguous legacy prose readable after activation assigns an id', async () => {
    const contribDir = getContribDir('owner', 'repo')
    mkdirSync(contribDir, { recursive: true })
    writeFileSync(join(contribDir, 'todos.yaml'), `todos:
  - ref: legacy-activation
    title: Legacy activation
    type: chore
    status: idea
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2025-01-01"
    updated: "2025-01-01"
`, 'utf-8')
    const records = new RecordFiles(contribDir)
    const legacyPath = records.createTodoRecord('legacy-activation', 'Legacy activation', 'chore', '2025-01-01')
    appendFileSync(legacyPath, '\nLegacy prose survives activation.\n', 'utf-8')

    await todoActivate('legacy-activation', undefined, 'owner/repo')

    const current = new TodoStore(contribDir).findByRef('legacy-activation')!
    expect(current.id).toMatch(/^t-/)
    expect(records.readRecord('legacy-activation', current.id)).toContain('Legacy prose survives activation.')
  })
})
