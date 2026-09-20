import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoStore } from '../storage/todo-store.js'
import { ExecutionArtifacts } from './artifacts.js'
import type { WorkflowPlanInput } from './contracts.js'
import { runLocalCommand } from './local.js'
import { planDigest } from './workflow.js'
import { prepareClosureWithReadback, finalizeClosureWithReadback } from './closure.js'
import { captureCandidate } from './candidate.js'
import { verifyReadiness } from './verification.js'
import * as commits from './commit-delivery.js'

const api = vi.hoisted(() => ({
  getPull: vi.fn(), getGitReference: vi.fn(), getGitCommit: vi.fn(), getGitTree: vi.fn(),
}))
vi.mock('../clients/github.js', () => api)

const remoteTarget = () => ({
  kind: 'remote_pull' as const, repo: 'fixture/delivery', number: 7, base: 'main',
  endpoint: 'merged' as const, scope: ['src'], allow_draft: false,
})
const planFor = (target: unknown = remoteTarget(), required = true): WorkflowPlanInput => ({
  goal: 'Deliver the implementation', completion_scope: 'task', remaining_scope: [],
  scope: ['.'], non_goals: [], risk: 'normal',
  steps: [{ id: 'code', title: 'Implement', scope: ['.'], depends_on: [], acceptance_ids: ['review'] }],
  acceptance: [{ id: 'review', description: 'Content accepted', required: true, kind: 'manual', independent: false }],
  deliverables: [{ id: 'delivery', description: 'Declared remote delivery', required, acceptance_ids: ['review'], target }],
} as WorkflowPlanInput)

describe('explicit remote delivery declarations', () => {
  it('accepts exact scoped PR and remote ref declarations as part of the plan digest', () => {
    expect(() => planDigest(planFor())).not.toThrow()
    expect(() => planDigest(planFor({ kind: 'remote_ref', repo: 'fixture/delivery', ref: 'refs/heads/main', scope: ['src'] }))).not.toThrow()
    expect(planDigest(planFor())).not.toBe(planDigest(planFor({ ...remoteTarget(), number: 8 })))
  })

  it('rejects an implicit PR, unsafe identity, duplicate scope and scope outside the plan', () => {
    for (const target of [
      { ...remoteTarget(), number: undefined }, { ...remoteTarget(), repo: '../delivery' },
      { ...remoteTarget(), scope: ['src', 'src'] }, { ...remoteTarget(), scope: ['../other'] },
    ]) expect(() => planDigest(planFor(target))).toThrow()
    const outside = planFor()
    outside.scope = ['docs']
    outside.steps[0]!.scope = ['docs']
    expect(() => planDigest(outside)).toThrow(/scope/i)
  })
})

describe('fresh remote readback for the current delivery candidate', () => {
  let home: string
  let workspace: string
  let directory: string
  let store: TodoStore
  let todoId: string
  let executionId: string
  let serial: number
  let pull: Record<string, unknown>
  let tree: { sha: string; truncated: boolean; tree: { path: string; mode: string; type: string; sha: string }[] }
  const state = () => store.get(0)!.executions[0]!.workflow!
  const local = (action: string, payload: Record<string, unknown> = {}) => runLocalCommand({
    action, repo: 'fixture/delivery', data_root: join(home, 'data'),
    todo_id: todoId, execution_id: executionId, ...payload,
  })
  const mutation = () => ({ request_id: `fixture-${++serial}`, expected_revision: state()?.revision ?? 0 })
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=nonexistent-hooks', '-c', 'commit.gpgSign=false', ...args,
  ], { cwd: workspace, windowsHide: true, stdio: 'pipe', encoding: 'utf8' }).trim()
  const setup = async (plan = planFor()) => {
    await local('apply', { ...mutation(), command: { action: 'propose_plan', plan_id: 'plan', plan } })
    await local('apply', { ...mutation(), command: {
      action: 'confirm_plan', plan_id: 'plan', digest: state().plans[0]!.digest, confirmation: 'fixture:exact-plan-confirmed',
    } })
    await local('bind', { ...mutation(), workspace, attempt_id: 'attempt', owner: 'builder' })
    await local('yield', { ...mutation(), actor: 'builder', observed_operations: [], note: 'All fixture writers stopped' })
    await local('report', {
      ...mutation(), operation_id: 'review', acceptance_id: 'review',
      plan_id: state().plan_id, attempt_id: state().attempt_id, epoch: state().epoch, candidate: state().yield!.candidate,
      actor: 'fixture-user', source: 'user', observed_at: new Date().toISOString(), outcome: 'passed',
      locator: 'fixture:human-report', summary: 'Content accepted; user also reports that the PR was merged.',
    })
  }
  const close = (mode = 'verified', acknowledged_gaps: string[] = []) => local('close', {
    closure_id: `close-${++serial}`, expected_revision: state().revision,
    mode, acknowledged_gaps, decision: 'fixture:finish-whole-task', note: 'Explicit fixture completion',
    target: { kind: 'local' },
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
    home = mkdtempSync(join(tmpdir(), 'contribbot-remote-delivery-'))
    workspace = join(home, 'workspace')
    directory = join(home, 'data/fixture/delivery')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    git('init', '--quiet', '--initial-branch=fixture')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('remote', 'add', 'origin', 'https://github.com/fixture/delivery.git')
    writeFileSync(join(workspace, 'src/index.txt'), 'implemented\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'fixture')
    store = new TodoStore(directory)
    todoId = store.add({ ref: 'remote', title: 'Remote delivery', type: 'feature' }).id!
    executionId = store.activateExecution(0).execution.id
    writeFileSync(join(directory, 'config.yaml'), 'fork: null\nupstream: null\n')
    serial = 0
    const remoteSha = 'a'.repeat(40)
    pull = {
      number: 7, merged: true, state: 'closed', draft: false,
      merged_at: '2026-09-19T00:00:00Z', merge_commit_sha: remoteSha,
      base: { ref: 'main', sha: 'c'.repeat(40), repo: { full_name: 'fixture/delivery' } },
      head: { ref: 'feature', sha: 'b'.repeat(40), repo: { full_name: 'contributor/delivery' } },
    }
    tree = {
      sha: 'd'.repeat(40), truncated: false,
      tree: [{ path: 'src/index.txt', mode: '100644', type: 'blob', sha: git('rev-parse', 'HEAD:src/index.txt') }],
    }
    api.getPull.mockImplementation(async () => structuredClone(pull))
    api.getGitReference.mockImplementation(async () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: remoteSha } }))
    api.getGitCommit.mockImplementation(async (_owner, _repo, sha) => ({ sha, tree: { sha: tree.sha } }))
    api.getGitTree.mockImplementation(async () => structuredClone(tree))
  })
  afterEach(() => {
    if (resolve(home).startsWith(`${resolve(tmpdir())}\\contribbot-remote-delivery-`)
      || resolve(home).startsWith(`${resolve(tmpdir())}/contribbot-remote-delivery-`)) {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not satisfy required remote delivery using a passed human report when the query fails', async () => {
    await setup()
    api.getPull.mockRejectedValue(new Error('secret-token-must-not-appear'))
    const result = await local('inspect')
    expect(result.readiness).toMatchObject({
      ready: false, gaps: ['delivery:delivery'], deliveries: [{ endpoint: 'not_observed' }],
    })
    expect(JSON.stringify(result)).not.toContain('secret-token')
    await expect(close('with_gaps', ['delivery:delivery'])).rejects.toThrow(/delivery/i)
    expect(store.get(0)!.status).toBe('active')
    expect(store.listArchived()).toEqual([])
  }, 30_000)

  it('verifies scoped merge content without equating a squash/rebase merge SHA with local HEAD', async () => {
    await setup()
    expect(pull.merge_commit_sha).not.toBe(git('rev-parse', 'HEAD'))
    const result = await local('inspect')
    expect(result.readiness).toMatchObject({ ready: true, deliveries: [{ endpoint: 'present' }] })
    expect(api.getPull).toHaveBeenCalledTimes(2)
    expect(store.get(0)!.status).toBe('active')
    const completed = await close()
    expect(completed.todo).toMatchObject({ status: 'done' })
    expect(api.getPull).toHaveBeenCalledTimes(6)
    expect(store.listArchived()).toEqual([])
    const record = new ExecutionArtifacts(directory, executionId).get(state().closure!.verification)
    expect(record).toMatchObject({ deliveries: [{ endpoint: 'present', remote: { source: 'github_read' } }] })
  }, 30_000)

  it('rejects an unrelated old merge and does not reuse an earlier successful inspection at closure', async () => {
    await setup()
    expect((await local('inspect')).readiness).toMatchObject({ ready: true })
    tree.tree[0]!.sha = 'e'.repeat(40)
    expect((await local('inspect')).readiness).toMatchObject({
      ready: false, deliveries: [{ endpoint: 'missing' }],
    })
    await expect(close()).rejects.toThrow(/delivery/i)
  }, 30_000)

  it('does not query remote targets just to display stored context', async () => {
    await setup()
    const before = readFileSync(join(directory, 'todos.yaml'), 'utf8')
    expect(await local('context')).toMatchObject({
      readiness: null, delivery_requirements: { items: [{ target: remoteTarget() }] },
    })
    expect(api.getPull).not.toHaveBeenCalled()
    expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toBe(before)
  }, 30_000)

  it('checks the current remote branch contents without pushing or changing the local branch', async () => {
    await setup(planFor({ kind: 'remote_ref', repo: 'fixture/delivery', ref: 'refs/heads/main', scope: ['src'] }))
    const head = git('rev-parse', 'HEAD')
    expect((await local('inspect')).readiness).toMatchObject({ ready: true, deliveries: [{ endpoint: 'present' }] })
    expect(api.getGitReference).toHaveBeenCalledWith('fixture', 'delivery', 'refs/heads/main')
    expect(api.getPull).not.toHaveBeenCalled()
    expect(git('rev-parse', 'HEAD')).toBe(head)
    api.getGitReference.mockResolvedValue({ ref: 'refs/heads/other', object: { type: 'commit', sha: 'a'.repeat(40) } })
    expect((await local('inspect')).readiness).toMatchObject({ ready: false, deliveries: [{ endpoint: 'not_observed' }] })
  }, 30_000)

  it.each([
    ['open', false, false, 'present'],
    ['open', true, false, 'missing'],
    ['open', true, true, 'present'],
    ['closed', false, false, 'missing'],
  ] as const)('checks submitted PR state=%s draft=%s allow=%s', async (status, draft, allow, endpoint) => {
    pull = { ...pull, merged: false, merged_at: null, merge_commit_sha: null, state: status, draft }
    await setup(planFor({ ...remoteTarget(), endpoint: 'submitted', allow_draft: allow }))
    expect((await local('inspect')).readiness).toMatchObject({ deliveries: [{ endpoint }] })
    if (endpoint === 'present') expect(api.getGitCommit).toHaveBeenCalledWith('contributor', 'delivery', 'b'.repeat(40))
  }, 30_000)

  it.each(['number', 'repo', 'base', 'merge-sha', 'truncated', 'tree-sha', 'duplicate', 'unsupported', 'changes'] as const)(
    'does not certify an incomplete, mismatched or changing remote response: %s', async fault => {
      await setup()
      if (fault === 'number') pull.number = 999
      if (fault === 'repo') (pull.base as { repo: { full_name: string } }).repo.full_name = 'other/repo'
      if (fault === 'base') (pull.base as { ref: string }).ref = 'wrong-base'
      if (fault === 'merge-sha') pull.merge_commit_sha = null
      if (fault === 'truncated') tree.truncated = true
      if (fault === 'tree-sha') api.getGitTree.mockImplementation(async () => ({ ...tree, sha: 'f'.repeat(40) }))
      if (fault === 'duplicate') tree.tree.push(structuredClone(tree.tree[0]!))
      if (fault === 'unsupported') tree.tree[0]!.mode = '120000'
      if (fault === 'changes') api.getGitTree.mockImplementation(async () => {
        pull.merge_commit_sha = 'f'.repeat(40)
        return tree
      })
      expect((await local('inspect')).readiness).toMatchObject({ ready: false, deliveries: [{ endpoint: 'not_observed' }] })
      expect(state().closure).toBeNull()
    }, 30_000,
  )

  it.each(['extra', 'absent', 'mode'] as const)('compares scoped file sets and Git modes: %s', async mismatch => {
    await setup()
    if (mismatch === 'extra') tree.tree.push({ ...tree.tree[0]!, path: 'src/extra.txt' })
    if (mismatch === 'absent') tree.tree = []
    if (mismatch === 'mode') tree.tree[0]!.mode = '100755'
    expect((await local('inspect')).readiness).toMatchObject({ ready: false, deliveries: [{ endpoint: 'missing' }] })
  }, 30_000)

  it('ignores unrelated remote changes outside the declared delivery scope', async () => {
    tree.tree.push({ path: 'other.txt', mode: '100644', type: 'blob', sha: 'e'.repeat(40) })
    await setup()
    expect((await local('inspect')).readiness).toMatchObject({ ready: true, deliveries: [{ endpoint: 'present' }] })
  }, 30_000)

  it('verifies a committed deletion and rejects its continued presence remotely', async () => {
    rmSync(join(workspace, 'src/index.txt'))
    git('add', '.')
    git('commit', '--quiet', '-m', 'delete fixture')
    await setup()
    expect((await local('inspect')).readiness).toMatchObject({ ready: false, deliveries: [{ endpoint: 'missing' }] })
    tree.tree = []
    expect((await local('inspect')).readiness).toMatchObject({ ready: true, deliveries: [{ endpoint: 'present' }] })
  }, 30_000)

  it('does not certify uncommitted scoped content, even if a PR was merged', async () => {
    writeFileSync(join(workspace, 'src/index.txt'), 'uncommitted\n')
    await setup()
    expect((await local('inspect')).readiness).toMatchObject({ ready: false, deliveries: [{ endpoint: 'missing' }] })
    expect(api.getPull).not.toHaveBeenCalled()
  }, 30_000)

  it('retains optional unknown observations without making them completion gates', async () => {
    await setup(planFor(remoteTarget(), false))
    api.getPull.mockRejectedValue(new Error('unavailable'))
    expect((await local('inspect')).readiness).toMatchObject({
      ready: true, gaps: [], deliveries: [{ required: false, endpoint: 'not_observed' }],
    })
    expect((await close()).todo).toMatchObject({ status: 'done' })
  }, 30_000)

  it('handles multiple PR deliveries independently instead of inferring requirements from links', async () => {
    const plan = planFor()
    plan.deliverables!.push({ ...plan.deliverables![0]!, id: 'other', target: { ...remoteTarget(), number: 8 } })
    await setup(plan)
    api.getPull.mockImplementation(async (_owner, _repo, number) => ({
      ...structuredClone(pull), number,
      ...(number === 8 ? { merged: false, state: 'open', merged_at: null, merge_commit_sha: null } : {}),
    }))
    expect((await local('inspect')).readiness).toMatchObject({
      ready: false, gaps: ['delivery:other'],
      deliveries: [{ id: 'delivery', endpoint: 'present' }, { id: 'other', endpoint: 'missing' }],
    })
  }, 30_000)

  it.each(['files', 'pause'] as const)('rejects a query that finishes after %s change', async kind => {
    await setup()
    api.getGitTree.mockImplementationOnce(async () => {
      if (kind === 'files') writeFileSync(join(workspace, 'src/index.txt'), 'changed during query\n')
      else await local('apply', { ...mutation(), command: {
        action: 'request_control', control_id: 'pause', kind: 'pause', decision: 'fixture:user-pauses', note: 'Stop dispatch',
      } })
      return structuredClone(tree)
    })
    await expect(local('inspect')).rejects.toThrow(/changed.*observation/i)
    expect(state().closure).toBeNull()
    if (kind === 'pause') expect(state().control?.active_id).toBe('pause')
  }, 30_000)

  it('does not accept serialized provenance or an earlier report as a query batch', async () => {
    await setup()
    const snapshot = captureCandidate(workspace)
    expect(verifyReadiness(directory, todoId, executionId, state(), state().yield!.candidate, false, snapshot))
      .toMatchObject({ ready: false, deliveries: [{ endpoint: 'not_observed' }] })
    expect(() => verifyReadiness(directory, todoId, executionId, state(), state().yield!.candidate, false, snapshot,
      { kind: 'remote-delivery-batch' })).toThrow(/internal observation/i)
    await expect(local('inspect', { remote_batch: { source: 'github_read', endpoint: 'present' } })).rejects.toThrow()
  }, 30_000)

  it('rechecks prepared closures, retains failed finalization, and skips readback on completed replay', async () => {
    await setup()
    const request = {
      directory, todo_id: todoId, execution_id: executionId, closure_id: 'prepared',
      expected_revision: state().revision, mode: 'verified', acknowledged_gaps: [],
      decision: 'fixture:finish', note: 'Finish confirmed', target: { kind: 'local' },
    }
    await prepareClosureWithReadback(request)
    api.getPull.mockRejectedValueOnce(new Error('unavailable'))
    await expect(finalizeClosureWithReadback(request)).rejects.toThrow(/delivery/i)
    expect(state().closings.at(-1)!.state).toBe('prepared')
    expect(state().closure).toBeNull()
    expect((await finalizeClosureWithReadback(request)).status).toBe('done')
    api.getPull.mockClear()
    writeFileSync(join(workspace, 'later.txt'), 'unrelated later work')
    expect((await finalizeClosureWithReadback(request)).status).toBe('done')
    expect(api.getPull).not.toHaveBeenCalled()
  }, 30_000)

  it('does not require remote delivery or network access to safely stop', async () => {
    await setup()
    await local('apply', { ...mutation(), command: {
      action: 'request_control', control_id: 'cancel', kind: 'cancel',
      decision: 'fixture:finish-whole-task', note: 'Stop without remote delivery.',
    } })
    expect((await close('stopped')).todo).toMatchObject({ status: 'cancelled' })
    expect(api.getPull).not.toHaveBeenCalled()
    expect(state().closure?.gaps).toContain('delivery:delivery')
  }, 30_000)

  it('does not swallow a detected local drift even when final bytes return and the target is optional', async () => {
    await setup(planFor(remoteTarget(), false))
    vi.spyOn(commits, 'observeCommitDelivery').mockImplementationOnce(() => {
      throw new Error('Candidate changed during commit delivery observation; yield again.')
    })
    await expect(local('inspect')).rejects.toThrow(/Candidate changed during commit delivery/i)
    expect(api.getPull).not.toHaveBeenCalled()
  }, 30_000)
})
