import { existsSync, unlinkSync } from 'node:fs'
import { getIssue } from '../../clients/github.js'
import { RecordFiles } from '../../storage/record-files.js'
import { TodoStore } from '../../storage/todo-store.js'
import { currentTodoExecution } from '../../storage/todo-store.js'
import { TODO_STATUSES, validateEnum } from '../../enums.js'
import type { TodoType } from '../../enums.js'
import { getContribDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { difficultyEmoji, todayDate } from '../../utils/format.js'
import { detectTypeFromLabels } from '../../utils/github-helpers.js'
import { closeManagedWithReadback } from '../../execution/closure.js'
import type { ClosureRequest } from '../../execution/closure.js'
import { formatTodoPullLinks } from '../../storage/todo-pulls.js'
export { archiveTodos as todoArchive } from './todo-lifecycle.js'

export type TodoCompletion = Omit<ClosureRequest, 'directory' | 'todo_id' | 'target'>

function refLink(ref: string | null, owner: string, name: string): string {
  if (!ref) return '—'
  if (ref.startsWith('#')) {
    const num = ref.slice(1)
    return `[${ref}](https://github.com/${owner}/${name}/issues/${num})`
  }
  return ref
}

export async function todoList(repo?: string, status?: string): Promise<string> {
  if (status !== undefined) validateEnum(TODO_STATUSES, status, 'status')
  const { owner, name } = await resolveRepo(repo)
  const store = new TodoStore(getContribDir(owner, name))
  const allTodos = store.listForDisplay()

  if (allTodos.length === 0) {
    return `## Todos — ${owner}/${name}\n\n_No todos yet. Use \`todo_add\` to create one._`
  }

  // Filter by status if specified
  const todos = status
    ? allTodos.filter(t => t.status === status)
    : allTodos

  const displayIndexes = new Map(allTodos.map((todo, index) => [todo, index + 1]))

  if (todos.length === 0) {
    return `## Todos — ${owner}/${name}\n\n_No todos with status "${status}"._`
  }

  const active = todos
    .filter(t => t.status === 'active')

  const backlogIdeas = todos
    .filter(t => t.status === 'idea' || t.status === 'backlog')

  const done = todos
    .filter(t => t.status === 'done')
  const paused = todos.filter(t => t.status === 'paused')
  const cancelled = todos.filter(t => t.status === 'cancelled')

  const lines: string[] = [
    `## Todos — ${owner}/${name}`,
    '',
    `> ${active.length} active · ${backlogIdeas.filter(t => t.status === 'backlog').length} backlog · ${backlogIdeas.filter(t => t.status === 'idea').length} idea · ${paused.length} paused · ${done.length} done · ${cancelled.length} cancelled`,
    '',
  ]

  // Active table
  if (active.length > 0) {
    lines.push('### Active')
    lines.push('| # | Ref | Type | Title | Difficulty | Status | Branch | PR | Note |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    active.forEach((t) => {
      const branch = t.branch ? `\`${t.branch}\`` : '—'
      const execution = currentTodoExecution(t)
      const note = execution ? `${execution.phase}: ${execution.next}` : 'No open execution'
      lines.push(`| ${displayIndexes.get(t)} | ${refLink(t.ref, owner, name)} | ${t.type} | ${t.title} | ${difficultyEmoji(t.difficulty)} | ${t.status} | ${branch} | ${formatTodoPullLinks(t, `${owner}/${name}`)} | ${note} |`)
    })
    lines.push('')
  }

  // Backlog & Ideas table
  if (backlogIdeas.length > 0) {
    lines.push('### Backlog & Ideas')
    lines.push('| # | Ref | Type | Title | Status | PR | Note |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    backlogIdeas.forEach((t) => {
      lines.push(`| ${displayIndexes.get(t)} | ${refLink(t.ref, owner, name)} | ${t.type} | ${t.title} | ${t.status} | ${formatTodoPullLinks(t, `${owner}/${name}`)} | ${t.executions.length} execution(s) |`)
    })
    lines.push('')
  }

  // Done table
  if (done.length > 0) {
    lines.push('### Done')
    lines.push('| # | Ref | Type | Title | Difficulty | PR | Note |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    done.forEach((t) => {
      lines.push(`| ${displayIndexes.get(t)} | ${refLink(t.ref, owner, name)} | ${t.type} | ${t.title} | ${difficultyEmoji(t.difficulty)} | ${formatTodoPullLinks(t, `${owner}/${name}`)} | Completed, not archived; ${t.executions.length} execution(s) |`)
    })
    lines.push('')
  }
  for (const [title, items, note] of [
    ['Paused', paused, 'Paused, not finished; explicit local continuation required'],
    ['Cancelled', cancelled, 'Cancelled, not archived; reopen explicitly before new work'],
  ] as const) {
    if (!items.length) continue
    lines.push(`### ${title}`, '| # | Ref | Type | Title | PR | Note |', '| --- | --- | --- | --- | --- | --- |')
    for (const t of items) lines.push(`| ${displayIndexes.get(t)} | ${refLink(t.ref, owner, name)} | ${t.type} | ${t.title} | ${formatTodoPullLinks(t, `${owner}/${name}`)} | ${note}; ${t.executions.length} execution(s) |`)
    lines.push('')
  }

  return lines.join('\n')
}

export async function todoAdd(text: string, ref?: string, repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)
  const records = new RecordFiles(contribDir)

  const existingResult = (existing: ReturnType<TodoStore['findByRef']>): string | undefined => {
    if (!existing) return undefined
    if (!existing.id && existing.ref) {
      const resolved = store.resolveItem(existing.ref)
      if (resolved) existing = store.ensureTodoId(resolved.storeIndex) ?? existing
    }
    if (existing.ref) {
      records.ensureTodoRecord(
        existing.ref,
        existing.title,
        existing.type,
        todayDate(),
        existing.id,
        { adoptUnowned: !store.hasArchivedRef(existing.ref, existing.id) },
      )
    }
    return `Todo already exists: **${existing.title}** (${existing.type}, ref: ${existing.ref})`
  }

  let finalRef: string | null = null
  let type: TodoType = 'chore'
  let title = text

  // Determine ref: explicit parameter or extracted from text
  const effectiveRef = ref || (() => {
    const match = text.match(/^#(\d+)\s*/)
    if (match) {
      title = text.slice(match[0].length).trim() || text
      return `#${match[1]}`
    }
    return null
  })()

  if (effectiveRef) {
    const normalizedRef = /^#?\d+$/.test(effectiveRef)
      ? (effectiveRef.startsWith('#') ? effectiveRef : `#${effectiveRef}`)
      : effectiveRef
    const duplicate = store.transaction(() => existingResult(store.findByRef(normalizedRef)))
    if (duplicate) return duplicate
  }

  if (!effectiveRef) {
    // Auto-generate slug ref from English keywords in title
    const words = text.match(/[a-zA-Z][a-zA-Z0-9]*/g) ?? []
    let slug = words
      .map(w => w.toLowerCase())
      .filter(w => w.length > 1 && !['the', 'and', 'for', 'with', 'from', 'etc'].includes(w))
      .slice(0, 3)
      .join('-')
    if (!slug) slug = `idea-${Date.now().toString(36).slice(-4)}`
    finalRef = slug
  }

  if (effectiveRef) {
    // Check if it's a numeric issue ref (pure number or #N)
    const isIssueRef = /^#?\d+$/.test(effectiveRef)

    if (isIssueRef) {
      const refStr = effectiveRef.startsWith('#') ? effectiveRef : `#${effectiveRef}`
      const issueNumber = Number.parseInt(refStr.replace('#', ''), 10)
      finalRef = refStr

      try {
        const issue = await getIssue(owner, name, issueNumber)
        type = detectTypeFromLabels(issue.labels)
        if (!ref && title === text) {
          title = issue.title
        }
        else if (ref && !text.trim()) {
          title = issue.title
        }
      }
      catch {
        // GitHub API failed, use defaults
      }
    }
    else {
      // Custom slug ref (e.g. "playground")
      finalRef = effectiveRef
    }
  }

  return store.transaction(() => {
    if (!effectiveRef && finalRef) {
      const slug = finalRef
      let counter = 2
      while (store.findByRef(finalRef)) finalRef = `${slug}-${counter++}`
    }
    else if (finalRef) {
      const duplicate = existingResult(store.findByRef(finalRef))
      if (duplicate) return duplicate
    }
    const item = store.add({ ref: finalRef, title, type })
    records.createTodoRecord(finalRef ?? `idea-${Date.now().toString(36).slice(-4)}`, title, type, todayDate(), item.id)
    return `Added todo: **${item.title}** (${item.type}${item.ref ? `, ref: ${item.ref}` : ''}) · Todo ID: \`${item.id}\``
  })
}

export async function todoDelete(indexOrText: string, repo?: string, force = false): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)
  const records = new RecordFiles(contribDir)

  return store.transaction(() => {
    let resolved = store.resolveItem(indexOrText)
    if (!resolved) {
      throw new Error(`Todo not found: "${indexOrText}". Use todo_list to see available items.`)
    }

    if (!resolved.item.id && resolved.item.ref && store.hasArchivedRef(resolved.item.ref)) {
      const identified = store.ensureTodoId(resolved.storeIndex)
      if (!identified) throw new Error(`Failed to assign a stable id to todo "${indexOrText}" before deletion.`)
      resolved = { ...resolved, item: identified }
    }

    const deleted = store.delete(resolved.storeIndex, { force })
    if (!deleted) {
      throw new Error(`Failed to delete todo at index ${resolved.storeIndex}.`)
    }

    // Delete associated record file
    if (deleted.ref) {
      const recordPath = records.resolveOwnedRefPath(deleted.ref, deleted.id)
      if (recordPath && existsSync(recordPath)) {
        unlinkSync(recordPath)
      }
    }

    return `Deleted: ~~${deleted.title}~~${deleted.ref ? ` (${deleted.ref})` : ''}`
  })
}

export async function todoDone(indexOrText: string, repo?: string, completion?: TodoCompletion): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)
  const records = new RecordFiles(contribDir)

  if (completion) {
    const completed = await closeManagedWithReadback({
      ...completion, directory: contribDir, todo_id: indexOrText, target: { kind: 'local' },
    })
    return `${completed.status === 'done' ? 'Done' : 'Stopped'}: ${completed.title} · ${completed.executions.at(-1)?.workflow?.closure?.mode} · ${'archived' in completed ? 'already archived' : 'not archived'} · Todo ID: \`${completed.id}\``
  }
  return store.transaction(() => {
    const resolved = store.resolveItemForArchival(indexOrText)
    if (!resolved) {
      throw new Error(`Todo not found: "${indexOrText}". Use todo_list to see available items.`)
    }

    const identified = resolved.item.id ? resolved.item : store.ensureTodoId(resolved.storeIndex)
    if (!identified?.id) throw new Error(`Failed to assign a stable id to todo "${indexOrText}" before archival.`)
    if (identified.ref) {
      records.ensureTodoRecord(
        identified.ref,
        identified.title,
        identified.type,
        todayDate(),
        identified.id,
        { adoptUnowned: !store.hasArchivedRef(identified.ref, identified.id) },
      )
    }

    const completed = store.completeTodo(resolved.storeIndex, 'done', 'Todo completed.')
    if (!completed) {
      throw new Error(`Failed to complete todo at index ${resolved.storeIndex}.`)
    }

    return `Done: ~~${completed.title}~~${completed.ref ? ` (${completed.ref})` : ''} · ${'archived' in completed ? 'reconciled historical archival' : 'not archived'} · Todo ID: \`${completed.id}\``
  })
}
