import { getIssue, getIssueComments } from '../../clients/github.js'
import { RecordFiles } from '../../storage/record-files.js'
import { currentTodoExecution, TodoStore } from '../../storage/todo-store.js'
import type { TodoDifficulty } from '../../enums.js'
import { getContribDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { difficultyLabel, todayDate } from '../../utils/format.js'

export function generateDefaultBranchName(todo: { ref: string | null; title: string; type: string }): string {
  const prefix = todo.type === 'bug' ? 'fix' : todo.type === 'docs' ? 'docs' : 'feat'

  const words = todo.title
    .replace(/[^\w\s-]/g, '')
    .split(/\s+/)
    .filter(w => /^[a-zA-Z]/.test(w))
    .map(w => w.toLowerCase())
    .filter(w => w.length > 1 && !['the', 'and', 'for', 'with', 'from', 'this', 'that'].includes(w))
    .slice(0, 3)
  const slug = words.join('-')

  if (todo.ref?.startsWith('#')) {
    const num = todo.ref.slice(1)
    return `${prefix}/${slug ? `${num}-${slug}` : num}`
  } else if (todo.ref) {
    return `${prefix}/${todo.ref}`
  }
  return `${prefix}/${slug || 'task'}`
}

function resolveActivatedExecution(store: TodoStore, todoId: string, executionId: string) {
  const resolved = store.resolveItemById(todoId)
  if (!resolved) throw new Error(`Todo ${todoId} changed or was removed while activation was waiting for GitHub.`)
  if (currentTodoExecution(resolved.item)?.id !== executionId) {
    throw new Error(`Todo ${todoId} execution changed while activation was waiting for GitHub.`)
  }
  return resolved
}

export async function todoActivate(item: string, branch?: string, repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)
  const records = new RecordFiles(contribDir)

  const { resolved, executionState } = store.transaction(() => {
    const resolved = store.resolveItemForActivation(item)
    if (!resolved) throw new Error(`Todo not found: "${item}". Use todo_list to see available items.`)
    const executionState = store.activateExecution(resolved.storeIndex)
    const todo = executionState.item
    if (todo.ref) {
      records.ensureTodoRecord(
        todo.ref, todo.title, todo.type, todayDate(), todo.id,
        { adoptUnowned: !store.hasArchivedRef(todo.ref, todo.id) },
      )
    }
    return { resolved, executionState }
  })
  const todo = executionState.item
  let difficulty: TodoDifficulty = 'medium'
  let existingClaims: { user: string; items: string[] }[] = []
  const todoId = executionState.item.id!
  const executionId = executionState.execution.id
  let issueDetails: Parameters<RecordFiles['enrichWithIssueDetails']>[1] | undefined

  if (todo.ref && todo.ref.startsWith('#')) {
    const issueNumber = Number.parseInt(todo.ref.slice(1), 10)
    let issue: Awaited<ReturnType<typeof getIssue>>
    let comments: Awaited<ReturnType<typeof getIssueComments>>

    try {
      [issue, comments] = await Promise.all([
        getIssue(owner, name, issueNumber),
        getIssueComments(owner, name, issueNumber),
      ])
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const updated = store.transaction(() => {
        const current = resolveActivatedExecution(store, todoId, executionId)
        return store.update(current.storeIndex, { status: 'active', difficulty })
      })
      if (!updated) {
        throw new Error(`Failed to update todo ${todoId}.`)
      }
      return [
        `Activated: **${updated.title}** (difficulty: ${difficulty}) · Todo ID: \`${todoId}\` — ⚠️ GitHub fetch failed: ${message}`,
        `Execution ${executionState.created ? 'created' : 'resumed'}: ${executionState.execution.id} · phase: ${executionState.execution.phase} · next: ${executionState.execution.next}`,
      ].join('\n')
    }

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

    const commentsSummary = comments
      .map((c) => {
        const user = c.user?.login ?? 'unknown'
        const body = c.body.replace(/\r?\n/g, ' ').slice(0, 100)
        return `- @${user}: ${body}`
      })
      .join('\n')

    const claimPattern = /<!-- contribbot:claim @(\S+) -->/g
    for (const comment of comments) {
      const match = comment.body.match(claimPattern)
      if (match) {
        const userMatch = comment.body.match(/<!-- contribbot:claim @(\S+)/)
        const claimUser = userMatch?.[1] ?? comment.user?.login ?? 'unknown'
        const itemLines = comment.body
          .split('\n')
          .filter(line => line.startsWith('- ') && !line.includes('<!--'))
          .map(line => line.slice(2).trim())
        existingClaims.push({ user: claimUser, items: itemLines })
      }
    }

    const labelsStr = issue.labels
      .map(l => (typeof l === 'string' ? l : l.name))
      .join(', ')

    issueDetails = {
      title: issue.title,
      link: issue.html_url,
      labels: labelsStr || '—',
      author: issue.user?.login ?? 'unknown',
      createdAt: issue.created_at,
      commentsSummary,
      body: issue.body ?? '',
    }
  }

  const { updated, branchName } = store.transaction(() => {
    const current = resolveActivatedExecution(store, todoId, executionId)
    const branchName = branch ?? generateDefaultBranchName(current.item)
    if (issueDetails && todo.ref?.startsWith('#')) {
      records.enrichWithIssueDetails(Number(todo.ref.slice(1)), issueDetails, todoId)
    }
    const updated = store.update(current.storeIndex, { status: 'active', difficulty, branch: branchName })
    if (!updated) throw new Error(`Failed to update todo ${todoId}.`)
    return { updated, branchName }
  })

  let claimInfo = ''
  if (existingClaims.length > 0) {
    const claimLines = existingClaims.map(c =>
      `- @${c.user}: ${c.items.length > 0 ? c.items.join(', ') : 'claimed (no specific items)'}`,
    )
    claimInfo = `\n\n**Existing claims:**\n${claimLines.join('\n')}`
  }

  return [
    `Activated: **${updated.title}**${updated.ref ? ` (${updated.ref})` : ''} — difficulty: ${difficultyLabel(difficulty)} · branch: \`${branchName}\` · Todo ID: \`${todoId}\`${resolved.restored ? ' · restored from archive' : ''}${claimInfo}`,
    `Execution ${executionState.created ? 'created' : 'resumed'}: ${executionState.execution.id} · phase: ${executionState.execution.phase} · next: ${executionState.execution.next}`,
  ].join('\n')
}
