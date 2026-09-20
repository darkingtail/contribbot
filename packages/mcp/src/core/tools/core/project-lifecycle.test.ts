import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { projectArchive, projectRestore, projectStatus } from './project-lifecycle.js'
import { projectList } from './project-list.js'
import { projectInit } from './project-init.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { ghApi } from '../../clients/github.js'
import { repoConfig } from './repo-config-tool.js'

vi.mock('../../clients/github.js', () => ({
  parseRepo: (repo: string) => { const [owner, name] = repo.split('/'); return { owner, name } },
  ghApi: vi.fn().mockResolvedValue({ fork: false }),
  getCurrentUser: vi.fn().mockResolvedValue({ login: 'user' }),
}))
let home: string
let dir: string
beforeEach(() => {
  vi.mocked(ghApi).mockResolvedValue({ fork: false })
  home = mkdtempSync(join(tmpdir(), 'project-lifecycle-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  dir = join(home, '.contribbot', 'owner', 'repo')
  new RepoConfig(dir).save({ role: 'admin', org: null, fork: 'user/fork', upstream: 'up/stream' })
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

describe('project lifecycle', () => {
  it('defaults legacy configs to active without rewriting them', async () => {
    const before = readFileSync(join(dir, 'config.yaml'), 'utf8')
    expect(JSON.parse(await projectStatus('owner/repo')).status).toBe('active')
    expect(projectList()).toContain('owner/repo')
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(before)
  })

  it('archives and restores preserving data, mode, and unknown config fields', async () => {
    const file = join(dir, 'config.yaml')
    writeFileSync(file, readFileSync(file, 'utf8') + 'custom: keep\n')
    const records = ['todos.yaml', 'upstream.yaml', 'knowledge/note/README.md', 'patrol/latest.md']
    for (const record of records) {
      const p = join(dir, record)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, record.endsWith('.yaml') ? '{}\n' : 'retain original bytes')
    }
    const before = records.map(record => readFileSync(join(dir, record)))
    expect(await projectArchive('owner/repo')).toContain('active → archived')
    const archived = parse(readFileSync(file, 'utf8'))
    expect(archived.status).toBe('archived')
    expect(archived.archived_at).toBeTruthy()
    expect(archived.custom).toBe('keep')
    expect(archived.fork).toBe('user/fork')
    expect(archived.upstream).toBe('up/stream')
    expect(projectList()).not.toContain('| owner/repo |')
    expect(projectList('archived')).toContain('| owner/repo | archived |')
    expect(projectList('all')).toContain('| owner/repo | archived |')
    const bytes = readFileSync(file, 'utf8')
    expect(await projectArchive('owner/repo')).toContain('Already **archived**')
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    expect(await projectRestore('owner/repo')).toContain('archived → active')
    expect(projectList()).toContain('| owner/repo | active |')
    expect(projectList('archived')).not.toContain('| owner/repo |')
    expect(new RepoConfig(dir).load()?.archived_at).toBeNull()
    records.forEach((record, i) => expect(readFileSync(join(dir, record))).toEqual(before[i]))
    expect(await projectRestore('owner/repo')).toContain('Already **active**')
  })

  it('resolves a local fork to the same canonical project', async () => {
    await projectArchive('user/fork')
    expect(new RepoConfig(dir).load()?.status).toBe('archived')
    expect(JSON.parse(await projectStatus('user/fork')).repo).toBe('owner/repo')
    expect(existsSync(join(home, '.contribbot', 'user', 'fork'))).toBe(false)
  })

  it('does not create unconfigured projects when archiving or reading status', async () => {
    expect(JSON.parse(await projectStatus('missing/project'))).toMatchObject({ configured: false, status: 'active' })
    await expect(projectArchive('missing/project')).rejects.toThrow('project_init')
    await expect(projectRestore('missing/project')).rejects.toThrow('project_init')
    expect(existsSync(join(home, '.contribbot', 'missing'))).toBe(false)
  })

  it('initialization leaves an archived project archived and suggests restoring', async () => {
    await projectArchive('owner/repo')
    const result = await projectInit('owner/repo')
    expect(result).toContain('does not reactivate')
    expect(result).toContain('project_restore')
    expect(result).not.toContain('patrol owner/repo --no-input')
    expect(new RepoConfig(dir).load()?.status).toBe('archived')
  })

  it('fails closed on an invalid lifecycle value', async () => {
    writeFileSync(join(dir, 'config.yaml'), 'status: archvied\n')
    await expect(projectStatus('owner/repo')).rejects.toThrow('Invalid project status')
    expect(() => projectList()).toThrow('Invalid project status')
  })

  it('offline fork initialization and repo_config do not create an active alias', async () => {
    new RepoConfig(dir).update({ fork: 'offline/fork' })
    await projectArchive('owner/repo')
    vi.mocked(ghApi).mockRejectedValue(new Error('GitHub unavailable'))
    const before = readFileSync(join(dir, 'config.yaml'), 'utf8')
    expect(await projectInit('offline/fork')).toContain('does not reactivate')
    expect(await repoConfig('offline/fork')).toContain('| status | `archived` |')
    expect(existsSync(join(home, '.contribbot', 'offline', 'fork'))).toBe(false)
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(before)
    expect(projectList()).not.toContain('| offline/fork |')
  })
})
