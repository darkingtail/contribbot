import { statSync } from 'node:fs'
import { getPullReviews } from '../../clients/github.js'
import { TodoStore } from '../../storage/todo-store.js'
import { RecordFiles } from '../../storage/record-files.js'
import { currentTodoExecution } from '../../storage/todo-store.js'
import type { TodoItem } from '../../storage/todo-store.js'
import { getContribDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { todayDate } from '../../utils/format.js'
import { formatTodoPullLinks, todoPulls } from '../../storage/todo-pulls.js'
import { formatTodoPullProgress, observeTodoPulls } from './todo-pr-progress.js'

function formatTodoBasicInfo(todo: TodoItem, owner: string, name: string): string {
  const lines: string[] = [
    `## ${todo.title}`,
    '',
    '| Field | Value | Note |',
    '|-------|-------|------|',
    `| Ref | ${todo.ref ?? '—'} | Source/reference, not a required PR |`,
    `| Type | ${todo.type} | |`,
    `| Status | ${todo.status} | Independent of PR progress |`,
    `| Difficulty | ${todo.difficulty ?? '—'} | |`,
    `| PR | ${formatTodoPullLinks(todo, `${owner}/${name}`)} | Associations, not acceptance |`,
    `| Claimed | ${todo.claimed_items?.length ? `${todo.claimed_items.length} item(s)` : '—'} | |`,
    `| Created | ${todo.created} | |`,
    `| Updated | ${todo.updated} | |`,
  ]
  if ('archived' in todo) lines.push(`| Archived | ${String(todo.archived)} | |`)
  if (todo.claimed_items && todo.claimed_items.length > 0) {
    lines.push('', '### Claimed Items', '')
    todo.claimed_items.forEach(s => lines.push(`- ${s}`))
  }
  lines.push('', formatExecutionContext(todo))
  lines.push(
    '',
    '_No record file found. Use issue_detail or upstream_sync_check with save option to create one._',
  )
  return lines.join('\n')
}

function formatExecutionContext(todo: TodoItem): string {
  const current = currentTodoExecution(todo)
  const closed = todo.executions.filter(item => item.closed_at !== null)
  const lines: string[] = [
    '## Execution Context',
    '',
    `- Todo ID: \`${todo.id ?? 'legacy-unassigned'}\``,
    `- Todo status: \`${todo.status}\``,
    `- Lifecycle revision: ${todo.lifecycle_revision ?? 0}`,
    '',
  ]
  if (todo.last_cancellation) {
    lines.push(`Last cancellation: ${todo.last_cancellation.decision} (${todo.last_cancellation.at}); recorded decision, not the current lifecycle state.`, '')
  }

  if (current) {
    lines.push(
      '## Current Execution',
      '',
      `- ID: \`${current.id}\``,
      `- Goal: ${current.goal}`,
      `- Phase: \`${current.phase}\``,
      `- Next: ${current.next}`,
      `- Blocked on: ${current.blocked_on ?? '—'}`,
      `- Opened: ${current.opened_at}`,
      '',
      '### Evidence',
      '',
    )
    appendEvidence(lines, current.evidence)
  }
  else {
    lines.push('_No open execution. Use `todo_activate` when work resumes._')
  }

  lines.push('', '## Execution History', '')
  if (closed.length === 0) lines.push('_No closed executions._')
  else {
    closed.forEach((execution, index) => {
      lines.push(
        `### Execution ${index + 1} — \`${execution.id}\``,
        '',
        `- Goal: ${execution.goal}`,
        `- Outcome: \`${execution.outcome ?? '—'}\``,
        `- Opened: ${execution.opened_at}`,
        `- Closed: ${execution.closed_at ?? '—'}`,
        `- Note: ${execution.outcome_note || '—'}`,
        '',
        '#### Evidence',
        '',
      )
      appendEvidence(lines, execution.evidence)
      lines.push('')
    })
  }

  return lines.join('\n')
}

function appendEvidence(lines: string[], evidenceItems: TodoItem['executions'][number]['evidence']): void {
  if (evidenceItems.length === 0) {
    lines.push('_No evidence recorded._')
    return
  }
  lines.push('| Source | Locator | Observed | Digest | Revision | Note |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const evidence of evidenceItems) {
    lines.push(`| ${evidence.source} | ${evidence.locator} | ${evidence.observed_at} | ${evidence.digest} | ${evidence.revision ?? '—'} | ${evidence.note ?? '—'} |`)
  }
}

const FIVE_MINUTES_MS = 5 * 60 * 1000

function isCacheStale(filePath: string): boolean {
  try {
    const mtime = statSync(filePath).mtimeMs
    return Date.now() - mtime > FIVE_MINUTES_MS
  }
  catch {
    return true
  }
}

export async function todoDetail(item: string, repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)
  const records = new RecordFiles(contribDir)

  // Use resolveItemFromAll to include done items
  const selected = store.resolveItemFromAll(item)

  if (!selected) {
    throw new Error(`Todo not found: "${item}". Use todo_list to see available items.`)
  }
  const readCurrent = (): TodoItem => {
    const current = store.resolveItemFromAll(selected.id ?? item)
    if (!current || (!selected.id && JSON.stringify(current) !== JSON.stringify(selected))) {
      throw new Error('Todo changed or was removed during detail refresh. Read the current todo_list before retrying.')
    }
    return current
  }
  const observedPulls = await observeTodoPulls(todoPulls(selected, `${owner}/${name}`))
  let todo = readCurrent()
  const pullProgress = () => `\n\n${formatTodoPullProgress(todo, `${owner}/${name}`, observedPulls)}`

  let projection = store.recordProjection(todo)
  const projectionNote = () => projection.status === 'not_applicable' ? ''
    : `\n\nDocument projection: ${projection.status}. ${projection.note} Use todo_resume after resolving document errors; do not replay task operations.`
  const recordRef = todo.ref ?? (projection.status === 'not_applicable' ? undefined : todo.id)
  if (!recordRef || projection.status === 'blocked') {
    return formatTodoBasicInfo(todo, owner, name) + projectionNote() + pullProgress()
  }

  // An id-less generation cannot safely claim prose while another generation owns the same ref.
  const hasAmbiguousLegacyOwner = !todo.id && Boolean(todo.ref) && (
    ('archived' in todo && Boolean(store.findByRef(recordRef)))
    || (!('archived' in todo) && store.hasArchivedRef(recordRef))
  )
  const readContent = () => {
    if (hasAmbiguousLegacyOwner || projection.status === 'blocked') return null
    try { return records.readRecord(recordRef, todo.id) }
    catch (error) {
      if (projection.status === 'not_applicable') throw error
      projection = { ...projection, status: 'blocked', note: error instanceof Error ? error.message : String(error) }
      return null
    }
  }
  let content = readContent()

  // If todo has a linked PR, handle auto-refresh of reviews
  if (todo.id && todo.pr && !('archived' in todo)) {
    const todoId = todo.id
    const executionId = currentTodoExecution(todo)?.id ?? null
    const linkedPr = todo.pr
    const prSection = `### PR #${todo.pr}`
    const filePath = records.resolveOwnedRefPath(recordRef, todo.id)

    const hasPRSection = content?.includes(prSection) ?? false
    const cacheStale = filePath ? isCacheStale(filePath) : true

    if (!hasPRSection || cacheStale) {
      try {
        const reviews = await getPullReviews(owner, name, linkedPr)
        const today = todayDate()

        const prReviews = reviews
          .filter(r => r.user && r.state !== 'PENDING')
          .map(r => ({
            user: r.user!.login,
            body: r.state,
          }))

        const current = store.resolveItemById(todoId)
        if (
          prReviews.length > 0
          && current?.item.pr === linkedPr
          && (currentTodoExecution(current.item)?.id ?? null) === executionId
        ) {
          records.appendPRFeedback(recordRef, linkedPr, today, prReviews, todoId)
        }
      }
      catch {
        // API call failed, proceed with existing content
      }

      // Both the record and its health may have changed across the remote await.
      todo = readCurrent()
      projection = store.recordProjection(todo)
      content = readContent()
    }
  }

  if (!content) {
    return formatTodoBasicInfo(todo, owner, name) + projectionNote() + pullProgress()
  }

  return `${formatExecutionContext(todo)}${projectionNote()}${pullProgress()}\n\n---\n\n${content}`
}
