import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectInit } from './project-init.js'
import { repoConfig } from './repo-config-tool.js'
import { RepoConfig } from '../../storage/repo-config.js'

vi.mock('../../clients/github.js', () => ({
  parseRepo: (repo: string) => { const [owner, name] = repo.split('/'); return { owner, name } },
  ghApi: vi.fn().mockResolvedValue({ fork: false, permissions: {} }),
  getCurrentUser: vi.fn().mockResolvedValue({ login: 'user' }),
}))
let home: string
let dir: string
let store: RepoConfig
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'init-upstream-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  dir = join(home, '.contribbot', 'owner', 'repo')
  store = new RepoConfig(dir)
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })
const pending = '<!-- contribbot:upstream-status=pending -->'

describe('upstream confirmation', () => {
  it('new config requires an explicit external upstream decision', async () => {
    const result = await projectInit('owner/repo')
    expect(result).toContain(pending)
    expect(result).toContain('Ask the user')
    expect(result).toContain('repo_config')
    expect(store.load()?.upstream).toBeNull()
    expect(await projectInit('owner/repo')).toContain(pending)
  })

  it('legacy null remains pending without any byte rewrite or data changes', async () => {
    store.save({ role: 'admin', org: null, fork: null, upstream: null })
    const file = join(dir, 'config.yaml')
    writeFileSync(file, readFileSync(file, 'utf8') + 'custom: keep\n')
    const before = readFileSync(file, 'utf8')
    expect(await projectInit('owner/repo')).toContain(pending)
    expect(await repoConfig('owner/repo')).toContain(pending)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(store.load()).not.toHaveProperty('upstream_confirmed')
  })

  it.each(['other/repo', ''])('explicit choice %s persists and stops asking', async (upstream) => {
    const status = upstream ? 'configured' : 'none'
    const update = await repoConfig('owner/repo', upstream)
    expect(update).toContain('<!-- contribbot:upstream-status=' + status + ' -->')
    expect(store.load()).toMatchObject({ upstream: upstream || null, upstream_confirmed: true })
    const result = await projectInit('owner/repo')
    expect(result).toContain('<!-- contribbot:upstream-status=' + status + ' -->')
    expect(result).not.toContain('Ask the user')
  })

  it('legacy nonempty upstream is configured without migration', async () => {
    store.save({ role: 'read', org: null, fork: null, upstream: 'other/repo' })
    const before = readFileSync(join(dir, 'config.yaml'), 'utf8')
    expect(await projectInit('owner/repo')).toContain('<!-- contribbot:upstream-status=configured -->')
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(before)
  })

  it('fork and canonical share confirmation, archived and unknown fields survive', async () => {
    store.save({ role: 'admin', org: 'owner', fork: 'user/fork', upstream: null, status: 'archived', archived_at: '2026-09-16' })
    const file = join(dir, 'config.yaml')
    writeFileSync(file, readFileSync(file, 'utf8') + 'custom: {nested: keep}\n')
    expect(await projectInit('user/fork')).toContain(pending)
    await repoConfig('user/fork', '')
    expect(store.load()).toMatchObject({ upstream: null, upstream_confirmed: true, status: 'archived', archived_at: '2026-09-16', custom: { nested: 'keep' } })
    const result = await projectInit('owner/repo')
    expect(result).toContain('<!-- contribbot:upstream-status=none -->')
    expect(result).toContain('does not reactivate')
    expect(result).not.toContain('patrol owner/repo')
    expect(existsSync(join(home, '.contribbot', 'user', 'fork'))).toBe(false)
  })

  it.each([' ', 'invalid', '../repo', 'owner/repo/extra'])('rejects malformed explicit upstream %s without writes', async (upstream) => {
    await expect(repoConfig('owner/repo', upstream)).rejects.toThrow()
    expect(store.exists()).toBe(false)
  })

  it('renders current execution phase and next for session recovery', async () => {
    store.save({ role: 'admin', org: null, fork: null, upstream: null })
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

    const result = await projectInit('owner/repo')
    expect(result).toContain('## Active Todo Recovery')
    expect(result).toContain('Build Phase 3')
    expect(result).toContain('Phase: `execute`')
    expect(result).toContain('Next: Add project_init recovery output')
  })

  it('makes active todos without an execution explicit', async () => {
    store.save({ role: 'admin', org: null, fork: null, upstream: null })
    writeFileSync(join(dir, 'todos.yaml'), `todos:
  - ref: legacy-active
    title: Legacy active todo
    type: chore
    status: active
    difficulty: null
    pr: null
    branch: null
    created: "2026-01-01"
    updated: "2026-01-01"
`)

    const result = await projectInit('owner/repo')
    expect(result).toContain('Legacy active todo')
    expect(result).toContain('No open execution')
  })

  it.each(['idea', 'backlog', 'paused', 'done', 'cancelled'])('does not treat %s as active because it has a linked PR', async (status) => {
    store.save({ role: 'admin', org: null, fork: null, upstream: null })
    writeFileSync(join(dir, 'todos.yaml'), JSON.stringify({ todos: [{
      ref: 'linked', title: 'Linked PR work', type: 'feature', status, pr: 42,
      difficulty: null, branch: null, claimed_items: null, executions: [],
      created: '2026-09-19', updated: '2026-09-19',
    }] }))

    const result = await projectInit('owner/repo')
    expect(result).toContain('_No active todos._')
    expect(result).not.toContain('Linked PR work')
  })

  it('keeps a healthy target init working when another tracked project has invalid Todo data', async () => {
    store.save({ role: 'admin', org: null, fork: null, upstream: null })
    const sibling = join(home, '.contribbot', 'other', 'broken')
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'config.yaml'), 'role: read\norg: null\nfork: null\nupstream: null\nupstream_confirmed: true\n', 'utf-8')
    writeFileSync(join(sibling, 'todos.yaml'), 'todos:\n  - ref: old\n    title: Legacy state\n    type: chore\n    status: pr_submitted\n', 'utf-8')

    const result = await projectInit('owner/repo')

    expect(result).toContain('# Contribbot Context — owner/repo')
    expect(result).toContain('other/broken')
    expect(result).toContain('unknown / unknown')
  })

  it('still rejects when the current init target has invalid Todo data', async () => {
    store.save({ role: 'admin', org: null, fork: null, upstream: null })
    writeFileSync(join(dir, 'todos.yaml'), 'todos:\n  - ref: old\n    title: Legacy state\n    type: chore\n    status: pr_submitted\n', 'utf-8')

    await expect(projectInit('owner/repo')).rejects.toThrow('Unsupported Todo status')
  })
})
