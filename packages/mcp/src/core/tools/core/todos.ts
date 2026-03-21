import { getIssue } from '../../clients/github.js'
import { RecordFiles } from '../../storage/record-files.js'
import { TodoStore, refSortKey } from '../../storage/todo-store.js'
import type { TodoType } from '../../enums.js'
import { getContribDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { difficultyEmoji, todayDate } from '../../utils/format.js'
import { detectTypeFromLabels } from '../../utils/github-helpers.js'

function refLink(ref: string | null, owner: string, name: string): string {
  if (!ref) return '—'
  if (ref.startsWith('#')) {
    const num = ref.slice(1)
    return `[${ref}](https://github.com/${owner}/${name}/issues/${num})`
  }
  return ref
}

function prLink(pr: number | null, owner: string, name: string): string {
  if (!pr) return '—'
  return `[#${pr}](https://github.com/${owner}/${name}/pull/${pr})`
}

export async function todoList(repo?: string, status?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const store = new TodoStore(getContribDir(owner, name))
  const allTodos = store.listSorted()

  if (allTodos.length === 0) {
    return `## Todos — ${owner}/${name}\n\n_No todos yet. Use \`todo_add\` to create one._`
  }

  // Filter by status if specified
  const todos = status
    ? allTodos.filter(t => t.status === status)
    : allTodos

  if (todos.length === 0) {
    return `## Todos — ${owner}/${name}\n\n_No todos with status "${status}"._`
  }

  const active = todos
    .filter(t => t.status === 'active' || t.status === 'pr_submitted')
    .sort((a, b) => refSortKey(a.ref) - refSortKey(b.ref))

  const backlogIdeas = todos
    .filter(t => t.status === 'idea' || t.status === 'backlog')
    .sort((a, b) => refSortKey(a.ref) - refSortKey(b.ref))

  const done = todos
    .filter(t => t.status === 'done')
    .sort((a, b) => refSortKey(a.ref) - refSortKey(b.ref))

  const lines: string[] = [
    `## Todos — ${owner}/${name}`,
    '',
    `> ${active.length} active · ${backlogIdeas.filter(t => t.status === 'backlog').length} backlog · ${backlogIdeas.filter(t => t.status === 'idea').length} idea · ${done.length} done`,
    '',
  ]

  // Active table
  if (active.length > 0) {
    lines.push('### Active')
    lines.push('| # | Ref | Type | Title | Difficulty | Status | Branch | PR |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
    active.forEach((t, i) => {
      const branch = t.branch ? `\`${t.branch}\`` : '—'
      lines.push(`| ${i + 1} | ${refLink(t.ref, owner, name)} | ${t.type} | ${t.title} | ${difficultyEmoji(t.difficulty)} | ${t.status} | ${branch} | ${prLink(t.pr, owner, name)} |`)
    })
    lines.push('')
  }

  // Backlog & Ideas table
  if (backlogIdeas.length > 0) {
    lines.push('### Backlog & Ideas')
    lines.push('| # | Ref | Type | Title | Status |')
    lines.push('| --- | --- | --- | --- | --- |')
    backlogIdeas.forEach((t, i) => {
      lines.push(`| ${i + 1} | ${refLink(t.ref, owner, name)} | ${t.type} | ${t.title} | ${t.status} |`)
    })
    lines.push('')
  }

  // Done table
  if (done.length > 0) {
    lines.push('### Done')
    lines.push('| # | Ref | Type | Title | Difficulty | PR |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    done.forEach((t, i) => {
      lines.push(`| ${i + 1} | ${refLink(t.ref, owner, name)} | ${t.type} | ${t.title} | ${difficultyEmoji(t.difficulty)} | ${prLink(t.pr, owner, name)} |`)
    })
    lines.push('')
  }

  return lines.join('\n')
}

export async function todoAdd(text: string, ref?: string, repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const store = new TodoStore(getContribDir(owner, name))

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

  if (!effectiveRef) {
    // Auto-generate slug ref from English keywords in title
    const words = text.match(/[a-zA-Z][a-zA-Z0-9]*/g) ?? []
    let slug = words
      .map(w => w.toLowerCase())
      .filter(w => w.length > 1 && !['the', 'and', 'for', 'with', 'from', 'etc'].includes(w))
      .slice(0, 3)
      .join('-')
    if (!slug) slug = `idea-${Date.now().toString(36).slice(-4)}`
    // Deduplicate: append -2, -3... if slug already exists
    const existing = store.list()
    const existingRefs = new Set(existing.map(t => t.ref))
    let candidate = slug
    let counter = 2
    while (existingRefs.has(candidate)) {
      candidate = `${slug}-${counter++}`
    }
    finalRef = candidate
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

  const item = store.add({ ref: finalRef, title, type })

  // Create record file immediately
  const records = new RecordFiles(getContribDir(owner, name))
  records.createTodoRecord(finalRef ?? `idea-${Date.now().toString(36).slice(-4)}`, title, type, todayDate())

  return `Added todo: **${item.title}** (${item.type}${item.ref ? `, ref: ${item.ref}` : ''})`
}

export async function todoDelete(indexOrText: string, repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const store = new TodoStore(getContribDir(owner, name))

  const resolved = store.resolveItem(indexOrText)
  if (!resolved) {
    throw new Error(`Todo not found: "${indexOrText}". Use todo_list to see available items.`)
  }

  const deleted = store.delete(resolved.storeIndex)
  if (!deleted) {
    throw new Error(`Failed to delete todo at index ${resolved.storeIndex}.`)
  }

  return `Deleted: ~~${deleted.title}~~${deleted.ref ? ` (${deleted.ref})` : ''}`
}

export async function todoDone(indexOrText: string, repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const store = new TodoStore(getContribDir(owner, name))

  const resolved = store.resolveItem(indexOrText)
  if (!resolved) {
    throw new Error(`Todo not found: "${indexOrText}". Use todo_list to see available items.`)
  }

  const archived = store.archiveAndDelete(resolved.storeIndex)
  if (!archived) {
    throw new Error(`Failed to archive todo at index ${resolved.storeIndex}.`)
  }

  return `Done & archived: ~~${archived.title}~~${archived.ref ? ` (${archived.ref})` : ''}`
}

export async function todoArchive(repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const store = new TodoStore(getContribDir(owner, name))
  const allTodos = store.list()

  const doneIndices = allTodos
    .map((t, i) => t.status === 'done' ? i : -1)
    .filter(i => i >= 0)

  if (doneIndices.length === 0) {
    return 'No done todos to archive.'
  }

  // Archive from end to preserve indices
  let count = 0
  for (const i of [...doneIndices].reverse()) {
    const result = store.archiveAndDelete(i)
    if (result) count++
  }

  return `Archived ${count} done todos to todos.archive.yaml`
}
