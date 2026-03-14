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

  it('creates slug record file', () => {
    const path = records.createSlugRecord('playground', 'Playground 实验')
    expect(path).toContain('playground.md')
    expect(existsSync(path)).toBe(true)
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('# Playground 实验')
    expect(content).toContain('_待分析_')
  })

  it('resolves slug ref to todos/{slug}.md', () => {
    records.createSlugRecord('playground', 'Playground 实验')
    const content = records.readRecord('playground')
    expect(content).toContain('# Playground 实验')
  })

  it('returns null for non-existent slug record', () => {
    expect(records.readRecord('nonexistent')).toBeNull()
  })

  it('appends PR feedback to slug record', () => {
    records.createSlugRecord('playground', 'Playground 实验')
    records.appendPRFeedback('playground', 99, '2026-03-03', [
      { user: 'reviewer1', body: 'Looks good' },
    ])
    const content = records.readRecord('playground')
    expect(content).toContain('PR #99')
    expect(content).toContain('Looks good')
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

  // --- createTodoRecord ---

  it('creates todo record from default template', () => {
    const path = records.createTodoRecord('#123', 'Fix the bug', 'bug', '2026-03-14')
    expect(path).toContain('123.md')
    expect(existsSync(path)).toBe(true)
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('# Fix the bug')
    expect(content).toContain('ref: #123')
    expect(content).toContain('type: bug')
    expect(content).toContain('## Notes')
    expect(content).toContain('## Implementation Plan')
  })

  it('creates todo record for slug ref', () => {
    const path = records.createTodoRecord('playground', 'Setup playground', 'chore', '2026-03-14')
    expect(path).toContain('playground.md')
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('# Setup playground')
    expect(content).toContain('ref: playground')
  })

  it('uses custom template when available', () => {
    const { mkdirSync, writeFileSync } = require('node:fs')
    mkdirSync(join(dir, 'templates'), { recursive: true })
    writeFileSync(join(dir, 'templates', 'todo_record.md'), '# {{title}}\n\nCustom template for {{ref}}', 'utf-8')

    const path = records.createTodoRecord('#42', 'Custom test', 'feature', '2026-03-14')
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('# Custom test')
    expect(content).toContain('Custom template for #42')
    expect(content).not.toContain('## Notes')
  })

  // --- enrichWithIssueDetails ---

  it('enriches existing record with issue details', () => {
    records.createTodoRecord('#200', 'Some issue', 'bug', '2026-03-14')
    records.enrichWithIssueDetails(200, {
      title: 'Some issue',
      link: 'https://github.com/org/repo/issues/200',
      labels: 'bug, critical',
      author: 'testuser',
      createdAt: '2026-03-10',
      commentsSummary: '- @dev: needs fix',
      body: 'Detailed description here',
    })
    const content = records.readRecord('#200')!
    expect(content).toContain('## Issue Details')
    expect(content).toContain('bug, critical')
    expect(content).toContain('testuser')
    expect(content).toContain('Detailed description here')
    expect(content).toContain('## Comments Summary')
    expect(content).toContain('needs fix')
  })

  it('does nothing if record file does not exist', () => {
    records.enrichWithIssueDetails(999, {
      title: 'Missing',
      link: '',
      labels: '',
      author: '',
      createdAt: '',
      commentsSummary: '',
      body: '',
    })
    expect(records.readRecord('#999')).toBeNull()
  })
})
