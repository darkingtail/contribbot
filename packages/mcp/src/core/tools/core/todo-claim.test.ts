import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TodoStore } from '../../storage/todo-store.js'
import { getContribDir } from '../../utils/config.js'
import { todoClaim, withClaimLock } from './todo-claim.js'
import { runLocalCommand } from '../../execution/local.js'
import { prepareClosure } from '../../execution/closure.js'
import { RemoteEffects } from '../../storage/remote-effects.js'

const github = vi.hoisted(() => ({
  createComment: vi.fn(),
  getCurrentUser: vi.fn(),
  getIssue: vi.fn(),
  getIssueComments: vi.fn(),
}))

function runClaimLockWorker(args: string[]): Promise<void> {
  const worker = fileURLToPath(new URL('./__fixtures__/claim-lock-worker.ts', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Claim lock worker exited with ${code}: ${stderr}`))
    })
  })
}

function runClaimIdentityWorker(args: string[]): Promise<void> {
  const worker = fileURLToPath(new URL('./__fixtures__/claim-identity-worker.ts', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Claim identity worker exited with ${code}: ${stderr}`))
    })
  })
}

vi.mock('../../clients/github.js', () => github)
vi.mock('../../utils/resolve-repo.js', () => ({
  resolveRepo: vi.fn().mockResolvedValue({ owner: 'owner', name: 'repo' }),
}))

describe('todoClaim', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'todo-claim-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    github.createComment.mockReset().mockResolvedValue({ id: 500, body: '' })
    github.getCurrentUser.mockReset().mockResolvedValue({ login: 'maintainer' })
    github.getIssue.mockReset()
    github.getIssueComments.mockReset().mockResolvedValue([])
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('updates the claimed todo by stable identity after GitHub awaits', async () => {
    const store = new TodoStore(getContribDir('owner', 'repo'))
    store.add({ ref: '#1', title: 'Earlier', type: 'chore' })
    const target = store.add({ ref: '#2', title: 'Target', type: 'feature' })
    store.add({ ref: '#3', title: 'Following', type: 'bug' })

    let releaseIssue!: (value: { state: string }) => void
    github.getIssue.mockReturnValue(new Promise(resolve => { releaseIssue = resolve }))
    const claiming = todoClaim(target.id!, ['Implement target'], 'owner/repo')
    await vi.waitFor(() => expect(github.getIssue).toHaveBeenCalled())
    store.delete(0)
    releaseIssue({ state: 'open' })

    await claiming

    expect(store.resolveItemById(target.id!)!.item).toMatchObject({
      status: 'active',
      claimed_items: ['Implement target'],
    })
    expect(store.findByRef('#3')).toMatchObject({ status: 'idea', claimed_items: null })
  })

  it('suppresses a duplicate remote comment when retrying a failed local claim update', async () => {
    const contribDir = getContribDir('owner', 'repo')
    const store = new TodoStore(contribDir)
    const target = store.add({ ref: '#2', title: 'Target', type: 'feature' })
    github.getIssue.mockResolvedValue({ state: 'open' })
    let postedBody = ''
    github.createComment.mockImplementation(async (_owner, _repo, _issue, body) => {
      postedBody = body
      mkdirSync(join(contribDir, 'todos.yaml.tmp'))
      return { id: 501, body }
    })

    await expect(todoClaim(target.id!, ['Implement target'], 'owner/repo'))
      .rejects.toThrow(/comment.*posted.*Retry the same todo_claim/is)
    expect(github.createComment).toHaveBeenCalledTimes(1)

    rmSync(join(contribDir, 'todos.yaml.tmp'), { recursive: true, force: true })
    github.getIssueComments.mockResolvedValue([{ id: 501, body: postedBody, user: { login: 'maintainer' } }])
    github.createComment.mockClear()
    github.getIssue.mockRejectedValue(new Error('Offline after original success.'))
    github.getCurrentUser.mockRejectedValue(new Error('Offline after original success.'))
    github.getIssueComments.mockRejectedValue(new Error('Offline after original success.'))

    await todoClaim(target.id!, ['Implement target'], 'owner/repo')

    expect(github.createComment).not.toHaveBeenCalled()
    expect(store.resolveItemById(target.id!)!.item).toMatchObject({
      status: 'active',
      claimed_items: ['Implement target'],
    })
    expect(new RemoteEffects(contribDir, target.id!).list()[0]?.state).toBe('linked')
  })

  it('keeps an admitted claim unresolved until its late response and local linkage are saved', async () => {
    const directory = getContribDir('owner', 'repo')
    const store = new TodoStore(directory)
    const todo = store.add({ ref: '#2', title: 'Claim', type: 'feature' })
    const execution = store.activateExecution(0).execution
    github.getIssue.mockResolvedValue({ state: 'open' })
    let release!: (value: { id: number; body: string }) => void
    github.createComment.mockReturnValue(new Promise(resolve => { release = resolve }))
    const claiming = todoClaim(todo.id!, ['Implement'], 'owner/repo')
    await vi.waitFor(() => expect(github.createComment).toHaveBeenCalledTimes(1))
    store.applyWorkflow(todo.id!, execution.id, { request_id: 'pause', expected_revision: 0,
      command: { action: 'request_control', control_id: 'pause', kind: 'pause', decision: 'user:pause', note: 'Stop.' } })
    const input = { repo: 'owner/repo', data_root: join(home, '.contribbot'), todo_id: todo.id,
      execution_id: execution.id, control_id: 'pause', actor: 'primary', expected_revision: 1 }
    try {
      await expect(runLocalCommand({ ...input, action: 'settle-pause', request_id: 'settle' })).rejects.toThrow(/remote effects/i)
      await expect(runLocalCommand({ ...input, action: 'continue', request_id: 'continue', decision: 'user:continue' })).rejects.toThrow(/remote effects/i)
    }
    finally {
      release({ id: 601, body: github.createComment.mock.calls[0]![3] })
      await claiming
    }
    expect(store.get(0)).toMatchObject({ status: 'active', claimed_items: ['Implement'] })
    await runLocalCommand({ ...input, action: 'settle-pause', request_id: 'settle' })
    expect(store.get(0)?.status).toBe('paused')
    expect(github.createComment).toHaveBeenCalledTimes(1)
  })

  it('blocks new claim dispatch while a local closure is prepared', async () => {
    const directory = getContribDir('owner', 'repo')
    const store = new TodoStore(directory)
    const todo = store.add({ ref: '#2', title: 'Claim', type: 'feature' })
    const execution = store.activateExecution(0).execution
    store.applyWorkflow(todo.id!, execution.id, { request_id: 'plan', expected_revision: 0,
      command: { action: 'propose_plan', plan_id: 'p', plan: {
        goal: 'Decide', completion_scope: 'task', remaining_scope: [], non_goals: [], scope: ['.'], risk: 'normal',
        steps: [{ id: 'decide', title: 'Decide', scope: ['.'], depends_on: [], acceptance_ids: ['manual'] }],
        acceptance: [{ id: 'manual', description: 'User accepts', kind: 'manual', required: true, independent: false }],
      } } })
    store.applyWorkflow(todo.id!, execution.id, { request_id: 'cancel', expected_revision: 1,
      command: { action: 'request_control', control_id: 'cancel', kind: 'cancel', decision: 'user:stop', note: 'Stop locally' } })
    prepareClosure({ directory, todo_id: todo.id, execution_id: execution.id, expected_revision: 2,
      closure_id: 'close', mode: 'stopped', decision: 'user:stop', note: 'Stop locally', acknowledged_gaps: [], target: { kind: 'local' } })
    expect(store.get(0)?.executions.at(-1)?.workflow?.closing_id).toBe('close')
    github.getIssue.mockResolvedValue({ state: 'open' })
    await expect(todoClaim(todo.id!, ['Implement'], 'owner/repo')).rejects.toThrow(/closing|closed|cancel requested/i)
    expect(github.createComment).not.toHaveBeenCalled()
  })

  it('recovers the original marker after timeout even if the Issue closed, without reposting', async () => {
    const directory = getContribDir('owner', 'repo')
    const store = new TodoStore(directory)
    const todo = store.add({ ref: '#2', title: 'Claim', type: 'feature' })
    github.getIssue.mockResolvedValue({ state: 'open' })
    github.createComment.mockRejectedValue(new Error('Response lost'))
    await expect(todoClaim(todo.id!, ['Implement'], 'owner/repo')).rejects.toThrow('Response lost')
    const body = github.createComment.mock.calls[0]![3]
    github.getIssue.mockResolvedValue({ state: 'closed' })
    await expect(todoClaim(todo.id!, ['Implement'], 'owner/repo')).rejects.toThrow(/remains unresolved/i)
    github.getIssueComments.mockResolvedValue([{ id: 602, body }])
    await todoClaim(todo.id!, ['Implement'], 'owner/repo')
    expect(new RemoteEffects(directory, todo.id!).list()[0]?.state).toBe('linked')
    expect(github.createComment).toHaveBeenCalledTimes(1)
  })

  it('serializes overlapping identical claims so only one comment is posted', async () => {
    const store = new TodoStore(getContribDir('owner', 'repo'))
    const target = store.add({ ref: '#2', title: 'Target', type: 'feature' })
    github.getIssue.mockResolvedValue({ state: 'open' })
    const comments: Array<{ id: number; body: string; user: { login: string } }> = []
    github.getIssueComments.mockImplementation(async () => [...comments])
    let releaseComment!: () => void
    github.createComment.mockImplementation(async (_owner, _repo, _issue, body) => {
      await new Promise<void>(resolve => { releaseComment = resolve })
      const comment = { id: 700, body, user: { login: 'maintainer' } }
      comments.push(comment)
      return comment
    })

    const first = todoClaim(target.id!, ['Same item'], 'owner/repo')
    const second = todoClaim(target.id!, ['Same item'], 'owner/repo')
    await vi.waitFor(() => expect(github.createComment).toHaveBeenCalledTimes(1))
    releaseComment()
    await Promise.all([first, second])

    expect(github.createComment).toHaveBeenCalledTimes(1)
  })

  it('serializes different claims for the same todo so local claimed items cannot be lost', async () => {
    const store = new TodoStore(getContribDir('owner', 'repo'))
    const target = store.add({ ref: '#2', title: 'Target', type: 'feature' })
    github.getIssue.mockResolvedValue({ state: 'open' })
    const comments: Array<{ id: number; body: string; user: { login: string } }> = []
    github.getIssueComments.mockImplementation(async () => [...comments])
    let releaseFirst!: () => void
    let call = 0
    github.createComment.mockImplementation(async (_owner, _repo, _issue, body) => {
      call++
      if (call === 1) await new Promise<void>(resolve => { releaseFirst = resolve })
      const comment = { id: 710 + call, body, user: { login: 'maintainer' } }
      comments.push(comment)
      return comment
    })

    const first = todoClaim(target.id!, ['First item'], 'owner/repo')
    await vi.waitFor(() => expect(github.createComment).toHaveBeenCalledTimes(1))
    const second = todoClaim(target.id!, ['Second item'], 'owner/repo')
    await new Promise(resolve => setTimeout(resolve, 75))
    expect(github.createComment).toHaveBeenCalledTimes(1)

    releaseFirst()
    await Promise.all([first, second])

    expect(github.createComment).toHaveBeenCalledTimes(2)
    expect(store.resolveItemById(target.id!)!.item.claimed_items).toEqual(['First item', 'Second item'])
  })

  it('ignores an abandoned legacy lock without deleting its replaceable path', async () => {
    const contribDir = getContribDir('owner', 'repo')
    const store = new TodoStore(contribDir)
    const target = store.add({ ref: '#2', title: 'Target', type: 'feature' })
    github.getIssue.mockResolvedValue({ state: 'open' })
    const lockDigest = createHash('sha256')
      .update(`owner/repo#2\0${target.id}`)
      .digest('hex')
      .slice(0, 16)
    const lockPath = join(contribDir, '.locks', `claim-${lockDigest}.lock`)
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ token: 'abandoned', pid: 2_147_483_647 }), 'utf-8')

    await todoClaim(target.id!, ['Recovered item'], 'owner/repo')

    expect(existsSync(lockPath)).toBe(true)
    expect(github.createComment).toHaveBeenCalledTimes(1)
    expect(store.resolveItemById(target.id!)!.item.claimed_items).toEqual(['Recovered item'])
  })

  it('serializes two processes without reclaiming a shared legacy path', async () => {
    const contribDir = getContribDir('owner', 'repo')
    const digest = 'multiprocess-regression'
    const lockPath = join(contribDir, '.locks', `claim-${digest}.lock`)
    const logPath = join(contribDir, 'claim-lock.log')
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ token: 'abandoned', pid: 2_147_483_647 }), 'utf-8')

    await Promise.all([
      runClaimLockWorker([contribDir, digest, 'a', '150', logPath]),
      runClaimLockWorker([contribDir, digest, 'b', '150', logPath]),
    ])

    const events = readFileSync(logPath, 'utf-8').trim().split(/\r?\n/)
    let active = 0
    for (const event of events) {
      active += event.startsWith('start:') ? 1 : -1
      expect(active).toBeGreaterThanOrEqual(0)
      expect(active).toBeLessThanOrEqual(1)
    }
    expect(active).toBe(0)
    expect(events).toHaveLength(4)
    expect(existsSync(lockPath)).toBe(true)
  })

  it('waits for an old malformed publication owned by a live process', async () => {
    const contribDir = getContribDir('owner', 'repo')
    const digest = 'publication-pause'
    const lockRoot = join(contribDir, '.locks')
    const malformedPath = join(lockRoot, `claim-${digest}.${process.pid}.paused.choosing.json`)
    mkdirSync(lockRoot, { recursive: true })
    writeFileSync(malformedPath, '{"partial"', 'utf-8')
    const old = new Date(Date.now() - 2_000)
    utimesSync(malformedPath, old, old)
    let entered = false

    const waiting = withClaimLock(contribDir, digest, async () => {
      entered = true
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(entered).toBe(false)

    rmSync(malformedPath, { force: true })
    await waiting
    expect(entered).toBe(true)
  })

  it('ignores a stale contender after its pid is reused by a newer process instance', async () => {
    const contribDir = getContribDir('owner', 'repo')
    const digest = 'pid-reuse'
    const lockRoot = join(contribDir, '.locks')
    const token = 'stale-owner'
    const stalePath = join(lockRoot, `claim-${digest}.${process.pid}.${token}.ticket-1.json`)
    mkdirSync(lockRoot, { recursive: true })
    writeFileSync(stalePath, JSON.stringify({
      token,
      pid: process.pid,
      createdAt: Date.now() - 60_000,
      choosing: false,
      ticket: 1,
    }), 'utf-8')
    let entered = false

    const waiting = withClaimLock(contribDir, digest, async () => {
      entered = true
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    const enteredBeforeCleanup = entered
    rmSync(stalePath, { force: true })
    await waiting

    expect(enteredBeforeCleanup).toBe(true)
  })

  it('converges two processes on one stable id for a legacy todo', async () => {
    const contribDir = getContribDir('owner', 'repo')
    mkdirSync(contribDir, { recursive: true })
    writeFileSync(join(contribDir, 'todos.yaml'), `todos:
  - ref: "#7"
    title: Legacy claim target
    type: feature
    status: idea
    difficulty: null
    pr: null
    branch: null
    claimed_items: null
    created: "2026-09-17"
    updated: "2026-09-17"
`, 'utf-8')
    const readyDir = join(contribDir, 'identity-ready')
    const logPath = join(contribDir, 'identity.log')

    await Promise.all([
      runClaimIdentityWorker([contribDir, 'owner', 'repo', '#7', 'a', readyDir, logPath]),
      runClaimIdentityWorker([contribDir, 'owner', 'repo', '#7', 'b', readyDir, logPath]),
    ])

    const ids = readFileSync(logPath, 'utf-8').trim().split(/\r?\n/).map(line => line.split(':')[1])
    expect(new Set(ids)).toHaveLength(1)
    expect(new TodoStore(contribDir).resolveItem('#7')!.item.id).toBe(ids[0])
  })

  it('names the stable todo id in recovery guidance after an index shifts', async () => {
    const contribDir = getContribDir('owner', 'repo')
    const store = new TodoStore(contribDir)
    store.add({ ref: '#1', title: 'Earlier', type: 'chore' })
    const target = store.add({ ref: '#2', title: 'Target', type: 'feature' })
    store.add({ ref: '#3', title: 'Following', type: 'bug' })
    let releaseIssue!: (value: { state: string }) => void
    github.getIssue.mockReturnValue(new Promise(resolve => { releaseIssue = resolve }))
    github.createComment.mockImplementation(async (_owner, _repo, _issue, body) => {
      mkdirSync(join(contribDir, 'todos.yaml.tmp'))
      return { id: 701, body }
    })

    const claiming = todoClaim('2', ['Target item'], 'owner/repo')
    await vi.waitFor(() => expect(github.getIssue).toHaveBeenCalled())
    store.delete(0)
    releaseIssue({ state: 'open' })

    await expect(claiming).rejects.toThrow(new RegExp(`item="${target.id}"`))
  })
})
