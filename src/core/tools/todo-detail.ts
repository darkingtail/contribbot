import { statSync } from 'node:fs'
import { parseRepo, getPullReviews } from '../clients/github.js'
import { TodoStore } from '../storage/todo-store.js'
import { RecordFiles } from '../storage/record-files.js'
import type { TodoItem } from '../storage/todo-store.js'
import { getContribDir } from '../utils/config.js'
import { todayDate } from '../utils/format.js'

function formatTodoBasicInfo(todo: TodoItem, owner: string, name: string): string {
  const lines: string[] = [
    `## ${todo.title}`,
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| Ref | ${todo.ref ?? '—'} |`,
    `| Type | ${todo.type} |`,
    `| Status | ${todo.status} |`,
    `| Difficulty | ${todo.difficulty ?? '—'} |`,
    `| PR | ${todo.pr ? `[#${todo.pr}](https://github.com/${owner}/${name}/pull/${todo.pr})` : '—'} |`,
    `| Created | ${todo.created} |`,
    `| Updated | ${todo.updated} |`,
    '',
    '_No record file found. Use issue_detail or upstream_sync_check with save option to create one._',
  ]
  return lines.join('\n')
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
  const { owner, name } = parseRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)
  const records = new RecordFiles(contribDir)

  // Use resolveItemFromAll to include done items
  const todo = store.resolveItemFromAll(item)

  if (!todo) {
    return `Todo not found: "${item}". Use \`todo_list\` to see available items.`
  }

  // If no ref, there's no record file
  if (!todo.ref) {
    return formatTodoBasicInfo(todo, owner, name)
  }

  // Read record file
  let content = records.readRecord(todo.ref)

  // If todo has a linked PR, handle auto-refresh of reviews
  if (todo.pr) {
    const prSection = `### PR #${todo.pr}`
    const filePath = records.resolveRefPath(todo.ref)

    const hasPRSection = content?.includes(prSection) ?? false
    const cacheStale = filePath ? isCacheStale(filePath) : true

    if (!hasPRSection || cacheStale) {
      try {
        const reviews = await getPullReviews(owner, name, todo.pr)
        const today = todayDate()

        const prReviews = reviews
          .filter(r => r.user && r.state !== 'PENDING')
          .map(r => ({
            user: r.user!.login,
            body: r.state,
          }))

        if (prReviews.length > 0) {
          records.appendPRFeedback(todo.ref, todo.pr, today, prReviews)
        }
      }
      catch {
        // API call failed, proceed with existing content
      }

      // Re-read after potential update
      content = records.readRecord(todo.ref)
    }
  }

  if (!content) {
    return formatTodoBasicInfo(todo, owner, name)
  }

  return content
}
