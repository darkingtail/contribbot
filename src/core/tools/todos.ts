import { homedir } from 'node:os'
import { join } from 'node:path'
import { getIssue, parseRepo } from '../clients/github.js'
import { TodoStore } from '../storage/todo-store.js'
import type { TodoDifficulty, TodoItem, TodoStatus, TodoType } from '../storage/todo-store.js'

function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contribbot', owner, name)
}

function difficultyEmoji(d: TodoDifficulty | null): string {
  if (d === 'easy') return '🟢'
  if (d === 'medium') return '🟡'
  if (d === 'hard') return '🔴'
  return '—'
}

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

function refSortKey(ref: string | null): number {
  if (!ref) return Infinity
  if (ref.startsWith('#')) {
    const num = Number.parseInt(ref.slice(1), 10)
    return Number.isNaN(num) ? Number.MAX_SAFE_INTEGER : num
  }
  return Number.MAX_SAFE_INTEGER
}

function detectTypeFromLabels(labels: Array<{ name: string } | string>): TodoType {
  const names = labels.map(l => (typeof l === 'string' ? l : l.name).toLowerCase())
  if (names.some(n => n.includes('bug'))) return 'bug'
  if (names.some(n => n.includes('feature') || n.includes('enhancement'))) return 'feature'
  if (names.some(n => n.includes('doc'))) return 'docs'
  return 'chore'
}

export function todoList(repo?: string, status?: string): string {
  const { owner, name } = parseRepo(repo)
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
    lines.push('| # | Ref | Type | Title | Difficulty | Status | PR |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    active.forEach((t, i) => {
      lines.push(`| ${i + 1} | ${refLink(t.ref, owner, name)} | ${t.type} | ${t.title} | ${difficultyEmoji(t.difficulty)} | ${t.status} | ${prLink(t.pr, owner, name)} |`)
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
  const { owner, name } = parseRepo(repo)
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
  return `Added todo: **${item.title}** (${item.type}${item.ref ? `, ref: ${item.ref}` : ''})`
}

export function todoDone(indexOrText: string, repo?: string): string {
  const { owner, name } = parseRepo(repo)
  const store = new TodoStore(getContribDir(owner, name))
  const allTodos = store.list()

  // Only consider open todos (not done)
  const openIndices: number[] = []
  allTodos.forEach((t, i) => {
    if (t.status !== 'done') openIndices.push(i)
  })

  if (openIndices.length === 0) {
    return 'Error: No open todos found.'
  }

  const num = Number.parseInt(indexOrText, 10)
  let targetStoreIndex: number | undefined

  if (!Number.isNaN(num) && num >= 1 && num <= openIndices.length) {
    // 1-based index into open todos
    targetStoreIndex = openIndices[num - 1]
  }
  else {
    // Text substring match
    const match = openIndices.find(i =>
      allTodos[i].title.toLowerCase().includes(indexOrText.toLowerCase()),
    )
    targetStoreIndex = match
  }

  if (targetStoreIndex === undefined) {
    return `Error: Todo not found: "${indexOrText}". Use todo_list to see available items.`
  }

  const updated = store.update(targetStoreIndex, { status: 'done' })
  if (!updated) {
    return `Error: Failed to update todo at index ${targetStoreIndex}.`
  }

  return `Done: ~~${updated.title}~~${updated.ref ? ` (${updated.ref})` : ''}`
}
