import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { countPendingProposals, knowledgeApplyUpdate, knowledgeProposeUpdate, knowledgeProposals } from './knowledge-evolution.js'
import { knowledgeList, knowledgeRead, knowledgeWrite } from './knowledge.js'

const repository: RepositoryRef = {
  platform: 'gitlab',
  instance: 'https://code.example.test/gitlab',
  path: 'team/repo',
}
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'knowledge-project-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

it('does not create an uninitialized project through direct knowledge writes or proposals', async () => {
  await expect(knowledgeWrite('notes', '# Notes', repository)).rejects.toThrow(/not initialized/i)
  await expect(knowledgeProposeUpdate({
    repo: repository,
    target: 'notes',
    action: 'create',
    source_type: 'todo',
    title: 'Notes',
    rationale: 'test',
    proposed_content: '# Notes',
  })).rejects.toThrow(/not initialized/i)
  expect(existsSync(projectDirectory(repository))).toBe(false)
})

it('does not read knowledge from an orphan project directory without v3 config', async () => {
  const directory = join(projectDirectory(repository), 'knowledge', 'notes')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'README.md'), 'Orphan project data')

  await expect(knowledgeRead('notes', repository)).rejects.toThrow(/not initialized/i)
  await expect(knowledgeList(repository)).rejects.toThrow(/not initialized/i)
  await expect(knowledgeProposals(repository)).rejects.toThrow(/not initialized/i)
  await expect(knowledgeApplyUpdate(repository, 'kp-1')).rejects.toThrow(/not initialized/i)
})

it('rejects linked Knowledge directories instead of reading or writing outside the project', async () => {
  new RepoConfig(projectDirectory(repository)).save({
    schema_version: 3, repository, lifecycle: { status: 'active' },
    parent: { status: 'unknown' }, tracking: { status: 'pending' },
  })
  const outside = join(home, 'outside')
  mkdirSync(join(outside, 'notes'), { recursive: true })
  writeFileSync(join(outside, 'notes', 'README.md'), 'Outside knowledge')
  symlinkSync(outside, join(projectDirectory(repository), 'knowledge'), process.platform === 'win32' ? 'junction' : 'dir')

  await expect(knowledgeRead('notes', repository)).rejects.toThrow(/symbolic link/i)
  await expect(knowledgeWrite('notes', 'Changed', repository)).rejects.toThrow(/symbolic link/i)
  await expect(knowledgeList(repository)).rejects.toThrow(/symbolic link/i)
  expect(readFileSync(join(outside, 'notes', 'README.md'), 'utf-8')).toBe('Outside knowledge')
})

it('does not apply a proposal into a linked Knowledge directory', async () => {
  new RepoConfig(projectDirectory(repository)).save({
    schema_version: 3, repository, lifecycle: { status: 'active' },
    parent: { status: 'unknown' }, tracking: { status: 'pending' },
  })
  await knowledgeProposeUpdate({
    repo: repository, target: 'notes', action: 'create', source_type: 'todo',
    title: 'Notes', rationale: 'test', proposed_content: '# Notes',
  })
  const outside = join(home, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(projectDirectory(repository), 'knowledge'), process.platform === 'win32' ? 'junction' : 'dir')

  await expect(knowledgeApplyUpdate(repository, 'kp-1')).rejects.toThrow(/symbolic link/i)
  expect(existsSync(join(outside, 'notes', 'README.md'))).toBe(false)
  expect(await knowledgeProposals(repository, 'pending')).toContain('kp-1')
})

it('does not treat a broken Knowledge link as an empty directory', async () => {
  new RepoConfig(projectDirectory(repository)).save({
    schema_version: 3, repository, lifecycle: { status: 'active' },
    parent: { status: 'unknown' }, tracking: { status: 'pending' },
  })
  symlinkSync(join(home, 'absent'), join(projectDirectory(repository), 'knowledge'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(knowledgeList(repository)).rejects.toThrow(/symbolic link/i)
})

it('does not hide a linked proposal file as zero pending proposals', () => {
  new RepoConfig(projectDirectory(repository)).save({
    schema_version: 3, repository, lifecycle: { status: 'active' },
    parent: { status: 'unknown' }, tracking: { status: 'pending' },
  })
  const outside = join(home, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(projectDirectory(repository), 'knowledge.proposals.yaml'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => countPendingProposals(repository)).toThrow(/symbolic link/i)
})
