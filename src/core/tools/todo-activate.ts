import { homedir } from 'node:os'
import { join } from 'node:path'
import { getIssue, getIssueComments, parseRepo } from '../clients/github.js'
import { RecordFiles } from '../storage/record-files.js'
import { TodoStore } from '../storage/todo-store.js'
import type { TodoDifficulty } from '../storage/todo-store.js'

function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contribbot', owner, name)
}

export async function todoActivate(item: string, repo?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)
  const records = new RecordFiles(contribDir)
  const allTodos = store.list()

  // Only consider open (non-done) todos
  const openIndices: number[] = []
  allTodos.forEach((t, i) => {
    if (t.status !== 'done') openIndices.push(i)
  })

  if (openIndices.length === 0) {
    return 'Error: No open todos found.'
  }

  // Parse item as 1-based index or text substring match
  const num = Number.parseInt(item, 10)
  let targetStoreIndex: number | undefined

  if (!Number.isNaN(num) && num >= 1 && num <= openIndices.length) {
    targetStoreIndex = openIndices[num - 1]
  }
  else {
    const match = openIndices.find(i =>
      allTodos[i].title.toLowerCase().includes(item.toLowerCase()),
    )
    targetStoreIndex = match
  }

  if (targetStoreIndex === undefined) {
    return `Error: Todo not found: "${item}". Use todo_list to see available items.`
  }

  const todo = allTodos[targetStoreIndex]
  let difficulty: TodoDifficulty = 'medium'

  if (todo.ref && todo.ref.startsWith('#')) {
    // Issue ref like #281 — fetch issue info
    const issueNumber = Number.parseInt(todo.ref.slice(1), 10)

    try {
      const [issue, comments] = await Promise.all([
        getIssue(owner, name, issueNumber),
        getIssueComments(owner, name, issueNumber),
      ])

      // Assess difficulty heuristically
      const labelNames = issue.labels.map(l =>
        (typeof l === 'string' ? l : l.name).toLowerCase(),
      )

      if (labelNames.some(n => n.includes('good first issue') || n.includes('easy'))) {
        difficulty = 'easy'
      }
      else if (
        labelNames.some(n => n.includes('complex'))
        || comments.length > 10
        || (issue.body && issue.body.length > 2000)
      ) {
        difficulty = 'hard'
      }
      else {
        difficulty = 'medium'
      }

      // Build comments summary
      const commentsSummary = comments
        .map((c) => {
          const user = c.user?.login ?? 'unknown'
          const body = c.body.replace(/\r?\n/g, ' ').slice(0, 100)
          return `- @${user}: ${body}`
        })
        .join('\n')

      // Create issue record file
      const labelsStr = issue.labels
        .map(l => (typeof l === 'string' ? l : l.name))
        .join(', ')

      records.createIssueRecord(issueNumber, {
        title: issue.title,
        link: issue.html_url,
        labels: labelsStr || '—',
        author: issue.user?.login ?? 'unknown',
        createdAt: issue.created_at,
        commentsSummary,
        body: issue.body ?? '',
      })
    }
    catch (err) {
      // If GitHub API fails, still activate but with default difficulty
      const message = err instanceof Error ? err.message : String(err)
      const updated = store.update(targetStoreIndex, { status: 'active', difficulty })
      if (!updated) {
        return `Error: Failed to update todo at index ${targetStoreIndex}.`
      }
      return `Activated: **${updated.title}** (difficulty: ${difficulty}) — ⚠️ GitHub fetch failed: ${message}`
    }
  }
  else if (todo.ref) {
    // Custom slug ref — create slug record
    records.createSlugRecord(todo.ref, todo.title)
  }
  else {
    // No ref — create idea record
    records.createIdeaRecord(todo.title)
  }

  // Update todo status to active with assessed difficulty
  const updated = store.update(targetStoreIndex, { status: 'active', difficulty })
  if (!updated) {
    return `Error: Failed to update todo at index ${targetStoreIndex}.`
  }

  const difficultyLabel = difficulty === 'easy' ? '🟢 easy' : difficulty === 'hard' ? '🔴 hard' : '🟡 medium'
  return `Activated: **${updated.title}**${updated.ref ? ` (${updated.ref})` : ''} — difficulty: ${difficultyLabel}`
}
