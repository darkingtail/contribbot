import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TodoStore } from '../storage/todo-store.js'
import { runLocalCommand } from './local.js'
import type { WorkflowCommand } from './contracts.js'
import { captureCandidate } from './candidate.js'
import { localMachine } from './processes.js'

describe('physical workspace occupancy across task stores', () => {
  let home: string
  let workspace: string
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=nonexistent-hooks', '-c', 'commit.gpgSign=false', ...args,
  ], { cwd: workspace, windowsHide: true, stdio: 'pipe' })

  async function participant(dataRoot: string, repo: string, actor: string, root = workspace) {
    const directory = join(dataRoot, ...repo.split('/'))
    const store = new TodoStore(directory)
    const todoId = store.add({ ref: 'edit', title: 'Edit the actual file', type: 'feature' }).id!
    const executionId = store.activateExecution(0).execution.id
    writeFileSync(join(directory, 'config.yaml'), 'fork: fixture/repo\nupstream: null\n')
    const state = () => store.list()[0]!.executions[0]!.workflow!
    const local = (action: string, payload: Record<string, unknown> = {}) => runLocalCommand({
      action, repo, data_root: dataRoot, todo_id: todoId, execution_id: executionId, ...payload,
    })
    await local('apply', { request_id: 'plan', expected_revision: 0, command: {
      action: 'propose_plan', plan_id: 'plan', plan: {
        goal: 'Edit source.txt without another task overwriting unfinished work', completion_scope: 'task', remaining_scope: [],
        non_goals: ['Network', 'Git metadata changes'], scope: ['source.txt'], risk: 'normal',
        steps: [{ id: 'edit', title: 'Edit', scope: ['source.txt'], depends_on: [], acceptance_ids: ['content'] }],
        acceptance: [{ id: 'content', description: 'Inspect delivered file contents', kind: 'manual', required: true, independent: false }],
      },
    } })
    await local('apply', { request_id: 'confirm', expected_revision: state().revision, command: {
      action: 'confirm_plan', plan_id: 'plan', digest: state().plans[0]!.digest, confirmation: 'fixture:user-plan',
    } })
    await local('bind', { request_id: 'bind', expected_revision: state().revision,
      attempt_id: 'attempt', owner: actor, workspace: root })
    const beginRequest = (kind: 'read' | 'write' = 'write') => ({
      request_id: 'write', expected_revision: state().revision, command: {
        action: 'begin_operation' as const, operation_id: 'write', kind, actor, delegated: false,
        step_id: 'edit', scope: ['source.txt'], purpose: 'Keep this writer exclusive until its work is settled',
      },
    })
    const begin = (kind: 'read' | 'write' = 'write') => local('apply', beginRequest(kind))
    const apply = (command: WorkflowCommand) => store.applyWorkflow(todoId, executionId, {
      request_id: `${command.action}-${state().revision}`, expected_revision: state().revision, command,
    })
    const returned = () => apply({ action: 'return_operation', operation_id: 'write', receipt: 'host:actual-work',
      note: 'Writer stopped', process_stopped: true })
    const adopted = () => apply({ action: 'adopt_operation', operation_id: 'write', actor, decision: 'accepted', note: 'Inspected actual work' })
    return { directory, todoId, executionId, store, state, local, begin, beginRequest, apply, returned, adopted }
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-workspace-occupancy-'))
    workspace = join(home, 'workspace')
    mkdirSync(workspace)
    git('init', '--quiet', '--initial-branch=fixture')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git')
    writeFileSync(join(workspace, 'source.txt'), 'original')
    git('add', '.')
    git('commit', '--quiet', '-m', 'fixture')
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it.each(['different projects', 'independent data roots'])('prevents a second writer from %s changing an occupied file', async mode => {
    const first = await participant(join(home, 'data'), 'fixture/repo', 'primary-a')
    const second = await participant(
      join(home, mode === 'independent data roots' ? 'other-data' : 'data'),
      mode === 'different projects' ? 'fixture/alias' : 'fixture/repo', 'primary-b',
    )
    await first.begin()
    writeFileSync(join(workspace, 'source.txt'), 'primary-a unfinished work')
    const before = second.state()
    let refusal: unknown
    try {
      await second.begin()
      writeFileSync(join(workspace, 'source.txt'), 'primary-b overwrote unfinished work')
    }
    catch (error) { refusal = error }
    expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe('primary-a unfinished work')
    expect(refusal).toBeInstanceOf(Error)
    expect(second.state()).toEqual(before)
    expect(first.state().operations[0]!.status).toBe('running')
  }, 20_000)

  it('keeps unknown and returned work exclusive, then permits another store after adoption', async () => {
    const first = await participant(join(home, 'data'), 'fixture/repo', 'primary-a')
    const second = await participant(join(home, 'other-data'), 'fixture/repo', 'primary-b')
    const request = first.beginRequest()
    await first.begin()
    first.apply({ action: 'mark_unknown', operation_id: 'write', reason: 'Lost host task observation' })
    await expect(second.begin()).rejects.toThrow(/occupied/i)
    first.returned()
    await expect(second.begin()).rejects.toThrow(/occupied/i)
    first.adopted()
    await second.begin()
    writeFileSync(join(workspace, 'source.txt'), 'primary-b after actual release')
    const before = first.state()
    await first.local('apply', request)
    expect(first.state()).toEqual(before)
    expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe('primary-b after actual release')
  }, 20_000)

  it('shares reads without permitting a writer, and lets readers report uncertainty or release', async () => {
    const first = await participant(join(home, 'data'), 'fixture/repo', 'reader-a')
    const second = await participant(join(home, 'other-data'), 'fixture/repo', 'reader-b')
    const writer = await participant(join(home, 'third-data'), 'fixture/repo', 'writer')
    await first.begin('read')
    await second.begin('read')
    await expect(writer.begin()).rejects.toThrow(/occupied/i)
    first.apply({ action: 'mark_unknown', operation_id: 'write', reason: 'Reader status unknown' })
    second.returned()
    second.adopted()
    await expect(writer.begin()).rejects.toThrow(/occupied/i)
    first.returned()
    first.adopted()
    await writer.begin()
    writeFileSync(join(workspace, 'source.txt'), 'only after both readers settled')
    expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe('only after both readers settled')
  }, 20_000)

  it('allows writes to distinct linked worktrees without changing the occupied sibling', async () => {
    const sibling = join(home, 'sibling')
    git('worktree', 'add', '--quiet', '-b', 'sibling', sibling)
    const first = await participant(join(home, 'data'), 'fixture/repo', 'primary-a')
    const second = await participant(join(home, 'other-data'), 'fixture/repo', 'primary-b', sibling)
    await first.begin()
    await second.begin()
    writeFileSync(join(workspace, 'source.txt'), 'a')
    writeFileSync(join(sibling, 'source.txt'), 'b')
    expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe('a')
    expect(readFileSync(join(sibling, 'source.txt'), 'utf8')).toBe('b')
  }, 20_000)

  it('reserves both the main workspace and child workspace during delegation', async () => {
    const sibling = join(home, 'sibling')
    git('worktree', 'add', '--quiet', '-b', 'sibling', sibling)
    const first = await participant(join(home, 'data'), 'fixture/repo', 'primary-a')
    const main = await participant(join(home, 'other-data'), 'fixture/repo', 'primary-b')
    const child = await participant(join(home, 'third-data'), 'fixture/repo', 'primary-c', sibling)
    const candidate = captureCandidate(sibling)
    first.apply({
      action: 'begin_delegation', operation_id: 'child', actor: 'primary-a', token: 'token',
      step_id: 'edit', scope: ['source.txt'], purpose: 'Isolated implementation', launch: 'a'.repeat(64),
      workspace: { repo: 'fixture/repo', root: candidate.root, git_dir: candidate.git_dir,
        common_dir: candidate.common_dir, baseline: candidate.digest, machine: localMachine() },
    })
    await expect(main.begin()).rejects.toThrow(/occupied/i)
    await expect(child.begin()).rejects.toThrow(/occupied/i)
    expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe('original')
    expect(readFileSync(join(sibling, 'source.txt'), 'utf8')).toBe('original')
  }, 20_000)

  it('retains a closing reservation across stores until explicitly cancelled', async () => {
    const first = await participant(join(home, 'data'), 'fixture/repo', 'primary-a')
    const second = await participant(join(home, 'other-data'), 'fixture/repo', 'primary-b')
    await first.local('yield', { request_id: 'yield', expected_revision: first.state().revision,
      actor: 'primary-a', observed_operations: [], note: 'No active operations' })
    first.apply({ action: 'request_control', control_id: 'cancel', kind: 'cancel',
      decision: 'fixture:user', note: 'Explicitly stop this task.' })
    first.apply({ action: 'reserve_closure', intent: {
      id: 'closure', mode: 'stopped', target: { kind: 'local' }, decision: 'fixture:user',
      note: 'Stop this fixture', acknowledged_gaps: [],
    } })
    await expect(second.begin()).rejects.toThrow(/occupied/i)
    first.apply({ action: 'cancel_closure', closure_id: 'closure', note: 'User cancelled local closure' })
    await second.begin()
  }, 20_000)

  it.each(['missing', 'replaced', 'corrupt', 'empty-document'])('refuses to infer vacancy from a %s registered store', async mode => {
    const first = await participant(join(home, 'data'), 'fixture/repo', 'primary-a')
    const second = await participant(join(home, 'other-data'), 'fixture/repo', 'primary-b')
    await first.begin()
    writeFileSync(join(workspace, 'source.txt'), 'unfinished')
    if (mode === 'missing' || mode === 'replaced') {
      renameSync(first.directory, `${first.directory}-original`)
      if (mode === 'replaced') {
        mkdirSync(first.directory)
        new TodoStore(first.directory).add({ ref: 'new', title: 'New store', type: 'feature' })
      }
    }
    else writeFileSync(join(first.directory, 'todos.yaml'), mode === 'corrupt' ? 'todos: [unclosed' : '')
    await expect(second.begin()).rejects.toThrow(/unknown|unavailable|replaced/i)
    expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe('unfinished')
    expect(second.state().operations).toEqual([])
  }, 20_000)

  it('does not let an unavailable peer prevent the healthy owner from releasing its own read', async () => {
    const first = await participant(join(home, 'data'), 'fixture/repo', 'reader-a')
    const second = await participant(join(home, 'other-data'), 'fixture/repo', 'reader-b')
    await first.begin('read')
    await second.begin('read')
    renameSync(second.directory, `${second.directory}-original`)
    first.returned()
    first.adopted()
    expect(first.state().operations[0]!.status).toBe('accepted')
  }, 20_000)

  it('refuses damaged or linked shared metadata rather than creating an empty registry', async () => {
    const first = await participant(join(home, 'data'), 'fixture/repo', 'primary-a')
    await first.begin()
    first.returned()
    first.adopted()
    const common = first.state().attempts[0]!.workspace.common_dir
    const shared = join(common, 'contribbot-workspaces')
    renameSync(shared, `${shared}-original`)
    const next = () => first.apply({ ...first.beginRequest().command, operation_id: 'next' })
    expect(next).toThrow(/registry.*missing/i)
    mkdirSync(shared)
    expect(next).toThrow()
    rmdirSync(shared)
    symlinkSync(`${shared}-original`, shared, process.platform === 'win32' ? 'junction' : 'dir')
    expect(next).toThrow(/metadata.*links/i)
  }, 20_000)

  it.each(['missing', 'replaced'])('does not let a newcomer overwrite live work after the shared registry is %s', async mode => {
    const first = await participant(join(home, 'data'), 'fixture/repo', 'primary-a')
    const newcomer = await participant(join(home, 'new-data'), 'fixture/repo', 'primary-b')
    await first.begin()
    writeFileSync(join(workspace, 'source.txt'), 'a still owns unfinished work')
    const shared = join(first.state().attempts[0]!.workspace.common_dir, 'contribbot-workspaces')
    renameSync(shared, `${shared}-lost`)
    if (mode === 'replaced') {
      mkdirSync(shared)
      mkdirSync(join(shared, '.locks'))
      writeFileSync(join(shared, 'participants.json'), JSON.stringify({
        version: 1, id: '11111111-1111-4111-8111-111111111111', participants: [],
      }))
    }
    let refused: unknown
    try {
      await newcomer.begin()
      writeFileSync(join(workspace, 'source.txt'), 'newcomer overwrote live work')
    }
    catch (error) { refused = error }
    expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe('a still owns unfinished work')
    expect(refused).toBeInstanceOf(Error)
    expect(newcomer.state().operations).toEqual([])
  }, 20_000)

  it('checks current Git identity before permitting a write via the generic host route', async () => {
    const first = await participant(join(home, 'data'), 'fixture/repo', 'primary-a')
    renameSync(join(workspace, '.git'), join(workspace, '.git-original'))
    writeFileSync(join(workspace, '.git'), 'gitdir: .git-original\n')
    await expect(first.begin()).rejects.toThrow(/physical identity/i)
    expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe('original')
  }, 20_000)

  it('rejects a new registry at store capacity without poisoning state or future retries', async () => {
    const first = await participant(join(home, 'data'), 'fixture/repo', 'primary')
    const identityPath = join(first.directory, '.execution-store.json')
    const identity = {
      version: 1, id: randomUUID(),
      registries: Array.from({ length: 256 }, (_, index) => ({
        directory: join(home, `old-registry-${index}`), id: randomUUID(),
      })),
    }
    writeFileSync(identityPath, JSON.stringify(identity))
    const before = first.state()
    await expect(first.begin()).rejects.toThrow()
    expect(first.state()).toEqual(before)
    expect(JSON.parse(readFileSync(identityPath, 'utf8'))).toEqual(identity)
    expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe('original')

    // Model an explicitly resolved idle reference; a rejected request must remain retryable.
    identity.registries.pop()
    writeFileSync(identityPath, JSON.stringify(identity))
    await first.begin()
    first.returned()
    first.adopted()
    expect(first.state().operations[0]!.status).toBe('accepted')
  }, 20_000)

  it('rejects a newcomer at participant capacity while the original owner can still release', async () => {
    try {
      const first = await participant(join(home, 'data'), 'fixture/repo', 'reader')
      const newcomer = await participant(join(home, 'new-data'), 'fixture/repo', 'new-reader')
      await first.begin('read')
      const shared = join(first.state().attempts[0]!.workspace.common_dir, 'contribbot-workspaces')
      const registryPath = join(shared, 'participants.json')
      const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
        version: number; id: string; participants: Array<{ directory: string; id: string }>
      }
      const snapshot = readFileSync(join(first.directory, 'todos.yaml'))
      for (let index = 1; index < 4096; index++) {
        const path = join(home, `registered-${index}`)
        const directory = process.platform === 'win32' ? path.toLowerCase() : path
        const id = randomUUID()
        mkdirSync(directory)
        writeFileSync(join(directory, '.execution-store.json'), JSON.stringify({
          version: 1, id, registries: [{ directory: shared, id: registry.id }],
        }))
        writeFileSync(join(directory, 'todos.yaml'), snapshot)
        registry.participants.push({ directory, id })
      }
      writeFileSync(registryPath, JSON.stringify(registry))
      const before = newcomer.state()
      await expect(newcomer.begin('read')).rejects.toThrow()
      expect(newcomer.state()).toEqual(before)
      expect(JSON.parse(readFileSync(registryPath, 'utf8'))).toEqual(registry)
      expect(existsSync(join(newcomer.directory, '.execution-store.json'))).toBe(false)
      first.returned()
      first.adopted()
      expect(first.state().operations[0]!.status).toBe('accepted')
      await newcomer.begin('read')
      newcomer.returned()
      newcomer.adopted()
      expect(newcomer.state().operations[0]!.status).toBe('accepted')
      expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe('original')
    }
    finally {
      // Include the large fixture's cleanup in this test's budget, not the shared hook's.
      rmSync(home, { recursive: true, force: true })
    }
  }, 120_000)

  it('rejects a prospective metadata file beyond the readable byte limit before saving a grant', async () => {
    const first = await participant(join(home, 'data'), 'fixture/repo', 'primary')
    const identityPath = join(first.directory, '.execution-store.json')
    const identity = {
      version: 1, id: randomUUID(),
      registries: Array.from({ length: 255 }, (_, index) => ({
        directory: join(home, `previous-${index}-${'\u6d4b'.repeat(21800)}`), id: randomUUID(),
      })),
    }
    const limit = 16 * 1024 * 1024
    let padding = limit - 10 - Buffer.byteLength(JSON.stringify(identity))
    expect(padding).toBeGreaterThan(0)
    for (const entry of identity.registries) {
      const extra = Math.min(padding, 32768 - entry.directory.length)
      entry.directory += 'x'.repeat(extra)
      padding -= extra
    }
    expect(padding).toBe(0)
    const original = JSON.stringify(identity)
    expect(Buffer.byteLength(original)).toBe(limit - 10)
    writeFileSync(identityPath, original)
    const before = first.state()
    await expect(first.begin()).rejects.toThrow()
    expect(first.state()).toEqual(before)
    expect(readFileSync(identityPath, 'utf8') === original).toBe(true)
    identity.registries = []
    writeFileSync(identityPath, JSON.stringify(identity))
    await first.begin()
    first.returned()
    first.adopted()
    expect(first.state().operations[0]!.status).toBe('accepted')
  }, 20_000)

  async function worker(owner: Awaited<ReturnType<typeof participant>>, actor: string, request: unknown, crash?: 'before-save' | 'after-save') {
    const ready = join(home, `${actor}.ready`)
    const gate = join(home, 'gate')
    const written = join(workspace, 'writes.txt')
    const input = join(home, `${actor}.json`)
    writeFileSync(input, JSON.stringify({ directory: owner.directory, todo_id: owner.todoId,
      execution_id: owner.executionId, request, ready, gate, written, actor, crash }))
    const fixture = fileURLToPath(new URL('./__fixtures__/workspace-contender.ts', import.meta.url))
    const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url))
    const child = spawn(process.execPath, [tsx, fixture, input], { windowsHide: true })
    let stdout = '', stderr = ''
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.on('error', reject)
      child.stdout.on('data', data => { stdout += data })
      child.stderr.on('data', data => { stderr += data })
      child.on('close', code => resolve({ code, stdout, stderr }))
    })
    const deadline = Date.now() + 10_000
    while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (!existsSync(ready)) {
      child.kill()
      await done
      throw new Error(`Worker failed before its gate: ${stderr}`)
    }
    return { done, gate, written }
  }

  it('grants only one of two simultaneous processes, so only that process changes the file', async () => {
    const first = await participant(join(home, 'data'), 'fixture/repo', 'primary-a')
    const second = await participant(join(home, 'other-data'), 'fixture/repo', 'primary-b')
    const a = await worker(first, 'a', first.beginRequest())
    const b = await worker(second, 'b', second.beginRequest())
    writeFileSync(a.gate, 'start')
    const results = await Promise.all([a.done, b.done])
    expect(results.map(item => ({ code: item.code, stderr: item.stderr }))).toEqual([
      { code: 0, stderr: '' }, { code: 0, stderr: '' },
    ])
    expect(results.map(item => JSON.parse(item.stdout).granted).sort()).toEqual([false, true])
    const writer = readFileSync(a.written, 'utf8').trim()
    expect(['a', 'b']).toContain(writer)
    expect(readFileSync(a.written, 'utf8')).toBe(`${writer}\n`)
  }, 25_000)

  it.each(['before-save', 'after-save'] as const)('preserves acquisition visibility when a process exits %s', async crash => {
    const first = await participant(join(home, 'data'), 'fixture/repo', 'primary-a')
    const second = await participant(join(home, 'other-data'), 'fixture/repo', 'primary-b')
    const process = await worker(first, 'a', first.beginRequest(), crash)
    writeFileSync(process.gate, 'start')
    expect((await process.done).code).toBe(72)
    if (crash === 'before-save') {
      await second.begin()
      writeFileSync(join(workspace, 'source.txt'), 'b after uncommitted acquisition')
      expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe('b after uncommitted acquisition')
    }
    else {
      await expect(second.begin()).rejects.toThrow(/occupied/i)
      expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe('original')
    }
  }, 25_000)

  it.each(['before-save', 'after-save'] as const)('preserves release ordering when a process exits %s', async crash => {
    const first = await participant(join(home, 'data'), 'fixture/repo', 'primary-a')
    const second = await participant(join(home, 'other-data'), 'fixture/repo', 'primary-b')
    await first.begin()
    writeFileSync(join(workspace, 'source.txt'), 'a unfinished')
    first.returned()
    const process = await worker(first, 'a', { request_id: 'adopt', expected_revision: first.state().revision,
      command: { action: 'adopt_operation', operation_id: 'write', actor: 'primary-a', decision: 'accepted', note: 'Inspected actual work' },
    }, crash)
    writeFileSync(process.gate, 'start')
    expect((await process.done).code).toBe(72)
    if (crash === 'after-save') {
      await second.begin()
      writeFileSync(join(workspace, 'source.txt'), 'b after durable release')
      expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe('b after durable release')
    }
    else {
      await expect(second.begin()).rejects.toThrow(/occupied/i)
      expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe('a unfinished')
    }
  }, 25_000)
})
