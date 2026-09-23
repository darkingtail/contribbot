import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectList } from './project-list.js'

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
  function writeConfig(owner: string, repo: string, extra = '') {
    const project = join(home, '.contribbot', owner, repo)
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'config.yaml'), `role: read\norg: null\nfork: null\nupstream: null\nupstream_confirmed: true\n${extra}`, 'utf-8')
    return project
  }

  it('lists tracked repositories and ignores agent runtime directories', () => {
    const root = join(home, '.contribbot')
    const project = join(root, 'owner', 'repo')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'config.yaml'), 'fork: null\nupstream: null\n', 'utf-8')

    mkdirSync(join(root, 'remediation', 'run-1'), { recursive: true })
    writeFileSync(join(root, 'remediation', 'run-1', 'result.json'), '{}', 'utf-8')
    writeFileSync(join(root, 'remediation', 'run-1', 'config.yaml'), 'fork: null\nupstream: null\n', 'utf-8')
    mkdirSync(join(root, 'worktrees', 'repo'), { recursive: true })
    writeFileSync(join(root, 'worktrees', 'repo', 'README.md'), '# fixture', 'utf-8')
    writeFileSync(join(root, 'worktrees', 'repo', 'config.yaml'), 'fork: null\nupstream: null\n', 'utf-8')

    const output = projectList()

    expect(output).toContain('owner/repo')
    expect(output).not.toContain('remediation/run-1')
    expect(output).not.toContain('worktrees/repo')
    expect(output).toContain('1 projects tracked')
  })

  it('recognizes a knowledge-only tracked repository', () => {
    mkdirSync(join(home, '.contribbot', 'owner', 'knowledge-repo', 'knowledge'), { recursive: true })
    expect(projectList()).toContain('owner/knowledge-repo')
  })

  it('counts paused work as open and excludes cancelled work independently of linked PRs', () => {
    const project = join(home, '.contribbot', 'owner', 'repo')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'todos.yaml'), JSON.stringify({ todos:
      ['idea', 'backlog', 'active', 'paused', 'done', 'cancelled'].map(status => ({
        ref: status, title: status, type: 'feature', status, pr: 42,
        difficulty: null, branch: null, claimed_items: null, executions: [],
        created: '2026-09-19', updated: '2026-09-19',
      })),
    }))

    expect(projectList()).toContain('| owner/repo | active | 4 / 1 |')
  })

  it('keeps an invalid Todo project in the active list with an explicit unknown count', () => {
    const project = writeConfig('owner', 'broken')
    writeFileSync(join(project, 'todos.yaml'), 'todos:\n  - ref: old\n    title: Legacy state\n    type: chore\n    status: pr_submitted\n', 'utf-8')

    const output = projectList()

    expect(output).toContain('| owner/broken | active | unknown / unknown |')
    expect(output).toContain('Todo data unreadable')
    expect(output).not.toContain('No active projects found')
  })

  it('preserves archived status and note while reporting an invalid Todo file', () => {
    const project = writeConfig('owner', 'archived-broken', 'status: archived\narchived_at: "2026-09-20"\n')
    writeFileSync(join(project, 'todos.yaml'), 'todos:\n  - invalid yaml: [\n', 'utf-8')

    const output = projectList('archived')

    expect(output).toContain('| owner/archived-broken | archived | unknown / unknown |')
    expect(output).toContain('Archived; data retained, patrol blocked')
    expect(output).toContain('Todo data unreadable')
    expect(output).not.toContain('No archived projects found')
    expect(projectList('all')).toContain('| owner/archived-broken | archived | unknown / unknown |')
    expect(output).not.toContain('invalid yaml')
    expect(output).not.toContain('YAMLParseError')
    expect(output.split('\n').filter(line => line.startsWith('| owner/archived-broken |'))).toHaveLength(1)
  })

  it('distinguishes healthy zero Todo counts from unreadable counts', () => {
    const healthy = writeConfig('owner', 'healthy')
    const broken = writeConfig('owner', 'broken-zero-contrast')
    writeFileSync(join(healthy, 'todos.yaml'), 'todos: []\n', 'utf-8')
    writeFileSync(join(broken, 'todos.yaml'), 'todos:\n  - ref: old\n    title: Legacy state\n    type: chore\n    status: pr_submitted\n', 'utf-8')

    const output = projectList()

    expect(output).toContain('| owner/healthy | active | 0 / 0 |')
    expect(output).toContain('| owner/broken-zero-contrast | active | unknown / unknown |')
  })

  it('does not change an invalid project directory while listing it', () => {
    const project = writeConfig('owner', 'unchanged')
    const todos = join(project, 'todos.yaml')
    const content = 'todos:\n  - ref: old\n    title: Legacy state\n    type: chore\n    status: pr_submitted\n'
    writeFileSync(todos, content, 'utf-8')
    const beforeEntries = readdirSync(project).sort()
    const beforeContent = readFileSync(todos, 'utf-8')

    projectList()

    expect(readdirSync(project).sort()).toEqual(beforeEntries)
    expect(readFileSync(todos, 'utf-8')).toBe(beforeContent)
    expect(readFileSync(todos, 'utf-8')).toBe(content)
  })
})
