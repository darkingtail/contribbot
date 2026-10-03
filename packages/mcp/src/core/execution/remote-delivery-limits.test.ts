import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowState } from './contracts.js'
import type { Candidate } from './candidate.js'

const fixture = vi.hoisted(() => ({
  state: {} as WorkflowState, candidate: {} as Candidate,
  getPull: vi.fn(), getGitReference: vi.fn(), getGitCommit: vi.fn(), getGitTree: vi.fn(),
  observeCommitDelivery: vi.fn(), put: vi.fn(),
}))
vi.mock('../clients/github.js', () => fixture)
vi.mock('./commit-delivery.js', () => fixture)
vi.mock('./candidate.js', () => ({
  captureCandidate: () => fixture.candidate,
  verifyCandidateManifest: vi.fn(),
}))
vi.mock('./processes.js', () => ({ assertLocalWorkspace: vi.fn() }))
vi.mock('../storage/todo-store.js', () => ({
  TodoStore: class {
    resolveItemFromAll() { return { executions: [{ id: 'execution', closed_at: null, workflow: fixture.state }] } }
  },
}))
vi.mock('./artifacts.js', () => ({
  ExecutionArtifacts: class {
    put = fixture.put
    get() { return {} }
  },
}))

import { collectRemoteDeliveries, remoteDeliveryObservations } from './remote-delivery.js'
import { createWorkflow } from './workflow.js'
import { fixtureRepository } from './__fixtures__/repository.js'

const sha = (number: number) => number.toString(16).padStart(40, '0')
const collect = () => collectRemoteDeliveries('/fixture', 'todo', 'execution', fixture.state, fixture.candidate)
function deliveries(count: number) {
  fixture.state.plans[0]!.content.deliverables = Array.from({ length: count }, (_, number) => ({
    id: `delivery-${number}`, description: 'Fixture', required: false, acceptance_ids: ['review'],
    target: { kind: 'remote_pull', repo: fixtureRepository('fixture/repo'), number: number + 1,
      base: 'main', endpoint: 'merged', allow_draft: false, scope: ['src'] },
  }))
}

describe('remote collector boundaries with isolated dependency doubles', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fixture.candidate = {
      version: 1, root: '/work', git_dir: '/work/.git', common_dir: '/work/.git', head: sha(100),
      digest: 'a'.repeat(64),
      files: [{ path: 'src/file', index_mode: '100644', index_oid: sha(200), executable: false, digest: 'b'.repeat(64) }],
    }
    fixture.state = {
      ...createWorkflow(), plan_id: 'plan', attempt_id: 'attempt',
      plans: [{
        id: 'plan', digest: 'c'.repeat(64), confirmation: { locator: 'fixture:user', at: new Date().toISOString() },
        content: { goal: 'Fixture', non_goals: [], scope: ['.'], risk: 'normal',
          completion_scope: 'task', remaining_scope: [],
          steps: [{ id: 'code', title: 'Code', scope: ['.'], depends_on: [], acceptance_ids: ['review'] }],
          acceptance: [{ id: 'review', description: 'Review', required: true, kind: 'manual', independent: false }] },
      }],
      attempts: [{
        id: 'attempt', plan_id: 'plan', owner: 'fixture', started_at: new Date().toISOString(),
        workspace: { repo: { platform: 'github', instance: 'https://github.com', path: 'fixture/repo' },
          root: '/work', git_dir: '/work/.git', common_dir: '/work/.git', baseline: 'a'.repeat(64) },
      }],
    }
    fixture.observeCommitDelivery.mockReturnValue({ endpoint: 'present', note: 'Fixture local match', commit: {} })
    fixture.put.mockReturnValue('d'.repeat(64))
    fixture.getPull.mockImplementation(async (_owner, _repo, number) => ({
      number, state: 'closed', merged: true, draft: false, merged_at: '2026-09-19T00:00:00Z',
      merge_commit_sha: sha(number),
      base: { ref: 'main', sha: sha(101), repo: { full_name: 'fixture/repo' } },
      head: { ref: 'branch', sha: sha(102), repo: { full_name: 'fixture/repo' } },
    }))
    fixture.getGitCommit.mockImplementation(async (_owner, _repo, oid) => ({ sha: oid, tree: { sha: oid } }))
    fixture.getGitTree.mockImplementation(async (_owner, _repo, oid) => ({
      sha: oid, truncated: false, tree: [{ path: 'src/file', mode: '100644', type: 'blob', sha: sha(200) }],
    }))
  })

  it('drains started readers and does not assign later targets after receipt publication fails', async () => {
    deliveries(8)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let publicationFailed = false
    let settled = false
    fixture.getGitTree.mockImplementation(async (_owner, _repo, oid) => {
      if (oid !== sha(1)) await gate
      return { sha: oid, truncated: false, tree: [{ path: 'src/file', mode: '100644', type: 'blob', sha: sha(200) }] }
    })
    fixture.put.mockImplementation(value => {
      if (value.source === 'github_read' && value.delivery.id === 'delivery-0') {
        publicationFailed = true
        throw new Error('Fixture publication failed')
      }
      return 'd'.repeat(64)
    })
    const outcome = collect().then(
      () => { settled = true; return { error: null } },
      error => { settled = true; return { error } },
    )
    try {
      await vi.waitFor(() => { expect(publicationFailed).toBe(true) })
      expect(settled).toBe(false)
    }
    finally {
      release()
      const result = await outcome
      expect(result.error).toMatchObject({ message: 'Fixture publication failed' })
    }
    expect(fixture.getGitTree).toHaveBeenCalledTimes(4)
  })

  it('caps queries at twenty and keeps capped required items explicitly unobserved', async () => {
    deliveries(25)
    fixture.state.plans[0]!.content.deliverables![24]!.required = true
    const batch = await collect()
    const { digest, root, git_dir, common_dir } = fixture.candidate
    const observations = remoteDeliveryObservations(batch, '/fixture', 'todo', 'execution',
      fixture.state, { digest, root, git_dir, common_dir })
    expect(fixture.getGitTree).toHaveBeenCalledTimes(20)
    expect(fixture.observeCommitDelivery).toHaveBeenCalledTimes(20)
    expect(observations.size).toBe(25)
    expect(observations.get('delivery-24')!.endpoint).toBe('not_observed')
  })
})
