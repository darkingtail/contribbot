import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  knowledgeProposeUpdate,
  knowledgeProposals,
  knowledgeApplyUpdate,
  knowledgeRejectUpdate,
  countPendingProposals,
} from './knowledge-evolution.js'

let home: string
let repoCounter = 0
let owner: string
let name: string

const origHome = process.env.HOME
const origUserProfile = process.env.USERPROFILE

function knowledgePath(target: string): string {
  return join(home, '.contribbot', owner, name, 'knowledge', target, 'README.md')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kp-tool-home-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  // Unique repo per test so resolveRepo's in-process cache never collides.
  repoCounter += 1
  owner = `owner${repoCounter}`
  name = `repo${repoCounter}`
  // Seed config.yaml so resolveRepo resolves offline (no GitHub API call).
  const repoDir = join(home, '.contribbot', owner, name)
  mkdirSync(repoDir, { recursive: true })
  writeFileSync(join(repoDir, 'config.yaml'), 'fork: null\nupstream: null\n', 'utf-8')
})

afterEach(() => {
  process.env.HOME = origHome
  process.env.USERPROFILE = origUserProfile
  rmSync(home, { recursive: true, force: true })
})

const repo = () => `${owner}/${name}`

async function propose(overrides: Record<string, unknown> = {}) {
  return knowledgeProposeUpdate({
    repo: repo(),
    target: 'arch',
    action: 'create',
    source_type: 'todo',
    title: 'Architecture note',
    rationale: 'reusable',
    proposed_content: '# Arch\n\nLayered.',
    ...overrides,
  })
}

describe('knowledge evolution tools', () => {
  it('propose does NOT write canonical knowledge', async () => {
    const out = await propose()
    expect(out).toContain('kp-1')
    expect(() => readFileSync(knowledgePath('arch'), 'utf-8')).toThrow()
    expect(countPendingProposals(owner, name)).toBe(1)
  })

  it('apply create writes README with provenance footer', async () => {
    await propose({ source_ref: '42', source_type: 'issue' })
    const out = await knowledgeApplyUpdate(repo(), 'kp-1')
    expect(out).toContain('applied')
    const content = readFileSync(knowledgePath('arch'), 'utf-8')
    expect(content).toContain('# Arch')
    expect(content).toContain('<!-- contribbot:provenance -->')
    expect(content).toContain('via kp-1')
    expect(content).toContain('issue#42')
    expect(countPendingProposals(owner, name)).toBe(0)
  })

  it('apply create fails when target already exists', async () => {
    await propose()
    await knowledgeApplyUpdate(repo(), 'kp-1')
    await propose() // kp-2, also create
    await expect(knowledgeApplyUpdate(repo(), 'kp-2')).rejects.toThrow(/already exists/)
  })

  it('append adds to existing entry', async () => {
    await propose()
    await knowledgeApplyUpdate(repo(), 'kp-1')
    await propose({ action: 'append', proposed_content: 'Extra section.' })
    await knowledgeApplyUpdate(repo(), 'kp-2')
    const content = readFileSync(knowledgePath('arch'), 'utf-8')
    expect(content).toContain('# Arch')
    expect(content).toContain('Extra section.')
  })

  it('append fails when target does not exist', async () => {
    await propose({ action: 'append', proposed_content: 'x' })
    await expect(knowledgeApplyUpdate(repo(), 'kp-1')).rejects.toThrow(/does not exist/)
  })

  it('revise replaces content and does not stack footers', async () => {
    await propose()
    await knowledgeApplyUpdate(repo(), 'kp-1')
    await propose({ action: 'revise', proposed_content: '# Arch v2\n\nRewritten.' })
    await knowledgeApplyUpdate(repo(), 'kp-2')
    const content = readFileSync(knowledgePath('arch'), 'utf-8')
    expect(content).toContain('Rewritten.')
    expect(content).not.toContain('Layered.')
    // Footer marker appears exactly once after a revise.
    expect(content.match(/contribbot:provenance/g)).toHaveLength(1)
    expect(content).toContain('via kp-2')
  })

  it('apply fails on an already-applied proposal', async () => {
    await propose()
    await knowledgeApplyUpdate(repo(), 'kp-1')
    await expect(knowledgeApplyUpdate(repo(), 'kp-1')).rejects.toThrow(/already applied/)
  })

  it('reject marks proposal and leaves canonical untouched', async () => {
    await propose()
    const out = await knowledgeRejectUpdate(repo(), 'kp-1', 'duplicate')
    expect(out).toContain('rejected')
    expect(() => readFileSync(knowledgePath('arch'), 'utf-8')).toThrow()
    const list = await knowledgeProposals(repo(), 'rejected')
    expect(list).toContain('kp-1')
  })

  it('rejects an unsafe target path', async () => {
    await expect(propose({ target: '../escape' })).rejects.toThrow(/Invalid path segment/)
  })

  it('proposals list is empty initially', async () => {
    const out = await knowledgeProposals(repo())
    expect(out).toContain('No proposals')
  })
})
