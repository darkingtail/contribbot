import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KnowledgeProposalStore } from '../../storage/knowledge-proposal-store.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { UpstreamStore } from '../../storage/upstream-store.js'
import { projectDirectory, repositoryDigest, type RepositoryRef } from '../../utils/repository-ref.js'
import { knowledgeApplyUpdate, knowledgeProposeUpdate } from './knowledge-evolution.js'
import { patrolRecord } from './patrol-record.js'
import { upstreamDetail, upstreamList } from './upstream-manage.js'

const project: RepositoryRef = { platform: 'github', instance: 'https://github.com', path: 'owner/repo' }
const source: RepositoryRef = {
  platform: 'gitlab', instance: 'https://code.example.test/git|lab', path: 'team/subgroup/repo',
}
const otherSource: RepositoryRef = { ...source, instance: 'https://code.example.test/gitlab' }
const originalEnvironment = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
let home: string
let configs: Map<RepositoryRef, Buffer>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'repo-table-home-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  configs = new Map()
  for (const repository of [project, source, otherSource]) {
    const directory = projectDirectory(repository)
    new RepoConfig(directory).save({
      schema_version: 3, repository, lifecycle: { status: 'active' },
      parent: { status: 'unknown' }, tracking: { status: 'pending' },
    })
    configs.set(repository, readFileSync(join(directory, 'config.yaml')))
  }
})

afterEach(() => {
  try {
    for (const [repository, before] of configs) {
      expect(readFileSync(join(projectDirectory(repository), 'config.yaml'))).toEqual(before)
    }
  }
  finally {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    const target = resolve(home)
    expect(dirname(target)).toBe(resolve(tmpdir()))
    expect(basename(target)).toMatch(/^repo-table-home-/)
    rmSync(target, { recursive: true, force: true })
  }
})

function tableRow(output: string, prefix: string, columns: number): string {
  const row = output.split('\n').find(line => line.startsWith(prefix))
  expect(row, `Missing table row ${prefix}`).toBeDefined()
  expect([...row!.matchAll(/(?<!\\)\|/g)]).toHaveLength(columns + 1)
  expect(row).not.toContain('\\\\|')
  return row!
}

function expectTable(output: string, headers: string[]): void {
  expect(output).toContain(`| ${headers.join(' | ')} |`)
  for (const row of output.split('\n').filter(line => line.startsWith('|'))) {
    expect([...row.matchAll(/(?<!\\)\|/g)], row).toHaveLength(headers.length + 1)
  }
}

function propose(repository: RepositoryRef = source) {
  return knowledgeProposeUpdate({
    repo: repository, target: 'architecture', action: 'create', source_type: 'manual',
    title: 'Architecture note', rationale: 'Local-only table regression',
    proposed_content: '# Architecture\n\nContent | kept raw.',
  })
}

function seedUpstream(): UpstreamStore {
  const store = new UpstreamStore(projectDirectory(project))
  store.addVersion(source, 'v1', [{ title: 'Pipe instance item', type: 'feature' }])
  store.updateVersionItem(source, 'v1', 0, { pr: 1 })
  return store
}

describe('repository-derived Markdown tables', () => {
  it('escapes the proposal Repo cell once without escaping the stored identity', async () => {
    const output = await propose()
    const row = tableRow(output, '| Repo |', 3)
    expect(row).toContain('gitlab://code.example.test/git\\|lab/team/subgroup/repo')
    expectTable(output, ['Field', 'Value', 'Remark'])
    expect(new KnowledgeProposalStore(projectDirectory(source)).get('kp-1')?.repo)
      .toEqual(source)
  })

  it('escapes the applied Resource cell without changing canonical content', async () => {
    await propose()
    const output = await knowledgeApplyUpdate(source, 'kp-1')
    const row = tableRow(output, '| Resource |', 3)
    expect(row).toContain('gitlab://code.example.test/git\\|lab/team/subgroup/repo')
    expectTable(output, ['Field', 'Value', 'Remark'])
    const content = readFileSync(join(projectDirectory(source), 'knowledge', 'architecture', 'README.md'), 'utf8')
    expect(content).toContain('Content | kept raw.')
    expect(content).not.toContain('Content \\|')
    expect(content).toContain('<!-- contribbot:provenance -->')
  })

  it('escapes the patrol Repo cell without modifying the recorded report or snapshot', async () => {
    const report = '# Patrol\n\nContent | kept raw.'
    const output = await patrolRecord({
      repo: source, run_id: 'run-1', report,
      snapshot_json: JSON.stringify({ repository: source }), analysis_json: '{}', trace_json: '[]',
    })
    const row = tableRow(output, '| Repo |', 3)
    expect(row).toContain('gitlab://code.example.test/git\\|lab/team/subgroup/repo')
    expectTable(output, ['Field', 'Value', 'Remark'])
    const runDirectory = join(projectDirectory(source), 'patrol', 'runs', 'run-1')
    expect(readFileSync(join(runDirectory, 'report.md'), 'utf8')).toBe(report)
    expect(JSON.parse(readFileSync(join(runDirectory, 'snapshot.json'), 'utf8')).repository).toEqual(source)
  })

  it('escapes the version link and retains the source identity and index bytes', async () => {
    const store = seedUpstream()
    const indexPath = join(projectDirectory(project), 'upstream.yaml')
    const before = readFileSync(indexPath)
    const output = await upstreamList(project, source)
    const row = tableRow(output, '| v1', 5)
    expect(row).toContain('| v1 |')
    expect(row).not.toContain('/releases/tag/')
    expectTable(output, ['Version', 'Status', 'Items', 'Progress', 'Remark'])
    expect(store.listRepos()).toEqual([source])
    expect(readFileSync(indexPath)).toEqual(before)
  })

  it('escapes the detail PR link and retains the source identity and index bytes', async () => {
    const store = seedUpstream()
    const indexPath = join(projectDirectory(project), 'upstream.yaml')
    const before = readFileSync(indexPath)
    const output = await upstreamDetail(source, 'v1', project)
    const row = tableRow(output, '| 1 |', 7)
    expect(row).toContain('| #1 |')
    expect(row).not.toContain('/pull/')
    expectTable(output, ['#', 'Title', 'Type', 'Difficulty', 'Status', 'PR', 'Remark'])
    expect(store.listVersions(source)[0]?.items[0]?.pr).toBe(1)
    expect(readFileSync(indexPath)).toEqual(before)
  })

  it('keeps a normal GitHub version and PR link unchanged', async () => {
    const githubSource: RepositoryRef = { ...project, path: 'source/repo' }
    const store = new UpstreamStore(projectDirectory(project))
    store.addVersion(githubSource, 'v1', [{ title: 'Normal item', type: 'feature' }])
    store.updateVersionItem(githubSource, 'v1', 0, { pr: 42 })
    const list = await upstreamList(project, githubSource)
    const detail = await upstreamDetail(githubSource, 'v1', project)
    expect(list).toContain('[v1](https://github.com/source/repo/releases/tag/v1)')
    expect(detail).toContain('[#42](https://github.com/source/repo/pull/42)')
    expectTable(list, ['Version', 'Status', 'Items', 'Progress', 'Remark'])
    expectTable(detail, ['#', 'Title', 'Type', 'Difficulty', 'Status', 'PR', 'Remark'])
  })

  it('keeps same-path sources on different instances separate while formatting their tables', async () => {
    const store = seedUpstream()
    store.addVersion(otherSource, 'v1', [{ title: 'Other instance item', type: 'feature' }])
    store.updateVersionItem(otherSource, 'v1', 0, { pr: 2 })
    expect(repositoryDigest(source)).not.toBe(repositoryDigest(otherSource))
    expect(projectDirectory(source)).not.toBe(projectDirectory(otherSource))
    const first = await upstreamDetail(source, 'v1', project)
    const second = await upstreamDetail(otherSource, 'v1', project)
    expect(first).toContain('Pipe instance item')
    expect(first).not.toContain('Other instance item')
    expect(second).toContain('Other instance item')
    expect(second).not.toContain('Pipe instance item')
    expectTable(first, ['#', 'Title', 'Type', 'Difficulty', 'Status', 'PR', 'Remark'])
    expectTable(second, ['#', 'Title', 'Type', 'Difficulty', 'Status', 'PR', 'Remark'])
    expect(store.listRepos()).toEqual([source, otherSource])
  })
})
