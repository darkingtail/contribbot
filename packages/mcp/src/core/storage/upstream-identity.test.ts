import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { repositoryDigest, type RepositoryRef } from '../utils/repository-ref.js'
import { UpstreamStore } from './upstream-store.js'

const first: RepositoryRef = { platform: 'gitlab', instance: 'https://first.example.com/gitlab', path: 'team/sub/ui' }
const second: RepositoryRef = { ...first, instance: 'https://second.example.com:8443/gitlab' }
let directory: string
let store: UpstreamStore

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'upstream-identity-'))
  store = new UpstreamStore(directory)
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('isolates versions, identical commit SHAs, updates and archives by complete source identity', () => {
  for (const [repository, title] of [[first, 'first'], [second, 'second']] as const) {
    store.addVersion(repository, 'v1', [{ title, type: 'feature' }])
    store.addDailyCommits(repository, [{ sha: 'abc123', message: title, type: 'feat', date: '2026-10-02' }])
  }
  expect(store.listRepos()).toEqual([first, second])
  store.updateVersionItem(first, 'v1', 0, { status: 'done' })
  store.updateDailyCommit(first, 'abc123', { action: 'skip' })
  expect(store.compactDaily(first, { keep: 0 })).toEqual({ removed: 1, remaining: 0 })
  expect(store.listVersions(first)[0]?.status).toBe('done')
  expect(store.listVersions(second)[0]?.status).toBe('active')
  expect(store.getDaily(second).commits[0]).toMatchObject({ message: 'second', action: null })
  expect(store.listArchived(first)[0]?.message).toBe('first')
  expect(store.listArchived(second)).toEqual([])
  const persisted = parse(readFileSync(join(directory, 'upstream.yaml'), 'utf8'))
  expect(persisted.sources[repositoryDigest(first)].repository).toEqual(first)
  expect(persisted.sources[repositoryDigest(second)].repository).toEqual(second)
})

it.each(['upstream.yaml', 'upstream.archive.yaml'])('rejects legacy or mismatched identities in %s without overwriting data', file => {
  const path = join(directory, file)
  const legacy = 'team/ui:\n  versions: []\n'
  writeFileSync(path, legacy)
  const read = () => file === 'upstream.yaml' ? store.listRepos() : store.listArchived(first)
  expect(read).toThrow(/format|schema|identity/i)
  expect(readFileSync(path, 'utf8')).toBe(legacy)
  const value = file === 'upstream.yaml'
    ? { repository: second, versions: [], daily: { last_checked: null, commits: [] } }
    : { repository: second, commits: [] }
  const mismatched = stringify({ schema_version: 1, sources: { [repositoryDigest(first)]: value } })
  writeFileSync(path, mismatched)
  expect(read).toThrow(/identity.*key/i)
  expect(readFileSync(path, 'utf8')).toBe(mismatched)
})

it('rejects a shorthand even when no stored data exists', () => {
  expect(() => store.getDaily('team/ui' as unknown as RepositoryRef)).toThrow()
})

it('includes platform and installation prefix in source identity, not only host and path', () => {
  const sources: RepositoryRef[] = [
    { platform: 'gitlab', instance: 'https://code.example.com', path: 'team/ui' },
    { platform: 'github', instance: 'https://code.example.com', path: 'team/ui' },
    { platform: 'gitlab', instance: 'https://code.example.com/gitlab', path: 'team/ui' },
  ]
  for (const repository of sources) {
    store.addVersion(repository, 'v1', [{ title: repositoryDigest(repository), type: 'feature' }])
  }
  expect(store.listRepos()).toEqual(sources)
  for (const repository of sources) {
    expect(store.listVersions(repository)[0]?.items[0]?.title).toBe(repositoryDigest(repository))
  }
})

it.each(['legacy', 'mismatched'])('preserves active commits when the archive has a %s identity', kind => {
  store.addDailyCommits(first, [{ sha: 'abc123', message: 'first', type: 'feat', date: '2026-10-02' }])
  store.updateDailyCommit(first, 'abc123', { action: 'skip' })
  const activePath = join(directory, 'upstream.yaml')
  const archivePath = join(directory, 'upstream.archive.yaml')
  const activeBefore = readFileSync(activePath, 'utf8')
  const archiveBefore = kind === 'legacy'
    ? 'team/ui:\n  commits: []\n'
    : stringify({ schema_version: 1, sources: { [repositoryDigest(first)]: { repository: second, commits: [] } } })
  writeFileSync(archivePath, archiveBefore)

  expect(() => store.compactDaily(first, { keep: 0 })).toThrow(/format|identity/i)
  expect(readFileSync(activePath, 'utf8')).toBe(activeBefore)
  expect(readFileSync(archivePath, 'utf8')).toBe(archiveBefore)
})

it('rejects a mismatched active identity before writing either index', () => {
  const activePath = join(directory, 'upstream.yaml')
  const before = stringify({
    schema_version: 1,
    sources: { [repositoryDigest(first)]: { repository: second, versions: [], daily: { last_checked: null, commits: [] } } },
  })
  writeFileSync(activePath, before)
  expect(() => store.addVersion(first, 'v2', [])).toThrow(/identity.*key/i)
  expect(() => store.addDailyCommits(first, [])).toThrow(/identity.*key/i)
  expect(() => store.compactDaily(first, { keep: 0 })).toThrow(/identity.*key/i)
  expect(readFileSync(activePath, 'utf8')).toBe(before)
})

it('does not duplicate an archived commit after the active-index write fails and is retried', () => {
  store.addDailyCommits(first, [{ sha: 'abc123', message: 'first', type: 'feat', date: '2026-10-02' }])
  store.updateDailyCommit(first, 'abc123', { action: 'skip' })
  const blockedWrite = join(directory, 'upstream.yaml.tmp')
  mkdirSync(blockedWrite)
  expect(() => store.compactDaily(first, { keep: 0 })).toThrow()
  expect(store.getDaily(first).commits).toHaveLength(1)
  expect(store.listArchived(first)).toHaveLength(1)
  rmSync(blockedWrite, { recursive: true })

  expect(store.compactDaily(first, { keep: 0 })).toEqual({ removed: 1, remaining: 0 })
  expect(store.getDaily(first).commits).toEqual([])
  expect(store.listArchived(first)).toHaveLength(1)
})

it('refuses to replace an archived SHA with conflicting content', () => {
  store.addDailyCommits(first, [{ sha: 'abc123', message: 'original', type: 'feat', date: '2026-10-02' }])
  store.updateDailyCommit(first, 'abc123', { action: 'skip' })
  store.compactDaily(first, { keep: 0 })
  store.addDailyCommits(first, [{ sha: 'abc123', message: 'changed', type: 'fix', date: '2026-10-02' }])
  store.updateDailyCommit(first, 'abc123', { action: 'todo', ref: '#42' })
  const archivePath = join(directory, 'upstream.archive.yaml')
  const originalArchive = readFileSync(archivePath, 'utf8')

  expect(() => store.compactDaily(first, { keep: 0 }))
    .toThrow(`Conflicting archived commit abc123 for ${JSON.stringify(first)}.`)
  expect(readFileSync(archivePath, 'utf8')).toBe(originalArchive)
  expect(store.getDaily(first).commits[0]).toMatchObject({ message: 'changed', action: 'todo' })
})
