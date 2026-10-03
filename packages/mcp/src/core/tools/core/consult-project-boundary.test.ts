import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { digest } from '../../consult/contracts.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'
import {
  consultControl, consultDecide, consultPrepare, consultPurgeRaw, consultRead,
  consultRequest, consultStart, consultStatus,
} from './consult.js'

const repository: RepositoryRef = {
  platform: 'gitlab', instance: 'https://code.example.invalid/gitlab', path: 'team/consult',
}
const binding = {
  runtime: 'claude' as const, executable: process.execPath, executable_digest: digest('fixture'),
  runtime_version: 'fixture', binding_version: '1' as const, model: null,
  protocol: 'native-oneshot' as const, transport: 'pipe' as const,
  execution_location: 'local' as const, model_location: 'unknown' as const,
  write_boundary: 'tool_free' as const, read_boundary: 'tools_disabled' as const,
  disclosure: 'Synthetic test; no Provider is invoked.', disclosure_digest: digest('Synthetic test; no Provider is invoked.'),
}
let home: string
const decision = {
  source: 'fixture:user', statement: 'Authorize only this synthetic reservation, with no Provider execution.',
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'consult-project-boundary-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  const name = relative(tmpdir(), home)
  if (!name.startsWith('consult-project-boundary-') || name.includes(sep)) {
    throw new Error('Unexpected test directory; refusing cleanup.')
  }
  rmSync(home, { recursive: true, force: true })
})

function initialize() {
  new RepoConfig(projectDirectory(repository)).save({
    schema_version: 3, repository, lifecycle: { status: 'active' },
    parent: { status: 'unknown' }, tracking: { status: 'pending' },
  })
}

function input() {
  return {
    repo: repository, request_id: 'boundary-request', binding,
    packet: { workspace: home, question: 'Check a synthetic design.' },
  }
}

async function reserve() {
  const raw = input()
  const prepared = await consultPrepare(raw)
  return consultRequest({
    ...raw, confirmed_preview: prepared.preview.digest,
    authorization: { explicit_once: decision },
  })
}

it('keeps independent consultation available in an initialized project without requiring a Todo', async () => {
  initialize()
  const receipt = await reserve()
  const directory = projectDirectory(repository)
  expect(receipt.status).toBe('pending')
  expect((await consultStatus({ repo: repository })).discussions).toHaveLength(1)
  expect(existsSync(join(directory, 'todos.yaml'))).toBe(false)
})

it('refuses a Consult reservation in an uninitialized project without creating project data', async () => {
  await expect(reserve()).rejects.toThrow(/not initialized/i)
  expect(existsSync(projectDirectory(repository))).toBe(false)
})

it('refuses to read Consult data when the project config is no longer valid v3', async () => {
  initialize()
  await reserve()
  const directory = projectDirectory(repository)
  const discussions = join(directory, 'consult', 'discussions.yaml')
  const before = readFileSync(discussions, 'utf8')
  writeFileSync(join(directory, 'config.yaml'), 'schema_version: 2\n')

  await expect(consultStatus({ repo: repository })).rejects.toThrow(/schema v3/i)
  expect(readFileSync(discussions, 'utf8')).toBe(before)
})

it('refuses to read Consult data when config identity disagrees with its project directory', async () => {
  initialize()
  await reserve()
  const file = join(projectDirectory(repository), 'config.yaml')
  writeFileSync(file, readFileSync(file, 'utf8').replace('team/consult', 'other/consult'))

  await expect(consultStatus({ repo: repository })).rejects.toThrow(/identity does not match/i)
})

const routes = [
  { name: 'prepare', run: () => consultPrepare(input()) },
  { name: 'request', run: () => consultRequest({
    ...input(), confirmed_preview: digest('unconfirmed'), authorization: { explicit_once: decision },
  }) },
  { name: 'status', run: () => consultStatus({ repo: repository }) },
  { name: 'read', run: () => consultRead({ repo: repository }) },
  { name: 'control', run: () => consultControl({
    repo: repository, command: { action: 'revoke', grant_id: 'fixture-grant', decision },
  }) },
  { name: 'decide', run: () => consultDecide({
    repo: repository, discussion_id: 'fixture-discussion', expected_revision: 1,
    command: { action: 'decision', id: 'fixture-decision', decision, outcome: 'defer', note: 'Fixture only.' },
  }) },
  { name: 'purge', run: () => consultPurgeRaw({ repo: repository, discussion_id: 'fixture-discussion' }) },
]

it.each(routes)('$name rejects invalid project config before changing Consult data', async ({ run }) => {
  initialize()
  await reserve()
  const directory = projectDirectory(repository)
  const discussionFile = join(directory, 'consult', 'discussions.yaml')
  const before = readFileSync(discussionFile)
  const beforeEntries = readdirSync(join(directory, 'consult')).sort()
  writeFileSync(join(directory, 'config.yaml'), 'schema_version: 2\n')

  await expect(run()).rejects.toThrow(/schema v3/i)
  expect(readFileSync(discussionFile)).toEqual(before)
  expect(readdirSync(join(directory, 'consult')).sort()).toEqual(beforeEntries)
  expect(existsSync(join(directory, '.todo.lock'))).toBe(false)
})

it.each(routes)('$name does not create an uninitialized project', async ({ run }) => {
  await expect(run()).rejects.toThrow(/not initialized/i)
  expect(existsSync(projectDirectory(repository))).toBe(false)
  expect(existsSync(join(home, '.contribbot'))).toBe(false)
})

it('rejects an ancestor project-directory link without writing through it', async () => {
  mkdirSync(join(home, '.contribbot'))
  const outside = join(home, 'outside-projects')
  mkdirSync(outside)
  symlinkSync(outside, join(home, '.contribbot', 'projects'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(consultPrepare(input())).rejects.toThrow(/symbolic link/i)
  expect(readdirSync(outside)).toEqual([])
})

it('keeps the retired consult_start explanation read-only without initializing a project', async () => {
  const result = await consultStart({
    repo: repository, request_id: 'legacy-explanation', advisor: { runtime: 'claude', executable: process.execPath },
    packet: { workspace: home, question: 'Show the replacement entry point.' },
  })
  expect(result.unsupported).toBe(true)
  expect(existsSync(join(home, '.contribbot'))).toBe(false)
})
