import { testProjectDirectory, testRepository } from '../../utils/test-repository.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore, currentTodoExecution } from '../../storage/todo-store.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { getProjectDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { todoUpdate } from '../core/todo-update.js'
import { prCreate } from './pr-create.js'
import { runLocalCommand } from '../../execution/local.js'
import { fixtureRepository } from '../../execution/__fixtures__/repository.js'
import { RemoteEffects } from '../../storage/remote-effects.js'

const github = vi.hoisted(() => ({
  createPull: vi.fn(),
  parseRepo: vi.fn(),
  getRepoPulls: vi.fn(),
}))

vi.mock('../../clients/github.js', () => github)
vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn(async () => ({
    repository: { platform: 'github', instance: 'https://github.com', path: 'owner/repo' },
    owner: 'owner', name: 'repo', directory: testProjectDirectory(),
  })),
}))

describe('prCreate', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pr-create-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    new RepoConfig(testProjectDirectory()).save({
      schema_version: 3,
      repository: { platform: 'github', instance: 'https://github.com', path: 'owner/repo' },
      lifecycle: { status: 'active' },
      parent: { status: 'unknown' },
      tracking: { status: 'pending' },
    })
    github.createPull.mockReset()
    github.parseRepo.mockReset()
    github.getRepoPulls.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('links the PR by stable todo and execution identity after GitHub responds', async () => {
    const store = new TodoStore(testProjectDirectory())
    store.add({ ref: '#1', title: 'Earlier', type: 'chore' })
    const target = store.add({ ref: '#2', title: 'Target', type: 'feature' })
    store.activateExecution(1)
    const executionId = currentTodoExecution(store.resolveItemById(target.id!)!.item)!.id
    store.add({ ref: '#3', title: 'Following', type: 'bug' })

    let releasePull!: (value: { number: number }) => void
    github.createPull.mockReturnValue(new Promise(resolve => { releasePull = resolve }))
    const creating = prCreate('Target PR', 'feature/target', 'main', undefined, false, target.id, testRepository)
    await vi.waitFor(() => expect(github.createPull).toHaveBeenCalled())
    store.delete(0)
    releasePull({ number: 77 })

    await creating

    const linked = store.resolveItemById(target.id!)!.item
    expect(currentTodoExecution(linked)?.id).toBe(executionId)
    expect(linked).toMatchObject({ pr: 77, status: 'idea',
      pull_requests: [{ repo: testRepository, number: 77 }] })
    expect(store.findByRef('#3')).toMatchObject({ pr: null, status: 'idea' })
  })

  it.each([
    { platform: 'gitlab', instance: 'https://code.example.com/gitlab', path: 'owner/repo' },
    { platform: 'github', instance: 'https://github.example.com', path: 'owner/repo' },
  ] as const)('rejects unsupported $platform instance before Todo or remote effects', async (repository) => {
    const directory = getProjectDir(repository)
    vi.mocked(resolveRepo).mockResolvedValueOnce({ repository, directory, owner: 'owner', name: 'repo' })

    await expect(prCreate('Wrong destination', 'feature/x', 'main', undefined, false, 't-unknown', repository))
      .rejects.toThrow(/GitHub\.com repositories only; no remote changes/)

    expect(github.createPull).not.toHaveBeenCalled()
    expect(github.getRepoPulls).not.toHaveBeenCalled()
    expect(existsSync(directory)).toBe(false)
  })

  it('reports remote PR success and a local-only recovery when linkage persistence fails', async () => {
    const contribDir = testProjectDirectory()
    const store = new TodoStore(contribDir)
    const target = store.add({ ref: '#2', title: 'Target', type: 'feature' })
    github.createPull.mockResolvedValue({ number: 88 })
    mkdirSync(join(contribDir, 'todos.yaml.tmp'))

    await expect(prCreate('Target PR', 'feature/target', 'main', undefined, false, target.id, testRepository))
      .rejects.toThrow(/PR owner\/repo#88 was created.*todo_update/s)

    rmSync(join(contribDir, 'todos.yaml.tmp'), { recursive: true, force: true })
    await prCreate('Target PR', 'feature/target', 'main', undefined, false, target.id, testRepository)
    expect(store.resolveItemById(target.id!)!.item).toMatchObject({ pr: 88, status: 'idea',
      pull_requests: [{ repo: testRepository, number: 88 }] })
    expect(new RemoteEffects(contribDir, target.id!).list()[0]?.state).toBe('linked')
    expect(github.createPull).toHaveBeenCalledTimes(1)
  })

  it('blocks new PR creation after stop intent and preserves an already-admitted late PR result', async () => {
    const store = new TodoStore(testProjectDirectory())
    const todo = store.add({ ref: 'task', title: 'Task', type: 'feature' })
    const execution = store.activateExecution(0).execution
    let release!: (value: { number: number }) => void
    github.createPull.mockReturnValue(new Promise(resolve => { release = resolve }))
    const creating = prCreate('Task', 'feature/task', 'main', undefined, false, todo.id, testRepository)
    await vi.waitFor(() => expect(github.createPull).toHaveBeenCalledTimes(1))
    store.applyWorkflow(todo.id!, execution.id, { request_id: 'pause', expected_revision: 0,
      command: { action: 'request_control', control_id: 'pause', kind: 'pause', decision: 'user:pause', note: 'Stop further work.' } })
    release({ number: 91 })
    await creating
    expect(store.get(0)).toMatchObject({ status: 'active', pr: 91 })
    expect(currentTodoExecution(store.get(0)!)?.workflow?.control?.active_id).toBe('pause')
    await expect(prCreate('Another', 'feature/task', 'main', undefined, false, todo.id, testRepository))
      .rejects.toThrow(/control|pause/i)
    await todoUpdate(todo.id!, { pr: 91 }, testRepository)
    expect(store.get(0)?.status).toBe('active')
    expect(github.createPull).toHaveBeenCalledTimes(1)
  })

  it('does not settle pause while an admitted PR request is still in flight', async () => {
    const store = new TodoStore(testProjectDirectory())
    const todo = store.add({ ref: 'in-flight', title: 'Task', type: 'feature' })
    const execution = store.activateExecution(0).execution
    let release!: (value: { number: number }) => void
    github.createPull.mockReturnValue(new Promise(resolve => { release = resolve }))
    const creating = prCreate('Task', 'feature/task', 'main', undefined, false, todo.id, testRepository)
    await vi.waitFor(() => expect(github.createPull).toHaveBeenCalledTimes(1))
    store.applyWorkflow(todo.id!, execution.id, { request_id: 'pause', expected_revision: 0,
      command: { action: 'request_control', control_id: 'pause', kind: 'pause', decision: 'user:pause', note: 'Stop.' } })
    try {
      await expect(runLocalCommand({
        action: 'settle-pause', repo: fixtureRepository('owner/repo'), data_root: join(home, '.contribbot'),
        todo_id: todo.id, execution_id: execution.id, control_id: 'pause', actor: 'primary',
        request_id: 'settle', expected_revision: currentTodoExecution(store.get(0)!)!.workflow!.revision,
      })).rejects.toThrow(/remote|effect|in.flight|unresolved/i)
    }
    finally {
      release({ number: 92 })
      await creating
    }
    expect(store.get(0)?.status).toBe('active')
  })

  it('recovers a timed-out original PR by marker and never redispatches when the result is absent', async () => {
    const dir = testProjectDirectory()
    const store = new TodoStore(dir)
    const todo = store.add({ ref: 'timeout', title: 'Task', type: 'feature' })
    github.createPull.mockRejectedValue(new Error('Connection lost after submission.'))
    const create = () => prCreate('Task', 'feature/task', 'main', 'Content', false, todo.id, testRepository)
    await expect(create()).rejects.toThrow('Connection lost')
    const journal = new RemoteEffects(dir, todo.id!)
    const saved = journal.list()[0]!
    expect(saved.state).toBe('pending')
    expect(() => store.cancelTodo(todo.id!, 0, 'fixture:user-stop')).toThrow(/remote effects/i)
    expect(() => store.activateExecution(0)).toThrow(/remote effects/i)
    expect(() => store.delete(0, { force: true })).toThrow(/remote effects/i)
    github.getRepoPulls.mockResolvedValue([])
    await expect(create()).rejects.toThrow(/remains unresolved/i)
    await expect(prCreate('Changed body', 'feature/task', 'main', 'Different', false, todo.id, testRepository))
      .rejects.toThrow(/unresolved remote effects/i)
    expect(github.createPull).toHaveBeenCalledTimes(1)
    github.getRepoPulls.mockResolvedValue([{ number: 101, body: `Content\n\n<!-- contribbot:pr-op ${saved.id} -->` }])
    expect(await create()).toContain('Recovered PR')
    expect(store.get(0)?.pr).toBe(101)
    expect(journal.list()[0]?.state).toBe('linked')
    expect(github.createPull).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch if the durable remote journal cannot be written', async () => {
    const dir = testProjectDirectory()
    const store = new TodoStore(dir)
    const todo = store.add({ ref: 'failed-journal', title: 'Task', type: 'feature' })
    mkdirSync(join(dir, '.operations'))
    // Invalid journal publication destination forces admission to fail before POST.
    const { createHash } = await import('node:crypto')
    const file = `remote-${createHash('sha256').update(todo.id!).digest('hex')}.json.tmp`
    mkdirSync(join(dir, '.operations', file))
    await expect(prCreate('Task', 'feature/task', 'main', undefined, false, todo.id, testRepository)).rejects.toThrow()
    expect(github.createPull).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer association when an old request is replayed or returns after recovery', async () => {
    const dir = testProjectDirectory()
    const store = new TodoStore(dir)
    const todo = store.add({ ref: 'ordered-results', title: 'Task', type: 'feature' })
    const create = (title: string) => prCreate(title, 'feature/task', 'main', undefined, false, todo.id, testRepository)
    let release!: (value: { number: number }) => void
    github.createPull.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const first = create('First')
    await vi.waitFor(() => expect(github.createPull).toHaveBeenCalledTimes(1))
    const original = new RemoteEffects(dir, todo.id!).list()[0]!
    github.getRepoPulls.mockResolvedValue([{ number: 201, body: `<!-- contribbot:pr-op ${original.id} -->` }])
    try {
      await create('First')
      github.createPull.mockResolvedValue({ number: 202 })
      await create('Second')
      expect(store.get(0)?.pr).toBe(202)
    }
    finally {
      release({ number: 201 })
      await first
    }
    expect(store.get(0)?.pr).toBe(202)
    await create('First')
    expect(store.get(0)?.pr).toBe(202)
    expect(store.get(0)).toMatchObject({ status: 'idea', pull_requests: [
      { repo: testRepository, number: 201 }, { repo: testRepository, number: 202 },
    ] })
    expect(github.createPull).toHaveBeenCalledTimes(2)
  })
})
