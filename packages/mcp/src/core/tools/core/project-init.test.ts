import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectInit } from './project-init.js'
import { repoConfig } from './repo-config-tool.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'

vi.mock('../../clients/github.js', () => ({
  ghApi: vi.fn().mockResolvedValue({ full_name: 'owner/repo', fork: false }),
}))

const repository: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'owner/repo' }
const source: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'other/repo' }
const fork: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'user/fork' }
const pending = '<!-- contribbot:tracking-status=pending -->'

let home: string
let dir: string
let store: RepoConfig
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'init-tracking-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  dir = projectDirectory(repository)
  store = new RepoConfig(dir)
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

function saveActive(): void {
  store.save({
    schema_version: 3,
    repository,
    lifecycle: { status: 'active' },
    parent: { status: 'unknown' },
    tracking: { status: 'pending' },
  })
}

describe('tracking confirmation', () => {
  it('new config requires an explicit tracking decision', async () => {
    const result = await projectInit(repository)
    expect(result).toContain(pending)
    expect(result).toContain('Ask whether to track')
    expect(result).toContain('repo_config')
    expect(result).toContain(`Pass repo: ${JSON.stringify(repository)}`)
    expect(result).not.toContain('Use the canonical repo `github://')
    expect(store.load()?.tracking).toEqual({ status: 'pending' })
    expect(await projectInit(repository)).toContain(pending)
  })

  it.each([
    { selection: [source], expected: { status: 'configured', sources: [source] } },
    { selection: '', expected: { status: 'none' } },
  ] as const)('persists explicit choice $expected.status and stops asking', async ({ selection, expected }) => {
    saveActive()
    const update = await repoConfig(repository, selection === '' ? '' : [...selection])
    expect(update).toContain(`<!-- contribbot:tracking-status=${expected.status} -->`)
    expect(store.load()?.tracking).toEqual(expected)
    const result = await projectInit(repository)
    expect(result).toContain(`<!-- contribbot:tracking-status=${expected.status} -->`)
    expect(result).not.toContain('Ask whether to track')
  })

  it('keeps a fork separate from its parent, including tracking and archived state', async () => {
    store.save({
      schema_version: 3,
      repository,
      lifecycle: { status: 'archived', archived_at: '2026-09-16T00:00:00.000Z' },
      parent: { status: 'unknown' },
      tracking: { status: 'pending' },
    })
    const forkStore = new RepoConfig(projectDirectory(fork))
    forkStore.save({
      schema_version: 3,
      repository: fork,
      lifecycle: { status: 'active' },
      parent: { status: 'confirmed', repository, relation_verified_at: '2026-09-16T00:00:00.000Z' },
      tracking: { status: 'pending' },
    })
    expect(await projectInit(fork)).toContain(pending)
    await repoConfig(fork, '')
    expect(forkStore.load()?.tracking).toEqual({ status: 'none' })
    expect(store.load()?.tracking).toEqual({ status: 'pending' })
    expect(store.load()?.lifecycle.status).toBe('archived')
    expect(await projectInit(repository)).toContain(pending)
  })

  it('rejects malformed tracking without changing the stored decision', async () => {
    saveActive()
    const before = store.load()
    await expect(repoConfig(repository, [{ ...source, path: '../repo' }])).rejects.toThrow()
    await expect(repoConfig(repository, [repository])).rejects.toThrow()
    expect(store.load()).toEqual(before)
  })

  it('renders current execution phase and next for session recovery', async () => {
    saveActive()
    writeFileSync(join(dir, 'todos.yaml'), `todos:
  - id: t-phase3
    ref: phase3
    title: Build Phase 3
    type: feature
    status: active
    difficulty: medium
    pr: 42
    branch: feat/phase3
    claimed_items: null
    created: "2026-09-16"
    updated: "2026-09-16"
    executions:
      - id: te-phase3
        goal: Build the execution recovery slice
        phase: execute
        next: Add project_init recovery output
        blocked_on: null
        evidence: []
        opened_at: "2026-09-16T08:00:00.000Z"
        closed_at: null
        outcome: null
        outcome_note: ""
`)
    const result = await projectInit(repository)
    expect(result).toContain('## Active Todo Recovery')
    expect(result).toContain('Build Phase 3')
    expect(result).toContain('Phase: `execute`')
    expect(result).toContain('Next: Add project_init recovery output')
  })

  it('makes active todos without an execution explicit', async () => {
    saveActive()
    writeFileSync(join(dir, 'todos.yaml'), `todos:
  - ref: legacy-active
    title: Active todo
    type: chore
    status: active
    difficulty: null
    pr: null
    branch: null
    created: "2026-01-01"
    updated: "2026-01-01"
`)
    const result = await projectInit(repository)
    expect(result).toContain('Active todo')
    expect(result).toContain('No open execution')
  })

  it.each(['idea', 'backlog', 'paused', 'done', 'cancelled'])('does not treat %s as active because it has a linked PR', async status => {
    saveActive()
    writeFileSync(join(dir, 'todos.yaml'), JSON.stringify({ todos: [{
      ref: 'linked', title: 'Linked PR work', type: 'feature', status, pr: 42,
      difficulty: null, branch: null, claimed_items: null, executions: [],
      created: '2026-09-19', updated: '2026-09-19',
    }] }))
    const result = await projectInit(repository)
    expect(result).toContain('_No active todos._')
    expect(result).not.toContain('Linked PR work')
  })

  it('keeps a healthy target init working when another project has invalid Todo data', async () => {
    saveActive()
    const sibling = new RepoConfig(projectDirectory(source))
    sibling.save({
      schema_version: 3,
      repository: source,
      lifecycle: { status: 'active' },
      parent: { status: 'unknown' },
      tracking: { status: 'none' },
    })
    writeFileSync(join(projectDirectory(source), 'todos.yaml'), 'todos:\n  - ref: old\n    title: Legacy state\n    type: chore\n    status: pr_submitted\n', 'utf-8')
    const result = await projectInit(repository)
    expect(result).toContain('# Contribbot Context')
    expect(result).toContain('other/repo')
    expect(result).toContain('Todo data unreadable')
  })

  it('keeps a healthy target init working when another project config is invalid', async () => {
    saveActive()
    const sibling = new RepoConfig(projectDirectory(source))
    sibling.save({
      schema_version: 3,
      repository: source,
      lifecycle: { status: 'active' },
      parent: { status: 'unknown' },
      tracking: { status: 'none' },
    })
    writeFileSync(join(projectDirectory(source), 'config.yaml'), 'schema_version: 2\n', 'utf-8')

    const result = await projectInit(repository)
    expect(result).toContain('# Contribbot Context')
    expect(result).toContain('config_invalid')
  })

  it('still rejects when the current init target has invalid Todo data', async () => {
    saveActive()
    writeFileSync(join(dir, 'todos.yaml'), 'todos:\n  - ref: old\n    title: Legacy state\n    type: chore\n    status: pr_submitted\n', 'utf-8')
    await expect(projectInit(repository)).rejects.toThrow('Unsupported Todo status')
  })
})
