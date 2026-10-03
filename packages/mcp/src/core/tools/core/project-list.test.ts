import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { projectDirectory, repositoryDigest, type RepositoryRef } from '../../utils/repository-ref.js'
import { projectList, projectListResult } from './project-list.js'

const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'project-list-home-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
})

afterEach(() => {
  process.env.HOME = originalHome
  process.env.USERPROFILE = originalUserProfile
  rmSync(home, { recursive: true, force: true })
})

describe('projectList', () => {
  function createProject(path: string, options: {
    instance?: string
    platform?: RepositoryRef['platform']
    archived?: boolean
  } = {}) {
    const repository: RepositoryRef = {
      platform: options.platform ?? 'github',
      instance: options.instance ?? 'https://github.com',
      path,
    }
    const directory = projectDirectory(repository, join(home, '.contribbot'))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'config.yaml'), stringify({
      schema_version: 3,
      repository,
      lifecycle: options.archived
        ? { status: 'archived', archived_at: '2026-09-20T00:00:00Z' }
        : { status: 'active' },
      parent: { status: 'unknown' },
      tracking: { status: 'pending' },
    }))
    return directory
  }

  it('lists v3 projects and ignores legacy and runtime directories', () => {
    createProject('owner/repo')
    const root = join(home, '.contribbot')
    mkdirSync(join(root, 'owner', 'legacy'), { recursive: true })
    writeFileSync(join(root, 'owner', 'legacy', 'config.yaml'), 'schema_version: 2\n')
    mkdirSync(join(root, 'remediation', 'run-1'), { recursive: true })
    writeFileSync(join(root, 'remediation', 'run-1', 'config.yaml'), 'schema_version: 2\n')
    const output = projectList()
    expect(output).toContain('github://github.com/owner/repo')
    expect(output).not.toContain('owner/legacy')
    expect(output).not.toContain('remediation/run-1')
    expect(output).toContain('1 projects tracked')
  })

  it('isolates identical repository paths on different platforms and instances', () => {
    createProject('owner/repo')
    createProject('owner/repo', { platform: 'gitlab', instance: 'https://code.example.com/gitlab' })
    expect(projectList()).toContain('2 projects tracked')
    expect(projectList()).toContain('github://github.com/owner/repo')
    expect(projectList()).toContain('gitlab://code.example.com/gitlab/owner/repo')
    expect(projectListResult().projects).toEqual([
      {
        repository: { platform: 'github', instance: 'https://github.com', path: 'owner/repo' },
        digest: repositoryDigest({ platform: 'github', instance: 'https://github.com', path: 'owner/repo' }),
        status: 'active',
      },
      {
        repository: { platform: 'gitlab', instance: 'https://code.example.com/gitlab', path: 'owner/repo' },
        digest: repositoryDigest({ platform: 'gitlab', instance: 'https://code.example.com/gitlab', path: 'owner/repo' }),
        status: 'active',
      },
    ])
  })

  it('keeps archived projects out of the default structured list', () => {
    createProject('owner/active')
    createProject('owner/archived', { archived: true })
    expect(projectListResult().projects.map(project => project.repository.path)).toEqual(['owner/active'])
    expect(projectListResult('all').projects).toHaveLength(2)
  })

  it('does not treat a knowledge-only directory without config as an initialized project', () => {
    const root = join(home, '.contribbot', 'projects', 'v1')
    mkdirSync(join(root, '0'.repeat(64), 'knowledge'), { recursive: true })
    const result = projectListResult()
    expect(result.projects).toEqual([])
    expect(result.problems).toMatchObject([
      { code: 'config_missing', directory: join(root, '0'.repeat(64)) },
    ])
    expect(projectList()).toContain('config_missing')
  })

  it('rejects a linked projects directory even when the target has no v1 projects', () => {
    const root = join(home, '.contribbot')
    const target = join(home, 'other-projects')
    mkdirSync(root)
    mkdirSync(target)
    symlinkSync(target, join(root, 'projects'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => projectList()).toThrow(/symbolic link/)
  })

  it('rejects a broken projects link instead of reporting no projects', () => {
    const root = join(home, '.contribbot')
    const target = join(home, 'removed-projects')
    mkdirSync(root)
    mkdirSync(target)
    symlinkSync(target, join(root, 'projects'), process.platform === 'win32' ? 'junction' : 'dir')
    rmSync(target, { recursive: true })
    expect(() => projectList()).toThrow(/symbolic link/)
  })

  it('counts paused work as open and excludes cancelled work independently of linked PRs', () => {
    const project = createProject('owner/repo')
    writeFileSync(join(project, 'todos.yaml'), JSON.stringify({ todos:
      ['idea', 'backlog', 'active', 'paused', 'done', 'cancelled'].map(status => ({
        ref: status, title: status, type: 'feature', status, pr: 42,
        difficulty: null, branch: null, claimed_items: null, executions: [],
        created: '2026-09-19', updated: '2026-09-19',
      })),
    }))
    expect(projectList()).toContain('| github://github.com/owner/repo | active | 4 / 1 |')
  })

  it('keeps an invalid Todo project in the active list with an explicit unknown count', () => {
    const project = createProject('owner/broken')
    writeFileSync(join(project, 'todos.yaml'), 'todos:\n  - ref: old\n    title: Legacy state\n    type: chore\n    status: pr_submitted\n')
    const output = projectList()
    expect(output).toContain('| github://github.com/owner/broken | active | unknown / unknown |')
    expect(output).toContain('Todo data unreadable')
    expect(output).not.toContain('No active projects found')
  })

  it('preserves archived status while reporting an invalid Todo file', () => {
    const project = createProject('owner/archived-broken', { archived: true })
    writeFileSync(join(project, 'todos.yaml'), 'todos:\n  - invalid yaml: [\n')
    const output = projectList('archived')
    expect(output).toContain('| github://github.com/owner/archived-broken | archived | unknown / unknown |')
    expect(output).toContain('Archived; data retained, patrol blocked')
    expect(output).toContain('Todo data unreadable')
    expect(projectList('all')).toContain('github://github.com/owner/archived-broken')
    expect(output).not.toContain('invalid yaml')
  })

  it('distinguishes healthy zero Todo counts from unreadable counts', () => {
    const healthy = createProject('owner/healthy')
    const broken = createProject('owner/broken-zero-contrast')
    writeFileSync(join(healthy, 'todos.yaml'), 'todos: []\n')
    writeFileSync(join(broken, 'todos.yaml'), 'todos:\n  - ref: old\n    title: Legacy state\n    type: chore\n    status: pr_submitted\n')
    const output = projectList()
    expect(output).toContain('| github://github.com/owner/healthy | active | 0 / 0 |')
    expect(output).toContain('| github://github.com/owner/broken-zero-contrast | active | unknown / unknown |')
  })

  it('does not change invalid Todo data while listing', () => {
    const project = createProject('owner/unchanged')
    const todos = join(project, 'todos.yaml')
    const content = 'todos:\n  - ref: old\n    title: Legacy state\n    type: chore\n    status: pr_submitted\n'
    writeFileSync(todos, content)
    const beforeEntries = readdirSync(project).sort()
    projectList()
    expect(readdirSync(project).sort()).toEqual(beforeEntries)
    expect(readFileSync(todos, 'utf8')).toBe(content)
  })

  it('rejects damaged or mismatched config instead of silently skipping it', () => {
    const project = createProject('owner/repo')
    writeFileSync(join(project, 'config.yaml'), 'schema_version: 2\n')
    const result = projectListResult()
    expect(result.projects).toEqual([])
    expect(result.problems).toMatchObject([
      { code: 'config_invalid', directory: project },
    ])
    expect(projectList()).toContain('config_invalid')
  })

  it('rejects an orphan directory even when its config is otherwise valid', () => {
    const project = createProject('owner/repo')
    const root = join(home, '.contribbot', 'projects', 'v1')
    const mismatched = join(root, 'a'.repeat(64))
    mkdirSync(mismatched)
    writeFileSync(join(mismatched, 'config.yaml'), readFileSync(join(project, 'config.yaml')))
    const result = projectListResult()
    expect(result.projects).toHaveLength(1)
    expect(result.problems).toMatchObject([
      { code: 'config_invalid', directory: mismatched },
    ])
    expect(projectList()).toContain('identity does not match project directory')
  })

  it('keeps a healthy project visible when a sibling config is damaged', () => {
    createProject('owner/healthy')
    const broken = createProject('owner/broken')
    writeFileSync(join(broken, 'config.yaml'), 'schema_version: 2\n')

    const result = projectListResult()
    expect(result.projects.map(project => project.repository.path)).toEqual(['owner/healthy'])
    expect(result.problems).toMatchObject([
      { code: 'config_invalid', directory: broken },
    ])
  })

  it('reports unreadable upstream data with unknown counts', () => {
    const project = createProject('owner/broken-upstream')
    writeFileSync(join(project, 'upstream.yaml'), 'upstream: [\n')

    const result = projectListResult()
    expect(result.projects).toEqual([expect.objectContaining({
      repository: { platform: 'github', instance: 'https://github.com', path: 'owner/broken-upstream' },
    })])
    expect(projectList()).toContain('| github://github.com/owner/broken-upstream | active | 0 / 0 | unknown / unknown |')
    expect(result.problems).toMatchObject([
      { code: 'upstream_data_unreadable', directory: project },
    ])
  })
})
