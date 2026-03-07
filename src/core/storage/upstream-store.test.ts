import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { UpstreamStore } from './upstream-store.js'

describe('UpstreamStore', () => {
  let dir: string
  let store: UpstreamStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'upstream-test-'))
    store = new UpstreamStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty when no file exists', () => {
    expect(store.listRepos()).toEqual([])
  })

  // --- Versions ---

  it('adds a version with items', () => {
    store.addVersion('ant-design/ant-design', '6.3.1', [
      { title: 'Segmented block', type: 'feature' },
      { title: 'Fix Modal style', type: 'bug' },
    ])
    const repos = store.listRepos()
    expect(repos).toEqual(['ant-design/ant-design'])

    const versions = store.listVersions('ant-design/ant-design')
    expect(versions).toHaveLength(1)
    expect(versions[0]!.version).toBe('6.3.1')
    expect(versions[0]!.items).toHaveLength(2)
    expect(versions[0]!.items[0]!.status).toBe('active')
  })

  it('updates a version item status and pr', () => {
    store.addVersion('ant-design/ant-design', '6.3.1', [
      { title: 'Segmented block', type: 'feature' },
    ])
    store.updateVersionItem('ant-design/ant-design', '6.3.1', 0, { status: 'done', pr: 430 })
    const versions = store.listVersions('ant-design/ant-design')
    expect(versions[0]!.items[0]!.status).toBe('done')
    expect(versions[0]!.items[0]!.pr).toBe(430)
  })

  it('auto-marks version done when all items done', () => {
    store.addVersion('ant-design/ant-design', '6.3.1', [
      { title: 'Item 1', type: 'feature' },
    ])
    store.updateVersionItem('ant-design/ant-design', '6.3.1', 0, { status: 'done', pr: 430 })
    const versions = store.listVersions('ant-design/ant-design')
    expect(versions[0]!.status).toBe('done')
  })

  // --- Daily ---

  it('adds daily commits and deduplicates by sha', () => {
    store.addDailyCommits('ant-design/ant-design', [
      { sha: 'abc123', message: 'feat(Button): add loading', type: 'feat', date: '2026-03-03' },
      { sha: 'def456', message: 'fix(Modal): scroll lock', type: 'fix', date: '2026-03-03' },
    ])
    const daily = store.getDaily('ant-design/ant-design')
    expect(daily.commits).toHaveLength(2)
    expect(daily.last_checked).toBe(new Date().toISOString().slice(0, 10))

    // Add again with one duplicate
    store.addDailyCommits('ant-design/ant-design', [
      { sha: 'abc123', message: 'feat(Button): add loading', type: 'feat', date: '2026-03-03' },
      { sha: 'ghi789', message: 'refactor: extract hook', type: 'refactor', date: '2026-03-03' },
    ])
    const daily2 = store.getDaily('ant-design/ant-design')
    expect(daily2.commits).toHaveLength(3) // abc123 not duplicated
  })

  it('updates daily commit action', () => {
    store.addDailyCommits('ant-design/ant-design', [
      { sha: 'abc123', message: 'feat(Button): add loading', type: 'feat', date: '2026-03-03' },
    ])
    store.updateDailyCommit('ant-design/ant-design', 'abc123', { action: 'todo', ref: '#42' })
    const daily = store.getDaily('ant-design/ant-design')
    expect(daily.commits[0]!.action).toBe('todo')
    expect(daily.commits[0]!.ref).toBe('#42')
  })

  it('returns empty daily when none exists', () => {
    const daily = store.getDaily('ant-design/ant-design')
    expect(daily.commits).toEqual([])
    expect(daily.last_checked).toBeNull()
  })

  // --- updateDailyCommitBatch ---

  it('batch updates multiple daily commits in single write', () => {
    store.addDailyCommits('ant-design/ant-design', [
      { sha: 'abc123', message: 'feat: A', type: 'feat', date: '2026-03-03' },
      { sha: 'def456', message: 'fix: B', type: 'fix', date: '2026-03-03' },
      { sha: 'ghi789', message: 'ci: C', type: 'ci', date: '2026-03-03' },
    ])

    const count = store.updateDailyCommitBatch('ant-design/ant-design', [
      { sha: 'abc123', fields: { action: 'todo', ref: '#1' } },
      { sha: 'ghi789', fields: { action: 'skip' } },
    ])

    expect(count).toBe(2)

    const daily = store.getDaily('ant-design/ant-design')
    expect(daily.commits[0]!.action).toBe('todo')
    expect(daily.commits[0]!.ref).toBe('#1')
    expect(daily.commits[1]!.action).toBeNull() // def456 unchanged
    expect(daily.commits[2]!.action).toBe('skip')
  })

  it('returns 0 when batch updating non-existent repo', () => {
    const count = store.updateDailyCommitBatch('nonexistent/repo', [
      { sha: 'abc123', fields: { action: 'skip' } },
    ])
    expect(count).toBe(0)
  })
})
