import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { safeWriteFileSync } from '../utils/fs.js'
import { assertSafeFileName, assertSafeTodoRef } from '../utils/todo-ref.js'
import type { TodoItem } from './todo-store.js'
import type { DocumentProjection } from './todo-projection.js'
import { renderTodoWorkflow, replaceWorkflowRegion } from './todo-projection.js'

interface IssueRecordInfo {
  title: string
  link: string
  labels: string
  author: string
  createdAt: string
  commentsSummary: string
  body: string
}


interface PRReview {
  user: string
  body: string
}

const PR_FEEDBACK_MARKER = '<!-- 自动追加 -->'
const TODO_ID_PATTERN = /^<!-- contribbot:todo-id (t-[^\s]+) -->$/m
const ISSUE_DETAILS_START = '<!-- contribbot:issue-details:start -->'
const ISSUE_DETAILS_END = '<!-- contribbot:issue-details:end -->'

function prFeedbackStart(prNumber: number): string {
  return `<!-- contribbot:pr-feedback:start ${prNumber} -->`
}

function prFeedbackEnd(prNumber: number): string {
  return `<!-- contribbot:pr-feedback:end ${prNumber} -->`
}

function findManagedRegion(
  content: string,
  startMarker: string,
  endMarker: string,
): { start: number; end: number } | undefined {
  let endSearchFrom = 0
  while (endSearchFrom < content.length) {
    const end = content.indexOf(endMarker, endSearchFrom)
    if (end === -1) return undefined
    const start = content.lastIndexOf(startMarker, end)
    if (start !== -1) return { start, end: end + endMarker.length }
    endSearchFrom = end + endMarker.length
  }
  return undefined
}

const DEFAULT_TODO_TEMPLATE = `<!--
  Todo 实现文档模板
  可用变量：
    {{title}}  — todo 标题
    {{ref}}    — 引用标识（#123 或自定义 slug）
    {{type}}   — 类型（bug / feature / docs / chore）
    {{date}}   — 创建日期
-->
# {{title}}

> ref: {{ref}} · type: {{type}} · created: {{date}}

## Notes

## Implementation Plan

## PR Feedback

${PR_FEEDBACK_MARKER}
`

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}

interface EnsureTodoRecordOptions {
  adoptUnowned?: boolean
}

function recordOwner(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined
  return readFileSync(filePath, 'utf-8').match(TODO_ID_PATTERN)?.[1]
}

function ownerRecordPath(filePath: string, todoId: string): string {
  assertSafeFileName(todoId, 'todo id')
  return join(dirname(filePath), '.owners', `${todoId}.md`)
}

function legacyOwnerRecordPath(filePath: string, todoId: string): string {
  return filePath.endsWith('.md')
    ? `${filePath.slice(0, -3)}.${todoId}.md`
    : `${filePath}.${todoId}`
}

export class RecordFiles {
  private baseDir: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
  }

  projectWorkflow(todo: TodoItem, write = false): DocumentProjection {
    if (!todo.executions.some(execution => execution.workflow)) {
      return { status: 'not_applicable', path: null, note: 'Legacy document is unchanged.' }
    }
    let filePath: string | null = null
    try {
      if (!todo.id) throw new Error('Managed document requires a stable Todo id.')
      const ref = todo.ref ?? todo.id
      const canonical = this.resolveTodoRefPath(ref)
      const owned = ownerRecordPath(canonical, todo.id)
      for (const path of [dirname(canonical), dirname(owned), canonical, owned, legacyOwnerRecordPath(canonical, todo.id)]) {
        if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
          throw new Error('Workflow document paths must not be symbolic links.')
        }
      }
      filePath = this.resolveOwnedRefPath(ref, todo.id) ?? owned
      const exists = existsSync(filePath)
      if (exists && recordOwner(filePath) !== todo.id) throw new Error('Workflow document belongs to another Todo.')
      const bytes = exists ? readFileSync(filePath) : null
      const original = bytes?.toString('utf8') ?? null
      if (bytes && !Buffer.from(original!, 'utf8').equals(bytes)) {
        throw new Error('Workflow document is not lossless UTF-8. Preserve the original and explicitly resolve its encoding before resume.')
      }
      const templatePath = join(this.baseDir, 'templates', 'todo_record.md')
      const template = original === null
        ? renderTemplate((existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : DEFAULT_TODO_TEMPLATE)
          .replace(/^<!--[\s\S]*?-->\s*/m, ''), { title: todo.title, ref, type: todo.type, date: todo.created })
        : ''
      const content = original ?? `<!-- contribbot:todo-id ${todo.id} -->\n${template}`
      const expected = replaceWorkflowRegion(content, renderTodoWorkflow(todo))
      if (original === expected) return { status: 'current', path: filePath, note: 'Stored-state projection only; not verification.' }
      if (!write) return { status: 'outdated', path: filePath, note: 'Run todo_resume / local resume to rebuild the document without replaying work.' }
      this.ensureDir(dirname(filePath))
      safeWriteFileSync(filePath, expected)
      return { status: 'current', path: filePath, note: 'Stored-state projection only; not verification.' }
    }
    catch (error) {
      // A derived view must never turn a committed command result into a failure.
      return { status: 'blocked', path: filePath, note: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Create a todo record file from template. Called at todo_add time.
   * Uses templates/todo_record.md if exists, otherwise default template.
   */
  createTodoRecord(ref: string, title: string, type: string, date: string, todoId?: string): string {
    const dir = join(this.baseDir, 'todos')
    this.ensureDir(dir)

    const canonicalPath = this.resolveTodoRefPath(ref)
    let filePath = canonicalPath

    if (todoId) {
      const ownedPath = ownerRecordPath(canonicalPath, todoId)
      const legacyOwnedPath = legacyOwnerRecordPath(canonicalPath, todoId)
      if (existsSync(ownedPath)) {
        if (recordOwner(ownedPath) !== todoId) {
          throw new Error(`Todo record ${ownedPath} is not owned by ${todoId}.`)
        }
        return ownedPath
      }
      if (existsSync(legacyOwnedPath) && recordOwner(legacyOwnedPath) === todoId) {
        return legacyOwnedPath
      }

      if (existsSync(canonicalPath)) {
        if (recordOwner(canonicalPath) === todoId) return canonicalPath
        filePath = ownedPath
      }
    }
    else if (existsSync(canonicalPath)) {
      throw new Error(`Todo record already exists: ${canonicalPath}`)
    }

    const templateDir = join(this.baseDir, 'templates')
    const templatePath = join(templateDir, 'todo_record.md')
    if (!existsSync(templatePath)) {
      this.ensureDir(templateDir)
      writeFileSync(templatePath, DEFAULT_TODO_TEMPLATE, 'utf-8')
    }
    const raw = readFileSync(templatePath, 'utf-8')

    // Strip leading HTML comment (variable docs) before rendering, preserve in template file only
    let content = renderTemplate(
      raw.replace(/^<!--[\s\S]*?-->\s*/m, ''),
      { title, ref, type, date },
    )
    if (todoId) content = `<!-- contribbot:todo-id ${todoId} -->\n${content}`

    this.ensureDir(dirname(filePath))
    writeFileSync(filePath, content, 'utf-8')
    return filePath
  }

  ensureTodoRecord(
    ref: string,
    title: string,
    type: string,
    date: string,
    todoId?: string,
    options: EnsureTodoRecordOptions = {},
  ): string {
    if (todoId && options.adoptUnowned) {
      const canonicalPath = this.resolveTodoRefPath(ref)
      const ownedPath = ownerRecordPath(canonicalPath, todoId)
      const legacyOwnedPath = legacyOwnerRecordPath(canonicalPath, todoId)
      const hasOwnedRecord = (existsSync(ownedPath) && recordOwner(ownedPath) === todoId)
        || (existsSync(legacyOwnedPath) && recordOwner(legacyOwnedPath) === todoId)
      if (existsSync(canonicalPath) && !recordOwner(canonicalPath) && !hasOwnedRecord) {
        const content = readFileSync(canonicalPath, 'utf-8')
        safeWriteFileSync(canonicalPath, `<!-- contribbot:todo-id ${todoId} -->\n${content}`)
        return canonicalPath
      }
    }

    const existing = this.resolveOwnedRefPath(ref, todoId)
    if (existing && existsSync(existing)) return existing
    return this.createTodoRecord(ref, title, type, date, todoId)
  }

  /**
   * Enrich an existing todo record with issue details. Called at todo_activate time.
   */
  enrichWithIssueDetails(issueNumber: number, info: IssueRecordInfo, todoId?: string): void {
    const filePath = this.resolveOwnedRefPath(`#${issueNumber}`, todoId)
    if (!filePath || !existsSync(filePath)) return

    const issueSection = [
      ISSUE_DETAILS_START,
      '## Issue Details',
      '',
      `| Field | Value |`,
      `|-------|-------|`,
      `| Link | ${info.link} |`,
      `| Labels | ${info.labels} |`,
      `| Author | ${info.author} |`,
      `| Created | ${info.createdAt} |`,
      '',
      info.body ? `> ${info.body}` : '',
      '',
      '## Comments Summary',
      '',
      info.commentsSummary || '_No comments_',
      ISSUE_DETAILS_END,
    ].join('\n')

    let content = readFileSync(filePath, 'utf-8')
    const managed = findManagedRegion(content, ISSUE_DETAILS_START, ISSUE_DETAILS_END)
    if (managed) {
      content = content.slice(0, managed.start) + issueSection + content.slice(managed.end)
    }
    else {
      const legacyStart = content.indexOf('\n## Issue Details')
      if (legacyStart !== -1) {
        const commentsStart = content.indexOf('\n## Comments Summary', legacyStart + '\n## Issue Details'.length)
        const firstSectionAfterIssue = content.indexOf('\n## ', legacyStart + '\n## Issue Details'.length)
        if (commentsStart !== -1 && firstSectionAfterIssue === commentsStart) {
          const nextSection = content.indexOf('\n## ', commentsStart + '\n## Comments Summary'.length)
          const legacyEnd = nextSection === -1 ? content.length : nextSection
          content = content.slice(0, legacyStart) + `\n${issueSection}` + content.slice(legacyEnd)
        }
        else {
          // An unknown hand-written section is not safe to delete. Add the managed
          // section before it and leave the original prose untouched.
          content = content.slice(0, legacyStart) + `\n${issueSection}` + content.slice(legacyStart)
        }
      }
      else {
        // Insert issue details before the first template section, or append for custom templates.
        const insertPoint = content.indexOf('\n## ')
        if (insertPoint !== -1) {
          content = content.slice(0, insertPoint) + `\n${issueSection}` + content.slice(insertPoint)
        }
        else {
          content += `\n${issueSection}`
        }
      }
    }
    safeWriteFileSync(filePath, content)
  }

  readRecord(ref: string, todoId?: string): string | null {
    const filePath = this.resolveOwnedRefPath(ref, todoId)
    if (!filePath || !existsSync(filePath)) return null
    return readFileSync(filePath, 'utf-8')
  }

  readUpstreamRecord(ref: string): string | null {
    const filePath = this.resolveUpstreamRefPath(ref)
    if (!filePath || !existsSync(filePath)) return null
    return readFileSync(filePath, 'utf-8')
  }

  appendPRFeedback(ref: string, prNumber: number, date: string, reviews: PRReview[], todoId?: string): void {
    const filePath = this.resolveOwnedRefPath(ref, todoId)
    if (!filePath || !existsSync(filePath)) return

    let content = readFileSync(filePath, 'utf-8')
    const reviewDigest = createHash('sha256')
      .update(JSON.stringify([...reviews].sort((left, right) =>
        left.user.localeCompare(right.user) || left.body.localeCompare(right.body),
      )))
      .digest('hex')
      .slice(0, 16)
    const feedbackDigestMarker = `<!-- contribbot:pr-feedback ${prNumber} ${reviewDigest} -->`
    const managedStartMarker = prFeedbackStart(prNumber)
    const managedEndMarker = prFeedbackEnd(prNumber)
    const managed = findManagedRegion(content, managedStartMarker, managedEndMarker)
    if (managed) {
      const existing = content.slice(managed.start, managed.end)
      if (existing.includes(feedbackDigestMarker)) return
    }

    const feedbackLines = [
      managedStartMarker,
      `### PR #${prNumber} (${date})`,
      '',
      ...reviews.map(r => `- **@${r.user}**: ${r.body}`),
      '',
      feedbackDigestMarker,
      managedEndMarker,
    ].join('\n')

    if (managed) {
      content = content.slice(0, managed.start)
        + feedbackLines
        + content.slice(managed.end)
    }
    else if (content.includes(PR_FEEDBACK_MARKER)) {
      content = content.replace(PR_FEEDBACK_MARKER, `${feedbackLines}\n${PR_FEEDBACK_MARKER}`)
    }
    else {
      content = `${content}${content.endsWith('\n') ? '' : '\n'}\n${feedbackLines}\n`
    }
    safeWriteFileSync(filePath, content)
  }

  resolveTodoRefPath(ref: string): string {
    assertSafeTodoRef(ref)

    // Issue ref: #281
    if (ref.startsWith('#')) {
      const num = ref.slice(1)
      return join(this.baseDir, 'todos', `${num}.md`)
    }

    return join(this.baseDir, 'todos', `${ref}.md`)
  }

  resolveUpstreamRefPath(ref: string): string | null {
    // Upstream ref: owner/repo@version
    const atIndex = ref.indexOf('@')
    if (atIndex === -1) return null
    const repo = ref.slice(0, atIndex)
    const version = ref.slice(atIndex + 1)
    const parts = repo.split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`Invalid upstream ref: "${ref}".`)
    }
    const owner = parts[0]
    const name = parts[1]
    assertSafeFileName(owner, 'upstream owner')
    assertSafeFileName(name, 'upstream repo')
    assertSafeFileName(version, 'upstream version')

    const root = resolve(this.baseDir, 'upstream')
    const filePath = resolve(root, owner, name, `${version}.md`)
    if (!filePath.startsWith(`${root}${sep}`)) {
      throw new Error(`Invalid upstream ref: "${ref}".`)
    }
    return filePath
  }

  resolveOwnedRefPath(ref: string, todoId?: string): string | null {
    const filePath = this.resolveTodoRefPath(ref)

    if (todoId) {
      const canonicalOwner = recordOwner(filePath)
      if (canonicalOwner === todoId) return filePath

      const ownedPath = ownerRecordPath(filePath, todoId)
      if (existsSync(ownedPath)) {
        return recordOwner(ownedPath) === todoId ? ownedPath : null
      }

      const legacyOwnedPath = legacyOwnerRecordPath(filePath, todoId)
      if (existsSync(legacyOwnedPath) && recordOwner(legacyOwnedPath) === todoId) {
        return legacyOwnedPath
      }

      if (!existsSync(filePath)) return filePath
      return null
    }

    if (!existsSync(filePath)) return filePath
    return recordOwner(filePath) ? null : filePath
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}
