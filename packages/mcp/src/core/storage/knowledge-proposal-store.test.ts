import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { KnowledgeProposalStore, type ProposalInput } from './knowledge-proposal-store.js'

function sampleInput(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    repo: 'owner/repo',
    target: 'ci-conventions',
    action: 'create',
    source_type: 'todo',
    title: 'CI requires pnpm',
    rationale: 'discovered while running tests',
    proposed_content: '# CI\n\nUse pnpm.',
    ...overrides,
  }
}

describe('KnowledgeProposalStore', () => {
  let dir: string
  let store: KnowledgeProposalStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kp-test-'))
    store = new KnowledgeProposalStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty list when no file exists', () => {
    expect(store.list()).toEqual([])
    expect(store.countPending()).toBe(0)
  })

  it('creates a proposal with pending status and persists to YAML', () => {
    const p = store.add(sampleInput())
    expect(p.id).toBe('kp-1')
    expect(p.status).toBe('pending')
    expect(p.source_ref).toBeNull()
    expect(p.applied_at).toBeNull()

    const content = readFileSync(join(dir, 'knowledge.proposals.yaml'), 'utf-8')
    expect(content).toContain('id: kp-1')
    expect(content).toContain('status: pending')
  })

  it('allocates sequential ids', () => {
    expect(store.add(sampleInput()).id).toBe('kp-1')
    expect(store.add(sampleInput()).id).toBe('kp-2')
    expect(store.add(sampleInput()).id).toBe('kp-3')
  })

  it('filters by status', () => {
    store.add(sampleInput())
    store.add(sampleInput())
    store.markApplied('kp-1')
    expect(store.listByStatus('pending').map(p => p.id)).toEqual(['kp-2'])
    expect(store.listByStatus('applied').map(p => p.id)).toEqual(['kp-1'])
    expect(store.listByStatus().length).toBe(2)
  })

  it('markApplied sets status and applied_at', () => {
    store.add(sampleInput())
    const applied = store.markApplied('kp-1')
    expect(applied.status).toBe('applied')
    expect(applied.applied_at).not.toBeNull()
    expect(store.countPending()).toBe(0)
  })

  it('markRejected records reason', () => {
    store.add(sampleInput())
    const rejected = store.markRejected('kp-1', 'not relevant')
    expect(rejected.status).toBe('rejected')
    expect(rejected.rejected_reason).toBe('not relevant')
    expect(rejected.rejected_at).not.toBeNull()
  })

  it('throws when transitioning a non-pending proposal', () => {
    store.add(sampleInput())
    store.markApplied('kp-1')
    expect(() => store.markApplied('kp-1')).toThrow(/already applied/)
    expect(() => store.markRejected('kp-1')).toThrow(/already applied/)
  })

  it('throws when transitioning an unknown proposal', () => {
    expect(() => store.markApplied('kp-999')).toThrow(/not found/)
  })

  it('pending proposals survive reload', () => {
    store.add(sampleInput())
    store.add(sampleInput({ source_ref: '42' }))
    const reloaded = new KnowledgeProposalStore(dir)
    expect(reloaded.list()).toHaveLength(2)
    expect(reloaded.get('kp-2')?.source_ref).toBe('42')
    expect(existsSync(join(dir, 'knowledge.proposals.yaml'))).toBe(true)
  })

  it('records and transitions an applied rollback snapshot', () => {
    store.add(sampleInput())
    store.markApplied('kp-1', { existed: true, content: '# Previous' })
    const rolledBack = store.markRolledBack('kp-1')
    expect(rolledBack.status).toBe('rolled_back')
    expect(rolledBack.previous_content).toBe('# Previous')
    expect(rolledBack.rolled_back_at).not.toBeNull()
  })

  it('refreshes a matching patrol proposal instead of duplicating it', () => {
    const first = store.addOrRefresh(sampleInput({ source_type: 'patrol', source_ref: 'run-1' }))
    const second = store.addOrRefresh(sampleInput({ source_type: 'patrol', source_ref: 'run-2' }))

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.proposal.id).toBe('kp-1')
    expect(second.proposal.evidence_count).toBe(2)
    expect(second.proposal.source_refs).toEqual(['run-1', 'run-2'])
    expect(store.list()).toHaveLength(1)
  })
})
