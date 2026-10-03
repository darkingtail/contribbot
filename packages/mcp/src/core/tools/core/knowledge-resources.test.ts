import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { projectDirectory, repositoryDigest, type RepositoryRef } from '../../utils/repository-ref.js'
import { createServer } from '../../../mcp/server.js'
import { listAllKnowledge, readKnowledge } from './knowledge-resources.js'

const github: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'team/ui' }
const gitlab: RepositoryRef = { platform: 'gitlab', instance: 'https://gitlab.com', path: 'team/ui' }
const privateGitlab: RepositoryRef = { platform: 'gitlab', instance: 'https://code.example.test/gitlab', path: 'team/ui' }
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'knowledge-resource-v3-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

function addKnowledge(repository: RepositoryRef, content: string): void {
  const dir = projectDirectory(repository)
  new RepoConfig(dir).save({
    schema_version: 3, repository, lifecycle: { status: 'active' },
    parent: { status: 'unknown' }, tracking: { status: 'pending' },
  })
  const knowledgeDir = join(dir, 'knowledge', 'notes')
  mkdirSync(knowledgeDir, { recursive: true })
  writeFileSync(join(knowledgeDir, 'README.md'), content)
}

it('lists same-named projects on different platforms and instances without mixing their knowledge', () => {
  addKnowledge(github, '# GitHub notes')
  addKnowledge(gitlab, '# GitLab notes')
  addKnowledge(privateGitlab, '# Private notes')

  const entries = listAllKnowledge()
  expect(entries).toHaveLength(3)
  expect(entries.map(entry => entry.digest)).toEqual(expect.arrayContaining([
    repositoryDigest(github), repositoryDigest(gitlab), repositoryDigest(privateGitlab),
  ]))
  for (const [repository, content] of [
    [github, '# GitHub notes'], [gitlab, '# GitLab notes'], [privateGitlab, '# Private notes'],
  ] as const) {
    const entry = entries.find(item => item.digest === repositoryDigest(repository))
    expect(entry?.repo).toContain(repository.instance.replace('https://', ''))
    expect(readKnowledge(repositoryDigest(repository), 'notes')).toBe(content)
  }
})

it('does not expose legacy or orphan directories as v3 resources', () => {
  const legacy = join(home, '.contribbot', 'team', 'ui', 'knowledge', 'notes')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'README.md'), 'Legacy')
  expect(listAllKnowledge()).toEqual([])

  const orphan = join(projectDirectory(github), 'knowledge', 'notes')
  mkdirSync(orphan, { recursive: true })
  writeFileSync(join(orphan, 'README.md'), 'Orphan')
  expect(() => listAllKnowledge()).toThrow(/config/i)
  expect(() => readKnowledge(repositoryDigest(github), 'notes')).toThrow(/config/i)
})

it('rejects a project whose config identifies a different repository than its directory', () => {
  addKnowledge(github, '# GitHub notes')
  const gitlabDir = projectDirectory(gitlab)
  mkdirSync(join(gitlabDir, 'knowledge', 'notes'), { recursive: true })
  writeFileSync(join(gitlabDir, 'config.yaml'), [
    'schema_version: 3',
    'repository:',
    '  platform: github',
    '  instance: https://github.com',
    '  path: team/ui',
    'lifecycle:',
    '  status: active',
    'parent:',
    '  status: unknown',
    'tracking:',
    '  status: pending',
    '',
  ].join('\n'))
  writeFileSync(join(gitlabDir, 'knowledge', 'notes', 'README.md'), 'Forged')

  expect(() => listAllKnowledge()).toThrow(/identity does not match/i)
  expect(() => readKnowledge(repositoryDigest(gitlab), 'notes')).toThrow(/identity does not match/i)
  expect(readKnowledge(repositoryDigest(github), 'notes')).toBe('# GitHub notes')
})

it('rejects invalid digest, path traversal, and linked knowledge directories', () => {
  addKnowledge(github, '# Inside')
  const digest = repositoryDigest(github)
  expect(() => readKnowledge('../team', 'notes')).toThrow(/digest/i)
  expect(() => readKnowledge(digest, '../notes')).toThrow(/path segment/i)
  const external = join(home, 'outside')
  mkdirSync(join(external, 'notes'), { recursive: true })
  writeFileSync(join(external, 'notes', 'README.md'), 'Outside')
  const knowledgeDir = join(projectDirectory(github), 'knowledge')
  rmSync(knowledgeDir, { recursive: true })
  symlinkSync(external, knowledgeDir, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => listAllKnowledge()).toThrow(/symbolic link/i)
  expect(() => readKnowledge(digest, 'notes')).toThrow(/symbolic link/i)
  expect(existsSync(join(external, 'notes', 'README.md'))).toBe(true)
})

it('lists and reads the v3 URI through an MCP client', async () => {
  addKnowledge(privateGitlab, '# Private notes')
  const server = createServer()
  const client = new Client({ name: 'knowledge-resource-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
    const uri = `knowledge://project/${repositoryDigest(privateGitlab)}/notes`
    const { resources } = await client.listResources()
    expect(resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri, name: expect.stringContaining('code.example.test/gitlab/team/ui') }),
    ]))
    const result = await client.readResource({ uri })
    expect(result.contents).toEqual([expect.objectContaining({ uri, text: '# Private notes' })])
  }
  finally {
    await client.close()
    await server.close()
  }
})
