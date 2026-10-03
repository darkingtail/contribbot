import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RepoConfig } from '../../storage/repo-config.js'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'
import {
  knowledgeProposeUpdate,
  knowledgeProposals,
  knowledgeApplyUpdate,
  knowledgeRejectUpdate,
  knowledgeRollbackUpdate,
  countPendingProposals,
} from './knowledge-evolution.js'
import { knowledgeList, knowledgeRead } from './knowledge.js'

let home: string
let repoCounter = 0
let owner: string
let name: string

const origHome = process.env.HOME
const origUserProfile = process.env.USERPROFILE

function knowledgePath(target: string): string {
  return join(projectDirectory(repo()), 'knowledge', target, 'README.md')
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kp-tool-home-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  repoCounter += 1
  owner = `owner${repoCounter}`
  name = `repo${repoCounter}`
  new RepoConfig(projectDirectory(repo())).save({
    schema_version: 3, repository: repo(), lifecycle: { status: 'active' },
    parent: { status: 'unknown' }, tracking: { status: 'pending' },
  })
})

afterEach(() => {
  process.env.HOME = origHome
  process.env.USERPROFILE = origUserProfile
  rmSync(home, { recursive: true, force: true })
})

const repo = (): RepositoryRef => ({ platform: 'github', instance: 'https://github.com', path: `${owner}/${name}` })

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
    expect(out).toContain('# Arch')
    expect(out).toContain('Layered.')
    expect(() => readFileSync(knowledgePath('arch'), 'utf-8')).toThrow()
    expect(countPendingProposals(repo())).toBe(1)
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
    expect(countPendingProposals(repo())).toBe(0)
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

  it('patrol proposals accumulate evidence without creating duplicates', async () => {
    const first = await propose({ source_type: 'patrol', source_ref: 'run-1' })
    const second = await propose({ source_type: 'patrol', source_ref: 'run-2' })
    expect(first).toContain('created')
    expect(second).toContain('refreshed')
    expect(second).toContain('2 observation(s)')
    expect(countPendingProposals(repo())).toBe(1)
  })

  it('rolls back a created knowledge entry', async () => {
    await propose()
    await knowledgeApplyUpdate(repo(), 'kp-1')
    const out = await knowledgeRollbackUpdate(repo(), 'kp-1')
    expect(out).toContain('rolled back')
    expect(() => readFileSync(knowledgePath('arch'), 'utf-8')).toThrow()
    expect(await knowledgeProposals(repo(), 'rolled_back')).toContain('kp-1')
  })

  it('rolls back a revision to the previous canonical content', async () => {
    await propose()
    await knowledgeApplyUpdate(repo(), 'kp-1')
    await propose({ action: 'revise', proposed_content: '# Arch v2\n\nChanged.' })
    await knowledgeApplyUpdate(repo(), 'kp-2')
    await knowledgeRollbackUpdate(repo(), 'kp-2')
    const content = readFileSync(knowledgePath('arch'), 'utf-8')
    expect(content).toContain('Layered.')
    expect(content).not.toContain('Changed.')
  })

  it('isolates proposals and canonical knowledge across instances with the same path', async () => {
    const other: RepositoryRef = { platform: 'gitlab', instance: 'https://code.example.com/gitlab', path: repo().path }
    const anotherInstance: RepositoryRef = { ...other, instance: 'https://gitlab.com' }
    new RepoConfig(projectDirectory(other)).save({
      schema_version: 3, repository: other, lifecycle: { status: 'active' },
      parent: { status: 'unknown' }, tracking: { status: 'pending' },
    })
    new RepoConfig(projectDirectory(anotherInstance)).save({
      schema_version: 3, repository: anotherInstance, lifecycle: { status: 'active' },
      parent: { status: 'unknown' }, tracking: { status: 'pending' },
    })

    await propose()
    expect(await knowledgeProposals(other)).toContain('No proposals')
    expect(await knowledgeProposals(anotherInstance)).toContain('No proposals')
    expect(countPendingProposals(other)).toBe(0)
    await knowledgeApplyUpdate(repo(), 'kp-1')
    expect(() => readFileSync(join(projectDirectory(other), 'knowledge', 'arch', 'README.md'), 'utf-8')).toThrow()

    await knowledgeProposeUpdate({
      repo: other, target: 'arch', action: 'create', source_type: 'todo',
      title: 'Other architecture', rationale: 'different instance', proposed_content: '# Other',
    })
    await knowledgeApplyUpdate(other, 'kp-1')
    expect(readFileSync(knowledgePath('arch'), 'utf-8')).toContain('Layered.')
    expect(readFileSync(join(projectDirectory(other), 'knowledge', 'arch', 'README.md'), 'utf-8')).toContain('# Other')
    expect(await knowledgeRead('arch', other)).toContain('# Other')
    expect(await knowledgeRead('arch', anotherInstance)).toContain('not found')
    expect(await knowledgeList(anotherInstance)).toContain('No knowledge')
    expect(await knowledgeProposals(anotherInstance)).toContain('No proposals')
  })
})
