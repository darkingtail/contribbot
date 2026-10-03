import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { repositoryDigest, type RepositoryRef } from '../utils/repository-ref.js'
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
    const path = records.createTodoRecord('#123', 'Fix the bug', 'bug', '2026-03-14', 't-owner')
    expect(path).toContain('123.md')
    expect(existsSync(path)).toBe(true)
    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('# Fix the bug')
    expect(content).toContain('ref: #123')
    expect(content).toContain('type: bug')
    expect(content).toContain('## Notes')
    expect(content).toContain('## Implementation Plan')
    expect(content).toContain('contribbot:todo-id t-owner')
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

  it('escapes issue labels that contain a table separator', () => {
    records.createTodoRecord('#204', 'Pipe label', 'bug', '2026-03-14')
    records.enrichWithIssueDetails(204, {
      title: 'Pipe label',
      link: 'https://github.com/org/repo/issues/204',
      labels: 'bug | needs-triage',
      author: 'testuser',
      createdAt: '2026-03-10',
      commentsSummary: '',
      body: '',
    })

    const content = records.readRecord('#204')!
    const labelsRow = content.split('\n').find(line => line.startsWith('| Labels |'))
    expect(labelsRow).toBe('| Labels | bug \\| needs-triage |')
    expect([...labelsRow!.matchAll(/(?<!\\)\|/g)]).toHaveLength(3)
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

  it('preserves custom sections while adopting legacy issue details', () => {
    const path = records.createTodoRecord('#201', 'Legacy issue', 'bug', '2026-03-14')
    writeFileSync(path, `# Legacy issue

## Issue Details

| Field | Value |
|-------|-------|
| Link | old-link |

## Comments Summary

Old comments

## Work Log

Keep this custom prose.
`, 'utf-8')

    records.enrichWithIssueDetails(201, {
      title: 'Legacy issue',
      link: 'https://github.com/org/repo/issues/201',
      labels: 'bug',
      author: 'testuser',
      createdAt: '2026-03-10',
      commentsSummary: 'Updated comments',
      body: 'Updated body',
    })

    const content = readFileSync(path, 'utf-8')
    expect(content.match(/^## Issue Details$/gm)).toHaveLength(1)
    expect(content.match(/^## Work Log$/gm)).toHaveLength(1)
    expect(content).toContain('Keep this custom prose.')
  })

  it('does not consume a custom section between legacy issue and comment headings', () => {
    const path = records.createTodoRecord('#202', 'Interleaved legacy issue', 'bug', '2026-03-14')
    writeFileSync(path, `# Interleaved legacy issue

## Issue Details

Old issue details.

## Work Log

Keep this work log.

## Comments Summary

Old comments.
`, 'utf-8')

    records.enrichWithIssueDetails(202, {
      title: 'Interleaved legacy issue',
      link: 'https://github.com/org/repo/issues/202',
      labels: 'bug',
      author: 'testuser',
      createdAt: '2026-03-10',
      commentsSummary: 'Updated comments',
      body: 'Updated body',
    })

    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('Keep this work log.')
    expect(content.match(/^## Work Log$/gm)).toHaveLength(1)
  })

  it('does not pair an unmatched issue-details start with a later managed end', () => {
    const path = records.createTodoRecord('#203', 'Partial issue', 'bug', '2026-03-14', 't-partial-issue')
    writeFileSync(path, `<!-- contribbot:todo-id t-partial-issue -->
# Partial issue

<!-- contribbot:issue-details:start -->
Custom prose after an interrupted update.
`, 'utf-8')

    const info = {
      title: 'Partial issue',
      link: 'https://github.com/org/repo/issues/203',
      labels: 'bug',
      author: 'testuser',
      createdAt: '2026-03-10',
      commentsSummary: 'Updated comments',
      body: 'Updated body',
    }
    records.enrichWithIssueDetails(203, info, 't-partial-issue')
    records.enrichWithIssueDetails(203, info, 't-partial-issue')

    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('Custom prose after an interrupted update.')
    expect(content.match(/contribbot:issue-details:end/g)).toHaveLength(1)
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

  it('rejects a record owned by another stable todo id', () => {
    records.createTodoRecord('shared', 'Current owner', 'chore', '2026-09-17', 't-current')

    expect(records.readRecord('shared', 't-current')).toContain('# Current owner')
    expect(records.readRecord('shared', 't-archived')).toBeNull()
    expect(records.resolveOwnedRefPath('shared', 't-archived')).toBeNull()
  })

  it('does not expose a stamped record to a legacy todo without an id', () => {
    records.createTodoRecord('shared', 'Current owner', 'chore', '2026-09-17', 't-current')

    expect(records.readRecord('shared')).toBeNull()
    expect(records.resolveOwnedRefPath('shared')).toBeNull()
  })

  it('preserves an existing owner record when the ref is reused', () => {
    const historicalPath = records.createTodoRecord('shared', 'Historical owner', 'chore', '2026-09-17', 't-historical')
    writeFileSync(historicalPath, `${readFileSync(historicalPath, 'utf-8')}\nHistorical note.\n`, 'utf-8')

    const currentPath = records.createTodoRecord('shared', 'Current owner', 'feature', '2026-09-17', 't-current')

    expect(currentPath).not.toBe(historicalPath)
    expect(readFileSync(historicalPath, 'utf-8')).toContain('Historical note.')
    expect(records.readRecord('shared', 't-historical')).toContain('# Historical owner')
    expect(records.readRecord('shared', 't-current')).toContain('# Current owner')
  })

  it('keeps owner-specific records outside the custom-ref filename namespace', () => {
    records.createTodoRecord('shared', 'Historical owner', 'chore', '2026-09-16', 't-historical')

    const reusedPath = records.createTodoRecord('shared', 'Current owner', 'feature', '2026-09-16', 't-current')
    const customRefPath = records.createTodoRecord('shared.t-current', 'Custom ref', 'feature', '2026-09-16', 't-custom')

    expect(reusedPath).toBe(join(dir, 'todos', '.owners', 't-current.md'))
    expect(customRefPath).toBe(join(dir, 'todos', 'shared.t-current.md'))
    expect(customRefPath).not.toBe(reusedPath)
    expect(records.readRecord('shared', 't-current')).toContain('# Current owner')
    expect(records.readRecord('shared.t-current', 't-custom')).toContain('# Custom ref')
  })

  it('continues to read owner-specific records created by the legacy filename scheme', () => {
    mkdirSync(join(dir, 'todos'), { recursive: true })
    const legacyPath = join(dir, 'todos', 'shared.t-legacy.md')
    writeFileSync(legacyPath, '<!-- contribbot:todo-id t-legacy -->\n# Legacy owner\n', 'utf-8')

    expect(records.resolveOwnedRefPath('shared', 't-legacy')).toBe(legacyPath)
    expect(records.readRecord('shared', 't-legacy')).toContain('# Legacy owner')
  })

  it('does not assign an unstamped legacy record to a stable todo unless explicitly adopted', () => {
    const legacyPath = records.createTodoRecord('shared', 'Legacy owner', 'chore', '2025-01-01')
    writeFileSync(legacyPath, `${readFileSync(legacyPath, 'utf-8')}\nLegacy note.\n`, 'utf-8')

    expect(records.resolveOwnedRefPath('shared', 't-current')).toBeNull()

    const currentPath = records.ensureTodoRecord('shared', 'Current owner', 'feature', '2026-09-17', 't-current')
    expect(currentPath).not.toBe(legacyPath)
    expect(readFileSync(legacyPath, 'utf-8')).toContain('Legacy note.')
    expect(records.readRecord('shared', 't-current')).toContain('# Current owner')
  })

  it('explicitly adopts an unstamped record when the same legacy todo receives an id', () => {
    const legacyPath = records.createTodoRecord('legacy-active', 'Legacy active', 'chore', '2025-01-01')
    writeFileSync(legacyPath, `${readFileSync(legacyPath, 'utf-8')}\nLegacy note.\n`, 'utf-8')

    const adoptedPath = records.ensureTodoRecord(
      'legacy-active',
      'Legacy active',
      'chore',
      '2026-09-17',
      't-adopted',
      { adoptUnowned: true },
    )

    expect(adoptedPath).toBe(legacyPath)
    expect(records.readRecord('legacy-active', 't-adopted')).toContain('Legacy note.')
    expect(readFileSync(legacyPath, 'utf-8')).toContain('contribbot:todo-id t-adopted')
  })

  it('round-trips todo refs containing at signs through the todo record path', () => {
    const path = records.createTodoRecord('release@v1', 'Release task', 'feature', '2026-09-17', 't-release')

    expect(path).toBe(join(dir, 'todos', 'release@v1.md'))
    expect(records.readRecord('release@v1', 't-release')).toContain('# Release task')
    expect(records.ensureTodoRecord('release@v1', 'Release task', 'feature', '2026-09-17', 't-release')).toBe(path)
  })

  it('rejects todo refs that can alias or escape the todo record directory', () => {
    expect(() => records.resolveTodoRefPath('./42')).toThrow('Invalid todo ref')
    expect(() => records.resolveTodoRefPath('../escape')).toThrow('Invalid todo ref')
    expect(() => records.resolveTodoRefPath('nested/path')).toThrow('Invalid todo ref')
    expect(() => records.resolveTodoRefPath('42')).toThrow('Invalid todo ref')
  })

  it('confines upstream record refs to one owner, repo and version filename', () => {
    const repository: RepositoryRef = {
      platform: 'github',
      instance: 'https://github.com',
      path: 'owner/repo',
    }
    const digest = repositoryDigest(repository)
    expect(records.resolveUpstreamRefPath(repository, 'v1.2.3'))
      .toBe(join(dir, 'upstream', digest, 'v1.2.3.md'))
    expect(() => records.resolveUpstreamRefPath(repository, '../escape')).toThrow('Invalid upstream version')
    expect(() => records.resolveUpstreamRefPath(repository, 'release/v1')).toThrow('Invalid upstream version')
    expect(() => records.resolveUpstreamRefPath(repository, 'release\\v1')).toThrow('Invalid upstream version')
    expect(() => records.resolveUpstreamRefPath({ ...repository, path: '../repo' }, 'v1')).toThrow(/Invalid github repository path|repository path/i)
    expect(() => records.resolveUpstreamRefPath({ ...repository, path: 'owner/nested/repo' }, 'v1'))
      .toThrow(/Invalid github repository path|repository path/i)
  })

  it('keeps same-path upstream records from different instances separate', () => {
    const first: RepositoryRef = {
      platform: 'gitlab',
      instance: 'https://first.example.com/gitlab',
      path: 'team/sub/ui',
    }
    const second: RepositoryRef = { ...first, instance: 'https://second.example.com/gitlab' }
    const firstPath = records.resolveUpstreamRefPath(first, 'v1')
    const secondPath = records.resolveUpstreamRefPath(second, 'v1')
    expect(firstPath).not.toBe(secondPath)
    mkdirSync(join(dir, 'upstream', repositoryDigest(first)), { recursive: true })
    mkdirSync(join(dir, 'upstream', repositoryDigest(second)), { recursive: true })
    writeFileSync(firstPath, '# first')
    writeFileSync(secondPath, '# second')
    expect(records.readUpstreamRecord(first, 'v1')).toBe('# first')
    expect(records.readUpstreamRecord(second, 'v1')).toBe('# second')
  })

  it('does not read an upstream record through a linked source directory', () => {
    const repository: RepositoryRef = {
      platform: 'github',
      instance: 'https://github.com',
      path: 'owner/repo',
    }
    const outside = join(dir, 'outside')
    const upstream = join(dir, 'upstream')
    mkdirSync(outside)
    mkdirSync(upstream)
    writeFileSync(join(outside, 'v1.md'), 'outside record')
    symlinkSync(outside, join(upstream, repositoryDigest(repository)), process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => records.readUpstreamRecord(repository, 'v1')).toThrow(/symbolic link/i)
    expect(readFileSync(join(outside, 'v1.md'), 'utf8')).toBe('outside record')
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

  it('replaces the managed PR snapshot when the review set grows', () => {
    records.createTodoRecord('#282', 'Review growth', 'feature', '2026-03-14')
    records.appendPRFeedback('#282', 421, '2026-03-02', [
      { user: 'reviewer1', body: 'CHANGES_REQUESTED' },
    ])
    records.appendPRFeedback('#282', 421, '2026-03-03', [
      { user: 'reviewer1', body: 'CHANGES_REQUESTED' },
      { user: 'reviewer2', body: 'APPROVED' },
    ])
    records.appendPRFeedback('#282', 421, '2026-03-04', [
      { user: 'reviewer1', body: 'CHANGES_REQUESTED' },
      { user: 'reviewer2', body: 'APPROVED' },
      { user: 'reviewer3', body: 'COMMENTED' },
    ])

    const content = records.readRecord('#282')!
    expect(content.match(/### PR #421/g)).toHaveLength(1)
    expect(content.match(/@reviewer1/g)).toHaveLength(1)
    expect(content).toContain('@reviewer3')
  })

  it('appends managed PR feedback when a custom template has no insertion marker', () => {
    mkdirSync(join(dir, 'templates'), { recursive: true })
    writeFileSync(join(dir, 'templates', 'todo_record.md'), '# {{title}}\n\nCustom prose for {{ref}}.', 'utf-8')
    records.createTodoRecord('custom-pr', 'Custom PR', 'feature', '2026-03-14', 't-custom-pr')

    records.appendPRFeedback('custom-pr', 422, '2026-03-02', [
      { user: 'reviewer1', body: 'CHANGES_REQUESTED' },
    ], 't-custom-pr')
    records.appendPRFeedback('custom-pr', 422, '2026-03-03', [
      { user: 'reviewer1', body: 'APPROVED' },
    ], 't-custom-pr')

    const content = records.readRecord('custom-pr', 't-custom-pr')!
    expect(content).toContain('Custom prose for custom-pr.')
    expect(content.match(/### PR #422/g)).toHaveLength(1)
    expect(content).toContain('APPROVED')
  })

  it('does not pair an unmatched PR start with a later managed end', () => {
    const path = records.createTodoRecord('partial-pr', 'Partial PR', 'feature', '2026-03-14', 't-partial-pr')
    writeFileSync(path, `<!-- contribbot:todo-id t-partial-pr -->
# Partial PR

<!-- contribbot:pr-feedback:start 423 -->
Custom prose after an interrupted PR refresh.
`, 'utf-8')

    records.appendPRFeedback('partial-pr', 423, '2026-03-02', [
      { user: 'reviewer1', body: 'CHANGES_REQUESTED' },
    ], 't-partial-pr')
    records.appendPRFeedback('partial-pr', 423, '2026-03-03', [
      { user: 'reviewer1', body: 'APPROVED' },
    ], 't-partial-pr')

    const content = readFileSync(path, 'utf-8')
    expect(content).toContain('Custom prose after an interrupted PR refresh.')
    expect(content.match(/### PR #423/g)).toHaveLength(1)
    expect(content).toContain('APPROVED')
  })
})
