import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
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

  it('returns null for non-existent record', () => {
    expect(records.readRecord('#999')).toBeNull()
  })

  it('returns null for non-existent slug record', () => {
    expect(records.readRecord('nonexistent')).toBeNull()
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
    mkdirSync(join(dir, 'templates'), { recursive: true })
    writeFileSync(join(dir, 'templates', 'todo_record.md'), '# {{title}}\n\nCustom template for {{ref}}', 'utf-8')

    const path = records.createTodoRecord('#42', 'Custom test', 'feature', '2026-03-14')
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('# Custom test')
    expect(content).toContain('Custom template for #42')
    expect(content).not.toContain('## Notes')
  })

  it('auto-generates template file on first use', () => {
    const templatePath = join(dir, 'templates', 'todo_record.md')
    expect(existsSync(templatePath)).toBe(false)
    records.createTodoRecord('#1', 'Test', 'bug', '2026-03-14')
    expect(existsSync(templatePath)).toBe(true)
    const template = readFileSync(templatePath, 'utf-8')
    expect(template).toContain('{{title}}')
    expect(template).toContain('{{ref}}')
  })

  it('strips template comment header from rendered output', () => {
    const path = records.createTodoRecord('#1', 'Test', 'bug', '2026-03-14')
    const content = readFileSync(path, 'utf-8')
    expect(content).not.toContain('可用变量')
    expect(content).toContain('# Test')
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

  // --- readRecord ---

  it('reads record by issue ref', () => {
    records.createTodoRecord('#281', 'Fix docs', 'docs', '2026-03-14')
    const content = records.readRecord('#281')
    expect(content).toContain('# Fix docs')
  })

  it('reads record by slug ref', () => {
    records.createTodoRecord('playground', 'Playground', 'chore', '2026-03-14')
    const content = records.readRecord('playground')
    expect(content).toContain('# Playground')
  })

  // --- appendPRFeedback ---

  it('appends PR feedback to record file', () => {
    records.createTodoRecord('#281', 'Fix docs', 'docs', '2026-03-14')
    records.appendPRFeedback('#281', 420, '2026-03-02', [
      { user: 'reviewer1', body: 'Add network tip' },
      { user: 'reviewer2', body: 'LGTM' },
    ])
    const content = records.readRecord('#281')
    expect(content).toContain('PR #420')
    expect(content).toContain('Add network tip')
  })

  it('appends PR feedback to slug record', () => {
    records.createTodoRecord('playground', 'Playground', 'chore', '2026-03-14')
    records.appendPRFeedback('playground', 99, '2026-03-03', [
      { user: 'reviewer1', body: 'Looks good' },
    ])
    const content = records.readRecord('playground')
    expect(content).toContain('PR #99')
    expect(content).toContain('Looks good')
  })
})
