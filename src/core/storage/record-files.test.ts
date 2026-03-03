import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecordFiles } from './record-files.js'

describe('RecordFiles', () => {
  let dir: string
  let records: RecordFiles

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'record-test-'))
    records = new RecordFiles(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates issue record file', () => {
    records.createIssueRecord(281, {
      title: 'Fix docs',
      link: 'https://github.com/org/repo/issues/281',
      labels: 'documentation',
      author: 'zhangsan',
      createdAt: '2026-02-15',
      commentsSummary: '- @user1: use env vars\n- consensus: HF_ENDPOINT first',
      body: 'Current README lacks mirror config.',
    })
    const path = join(dir, 'todos', '281.md')
    expect(existsSync(path)).toBe(true)
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('# #281 Fix docs')
    expect(content).toContain('https://github.com/org/repo/issues/281')
    expect(content).toContain('@user1: use env vars')
  })

  it('creates upstream record file with hierarchy', () => {
    records.createUpstreamRecord('ant-design/ant-design', '6.3.1', {
      link: 'https://github.com/ant-design/ant-design/releases/tag/6.3.1',
      publishedAt: '2026-02-28',
      items: ['feat: Segmented block', 'fix: disabled style'],
    })
    const path = join(dir, 'upstream', 'ant-design', 'ant-design', '6.3.1.md')
    expect(existsSync(path)).toBe(true)
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('ant-design/ant-design@6.3.1')
    expect(content).toContain('feat: Segmented block')
  })

  it('creates idea record file with auto-increment ID', () => {
    const path1 = records.createIdeaRecord('Research WebSocket')
    const path2 = records.createIdeaRecord('Try GraphQL subscriptions')
    expect(path1).toContain('idea-1.md')
    expect(path2).toContain('idea-2.md')
  })

  it('reads record file by issue ref', () => {
    records.createIssueRecord(281, {
      title: 'Fix docs',
      link: 'https://github.com/org/repo/issues/281',
      labels: 'documentation',
      author: 'zhangsan',
      createdAt: '2026-02-15',
      commentsSummary: '',
      body: '',
    })
    const content = records.readRecord('#281')
    expect(content).toContain('# #281 Fix docs')
  })

  it('reads upstream record by ref', () => {
    records.createUpstreamRecord('ant-design/ant-design', '6.3.1', {
      link: 'https://github.com/ant-design/ant-design/releases/tag/6.3.1',
      publishedAt: '2026-02-28',
      items: ['feat: test'],
    })
    const content = records.readRecord('ant-design/ant-design@6.3.1')
    expect(content).toContain('ant-design/ant-design@6.3.1')
  })

  it('returns null for non-existent record', () => {
    expect(records.readRecord('#999')).toBeNull()
  })

  it('appends PR feedback to record file', () => {
    records.createIssueRecord(281, {
      title: 'Fix docs',
      link: 'https://github.com/org/repo/issues/281',
      labels: '',
      author: '',
      createdAt: '',
      commentsSummary: '',
      body: '',
    })
    records.appendPRFeedback('#281', 420, '2026-03-02', [
      { user: 'reviewer1', body: 'Add network tip' },
      { user: 'reviewer2', body: 'LGTM' },
    ])
    const content = records.readRecord('#281')
    expect(content).toContain('PR #420')
    expect(content).toContain('Add network tip')
  })
})
