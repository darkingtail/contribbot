import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
})
