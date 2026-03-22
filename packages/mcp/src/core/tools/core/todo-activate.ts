import { existsSync } from 'node:fs'
import { getIssue, getIssueComments } from '../../clients/github.js'
import { RecordFiles } from '../../storage/record-files.js'
import { TodoStore } from '../../storage/todo-store.js'
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

export async function todoActivate(item: string, branch?: string, repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)
  const records = new RecordFiles(contribDir)

  const resolved = store.resolveItem(item)
  if (!resolved) {
    throw new Error(`Todo not found: "${item}". Use todo_list to see available items.`)
  }

  const { storeIndex, item: todo } = resolved
  let difficulty: TodoDifficulty = 'medium'
  let existingClaims: { user: string; items: string[] }[] = []

  // Ensure record file exists (may be missing for old todos created before todo_add auto-creation)
  if (todo.ref) {
    const recordPath = records.resolveRefPath(todo.ref)
    if (recordPath && !existsSync(recordPath)) {
      records.createTodoRecord(todo.ref, todo.title, todo.type, todayDate())
    }
  }

  if (todo.ref && todo.ref.startsWith('#')) {
    const issueNumber = Number.parseInt(todo.ref.slice(1), 10)

    try {
      const [issue, comments] = await Promise.all([
        getIssue(owner, name, issueNumber),
        getIssueComments(owner, name, issueNumber),
      ])

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

      const commentsSummary = comments
        .map((c) => {
          const user = c.user?.login ?? 'unknown'
          const body = c.body.replace(/\r?\n/g, ' ').slice(0, 100)
          return `- @${user}: ${body}`
        })
        .join('\n')

      // Detect existing claims from contribbot:claim markers
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

      records.enrichWithIssueDetails(issueNumber, {
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
      const message = err instanceof Error ? err.message : String(err)
      const updated = store.update(storeIndex, { status: 'active', difficulty })
      if (!updated) {
        throw new Error(`Failed to update todo at index ${storeIndex}.`)
      }
      return `Activated: **${updated.title}** (difficulty: ${difficulty}) — ⚠️ GitHub fetch failed: ${message}`
    }
  }

  // Use provided branch name or generate default (no remote branch creation)
  const branchName = branch ?? generateDefaultBranchName(todo)

  const updated = store.update(storeIndex, { status: 'active', difficulty, branch: branchName })
  if (!updated) {
    throw new Error(`Failed to update todo at index ${storeIndex}.`)
  }

  let claimInfo = ''
  if (existingClaims.length > 0) {
    const claimLines = existingClaims.map(c =>
      `- @${c.user}: ${c.items.length > 0 ? c.items.join(', ') : 'claimed (no specific items)'}`,
    )
    claimInfo = `\n\n**Existing claims:**\n${claimLines.join('\n')}`
  }

  return `Activated: **${updated.title}**${updated.ref ? ` (${updated.ref})` : ''} — difficulty: ${difficultyLabel(difficulty)} · branch: \`${branchName}\`${claimInfo}`
}
