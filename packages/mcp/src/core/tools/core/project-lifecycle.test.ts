import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectArchive, projectRestore, projectStatus } from './project-lifecycle.js'
import { projectList } from './project-list.js'
import { projectInit } from './project-init.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { repoConfig } from './repo-config-tool.js'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'

vi.mock('../../clients/github.js', () => ({
  ghApi: vi.fn().mockResolvedValue({ full_name: 'owner/repo', fork: false }),
}))

const repository: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'owner/repo' }
const fork: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'user/fork' }
const source: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'up/stream' }
let home: string
let dir: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'project-lifecycle-v3-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  dir = projectDirectory(repository)
  new RepoConfig(dir).save({
    schema_version: 3,
    repository,
    lifecycle: { status: 'active' },
    parent: { status: 'unknown' },
    tracking: { status: 'configured', sources: [source] },
  })
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

describe('project lifecycle', () => {
  it('reports active status without rewriting schema v3 config', async () => {
    const before = readFileSync(join(dir, 'config.yaml'), 'utf8')
    expect(JSON.parse(await projectStatus(repository)).status).toBe('active')
    expect(projectList()).toContain('owner/repo')
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(before)
  })

  it('archives and restores preserving data and repository relationships', async () => {
    const records = ['todos.yaml', 'upstream.yaml', 'knowledge/note/README.md', 'patrol/latest.md']
    for (const record of records) {
      const p = join(dir, record)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, record.endsWith('.yaml') ? '{}\n' : 'retain original bytes')
    }
    const before = records.map(record => readFileSync(join(dir, record)))
    expect(await projectArchive(repository)).toContain('active → archived')
    const archived = new RepoConfig(dir).load()!
    expect(archived.lifecycle.status).toBe('archived')
    expect(archived.lifecycle.archived_at).toBeTruthy()
    expect(archived.parent).toEqual({ status: 'unknown' })
    expect(archived.tracking).toEqual({ status: 'configured', sources: [source] })
    expect(projectList()).not.toContain('| github://github.com/owner/repo |')
    expect(projectList('archived')).toContain('| github://github.com/owner/repo | archived |')
    expect(projectList('all')).toContain('| github://github.com/owner/repo | archived |')
    const bytes = readFileSync(join(dir, 'config.yaml'), 'utf8')
    expect(await projectArchive(repository)).toContain('Already **archived**')
    expect(readFileSync(join(dir, 'config.yaml'), 'utf8')).toBe(bytes)
    expect(await projectRestore(repository)).toContain('archived → active')
    expect(projectList()).toContain('| github://github.com/owner/repo | active |')
    expect(projectList('archived')).not.toContain('| github://github.com/owner/repo |')
    expect(new RepoConfig(dir).load()?.lifecycle).toEqual({ status: 'active' })
    records.forEach((record, i) => expect(readFileSync(join(dir, record))).toEqual(before[i]))
    expect(await projectRestore(repository)).toContain('Already **active**')
  })

  it('never redirects a fork to the parent project', async () => {
    const forkDir = projectDirectory(fork)
    new RepoConfig(forkDir).save({
      schema_version: 3,
      repository: fork,
      lifecycle: { status: 'active' },
      parent: { status: 'confirmed', repository, relation_verified_at: '2026-09-16T00:00:00.000Z' },
      tracking: { status: 'pending' },
    })
    await projectArchive(fork)
    expect(new RepoConfig(forkDir).load()?.lifecycle.status).toBe('archived')
    expect(new RepoConfig(dir).load()?.lifecycle.status).toBe('active')
    expect(JSON.parse(await projectStatus(fork)).repo).toContain('user/fork')
    expect(existsSync(forkDir)).toBe(true)
  })

  it('does not create unconfigured projects when archiving or reading status', async () => {
    const missing: RepositoryRef = { ...repository, path: 'missing/project' }
    expect(JSON.parse(await projectStatus(missing))).toMatchObject({ configured: false, status: 'not_initialized' })
    await expect(projectArchive(missing)).rejects.toThrow('project_init')
    await expect(projectRestore(missing)).rejects.toThrow('project_init')
    expect(existsSync(projectDirectory(missing))).toBe(false)
  })

  it('initialization leaves an archived project archived and suggests restoring', async () => {
    await projectArchive(repository)
    const result = await projectInit(repository)
    expect(result).toContain('does not reactivate')
    expect(result).toContain('project_restore')
    expect(new RepoConfig(dir).load()?.lifecycle.status).toBe('archived')
  })

  it('fails closed on an invalid lifecycle value', async () => {
    writeFileSync(join(dir, 'config.yaml'), `schema_version: 3
repository:
  platform: github
  instance: https://github.com
  path: owner/repo
lifecycle:
  status: archvied
parent:
  status: unknown
tracking:
  status: pending
`)
    await expect(projectStatus(repository)).rejects.toThrow('schema v3')
    expect(projectList()).toContain('config_invalid')
  })

  it('offline initialization and repo_config retain a fork in its own directory', async () => {
    const forkDir = projectDirectory(fork)
    new RepoConfig(forkDir).save({
      schema_version: 3,
      repository: fork,
      lifecycle: { status: 'archived', archived_at: '2026-09-16T00:00:00.000Z' },
      parent: { status: 'confirmed', repository, relation_verified_at: '2026-09-16T00:00:00.000Z' },
      tracking: { status: 'pending' },
    })
    const before = readFileSync(join(forkDir, 'config.yaml'), 'utf8')
    expect(await projectInit(fork)).toContain('does not reactivate')
    expect(await repoConfig(fork)).toContain('| lifecycle.status | archived |')
    expect(readFileSync(join(forkDir, 'config.yaml'), 'utf8')).toBe(before)
    expect(new RepoConfig(dir).load()?.lifecycle.status).toBe('active')
    expect(projectList()).not.toContain('| github://github.com/user/fork |')
  })
})
