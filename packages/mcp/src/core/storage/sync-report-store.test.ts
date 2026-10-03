import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { repositoryDigest, type RepositoryRef } from '../utils/repository-ref.js'
import { SyncReportStore } from './sync-report-store.js'

const first: RepositoryRef = { platform: 'gitlab', instance: 'https://one.example.com/gitlab', path: 'team/ui' }
const second: RepositoryRef = { ...first, instance: 'https://two.example.com/gitlab' }
let directory: string
let store: SyncReportStore

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sync-report-'))
  store = new SyncReportStore(directory)
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('isolates same-path sources and same-version target branches, including unsafe tag text', () => {
  const version = '../v1|release'
  const firstPath = store.save(first, version, null, '**Total**: 3 | ❌ Not synced: 1')
  const secondPath = store.save(second, version, null, '**Total**: 2 | ❌ Not synced: 0')
  const branchPath = store.save(first, version, 'feature/ui', '**Total**: 1 | ❌ Not synced: 1')

  expect(new Set([firstPath, secondPath, branchPath]).size).toBe(3)
  expect(firstPath).toContain(repositoryDigest(first))
  expect(secondPath).toContain(repositoryDigest(second))
  expect(firstPath).not.toContain('v1|release')
  expect(store.list().legacyCount).toBe(0)
  expect(store.list().reports).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: first, version, targetBranch: null, content: '**Total**: 3 | ❌ Not synced: 1' }),
    expect.objectContaining({ source: second, version, targetBranch: null, content: '**Total**: 2 | ❌ Not synced: 0' }),
    expect.objectContaining({ source: first, version, targetBranch: 'feature/ui', content: '**Total**: 1 | ❌ Not synced: 1' }),
  ]))
  expect(store.save(first, version, null, 'updated')).toBe(firstPath)
  expect(store.list().reports.find(report => report.path === firstPath)?.content).toBe('updated')
  expect(store.list().reports).toHaveLength(3)
})

it('preserves legacy root reports without reading or overwriting them', () => {
  const legacy = join(directory, 'sync', 'v1.md')
  mkdirSync(join(directory, 'sync'))
  writeFileSync(legacy, '**Total**: 99')

  expect(store.list()).toEqual({ reports: [], legacyCount: 1 })
  store.save(first, 'v1', null, '**Total**: 1')
  expect(readFileSync(legacy, 'utf8')).toBe('**Total**: 99')
  expect(store.list().legacyCount).toBe(1)
})

it('rejects altered identity metadata or filenames without rewriting data', () => {
  const path = store.save(first, 'v1', null, '**Total**: 1')
  const original = readFileSync(path, 'utf8')
  const changed = original.replace(first.instance, second.instance)
  writeFileSync(path, changed)

  expect(() => store.list()).toThrow(/identity|key|mismatch/i)
  expect(() => store.save(first, 'v1', null, '**Total**: 2')).toThrow(/identity|key|mismatch/i)
  expect(readFileSync(path, 'utf8')).toBe(changed)
})

it('rejects malformed metadata and a linked source directory', () => {
  const path = store.save(first, 'v1', null, '**Total**: 1')
  writeFileSync(path, 'not frontmatter')
  expect(() => store.list()).toThrow(/report|frontmatter/i)
  expect(readFileSync(path, 'utf8')).toBe('not frontmatter')

  const other = new SyncReportStore(join(directory, 'other'))
  mkdirSync(join(directory, 'other', 'sync', 'releases', 'v1'), { recursive: true })
  const outside = join(directory, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(directory, 'other', 'sync', 'releases', 'v1', repositoryDigest(first)), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => other.save(first, 'v1', null, '**Total**: 1')).toThrow(/symbolic link/i)
  expect(() => other.list()).toThrow(/symbolic link/i)
  expect(existsSync(join(outside, 'v1.md'))).toBe(false)
})
