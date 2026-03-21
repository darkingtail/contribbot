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
    // Use local timezone date (same as todayDate() in format.ts)
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(daily.last_checked).toBe(today)

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

  // --- getDailyStats ---

  it('returns daily stats', () => {
    store.addDailyCommits('ant-design/ant-design', [
      { sha: 'aaa', message: 'feat: A', type: 'feat', date: '2026-03-01' },
      { sha: 'bbb', message: 'fix: B', type: 'fix', date: '2026-03-02' },
      { sha: 'ccc', message: 'chore: C', type: 'chore', date: '2026-03-03' },
    ])
    store.updateDailyCommit('ant-design/ant-design', 'aaa', { action: 'skip' })

    const stats = store.getDailyStats('ant-design/ant-design')
    expect(stats.total).toBe(3)
    expect(stats.pending).toBe(2)
    expect(stats.processed).toBe(1)
    expect(stats.oldest).toBe('2026-03-01')
  })

  it('returns empty stats for non-existent repo', () => {
    const stats = store.getDailyStats('nonexistent/repo')
    expect(stats.total).toBe(0)
    expect(stats.oldest).toBeNull()
  })

  // --- compactDaily ---

  it('compacts processed daily commits by keep count', () => {
    store.addDailyCommits('ant-design/ant-design', [
      { sha: 'aaa', message: 'feat: A', type: 'feat', date: '2026-03-01' },
      { sha: 'bbb', message: 'fix: B', type: 'fix', date: '2026-03-02' },
      { sha: 'ccc', message: 'chore: C', type: 'chore', date: '2026-03-03' },
      { sha: 'ddd', message: 'feat: D', type: 'feat', date: '2026-03-04' },
    ])
    store.updateDailyCommit('ant-design/ant-design', 'aaa', { action: 'skip' })
    store.updateDailyCommit('ant-design/ant-design', 'bbb', { action: 'todo' })
    store.updateDailyCommit('ant-design/ant-design', 'ccc', { action: 'skip' })

    const result = store.compactDaily('ant-design/ant-design', { keep: 1 })
    expect(result.removed).toBe(2)
    // 1 pending (ddd) + 1 kept processed (ccc) = 2
    expect(result.remaining).toBe(2)
  })

  it('compacts processed daily commits by date', () => {
    store.addDailyCommits('ant-design/ant-design', [
      { sha: 'aaa', message: 'feat: A', type: 'feat', date: '2024-01-01' },
      { sha: 'bbb', message: 'fix: B', type: 'fix', date: '2026-03-01' },
    ])
    store.updateDailyCommit('ant-design/ant-design', 'aaa', { action: 'skip' })
    store.updateDailyCommit('ant-design/ant-design', 'bbb', { action: 'skip' })

    const result = store.compactDaily('ant-design/ant-design', { before: '2025-01-01' })
    expect(result.removed).toBe(1)
    expect(result.remaining).toBe(1)
  })

  it('compact preserves pending commits', () => {
    store.addDailyCommits('ant-design/ant-design', [
      { sha: 'aaa', message: 'feat: A', type: 'feat', date: '2026-03-01' },
      { sha: 'bbb', message: 'fix: B', type: 'fix', date: '2026-03-02' },
    ])
    store.updateDailyCommit('ant-design/ant-design', 'aaa', { action: 'skip' })
    // bbb is still pending

    const result = store.compactDaily('ant-design/ant-design', { keep: 0 })
    expect(result.removed).toBe(1)
    // pending bbb preserved
    expect(result.remaining).toBe(1)
  })

  it('compact maintains chronological order', () => {
    store.addDailyCommits('ant-design/ant-design', [
      { sha: 'aaa', message: 'feat: A', type: 'feat', date: '2026-03-03' },
      { sha: 'bbb', message: 'fix: B', type: 'fix', date: '2026-03-01' },
    ])
    store.updateDailyCommit('ant-design/ant-design', 'bbb', { action: 'skip' })

    store.compactDaily('ant-design/ant-design', { keep: 1 })
    const daily = store.getDaily('ant-design/ant-design')
    // bbb (03-01, processed kept) should come before aaa (03-03, pending)
    expect(daily.commits[0]!.sha).toBe('bbb')
    expect(daily.commits[1]!.sha).toBe('aaa')
  })

  it('compact on non-existent repo returns zero', () => {
    const result = store.compactDaily('nonexistent/repo', { keep: 10 })
    expect(result.removed).toBe(0)
    expect(result.remaining).toBe(0)
  })
})
