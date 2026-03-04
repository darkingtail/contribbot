import { homedir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { parseRepo, getPullReviews } from '../clients/github.js'
import { TodoStore } from '../storage/todo-store.js'
import { RecordFiles } from '../storage/record-files.js'
import type { TodoItem } from '../storage/todo-store.js'

function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contribbot', owner, name)
}

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

function resolveRecordFilePath(baseDir: string, ref: string): string | null {
  if (ref.startsWith('#')) {
    const num = ref.slice(1)
    return join(baseDir, 'todos', `${num}.md`)
  }
  const atIndex = ref.indexOf('@')
  if (atIndex !== -1) {
    const repo = ref.slice(0, atIndex)
    const version = ref.slice(atIndex + 1)
    const [owner, repoName] = repo.split('/')
    return join(baseDir, 'upstream', owner, repoName, `${version}.md`)
  }
  // Custom slug → todos/{ref}.md
  return join(baseDir, 'todos', `${ref}.md`)
}

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

  // All todos sorted (same as todoList)
  const allTodos = store.listSorted()

  if (allTodos.length === 0) {
    return `No todos found for ${owner}/${name}. Use \`todo_add\` to create one.`
  }

  // Resolve item: 1-based index or text substring match
  let todo: TodoItem | undefined
  const num = Number.parseInt(item, 10)

  if (!Number.isNaN(num) && num >= 1 && num <= allTodos.length) {
    todo = allTodos[num - 1]
  }
  else {
    todo = allTodos.find(t => t.title.toLowerCase().includes(item.toLowerCase()))
  }

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
    const filePath = resolveRecordFilePath(contribDir, todo.ref)

    const hasPRSection = content?.includes(prSection) ?? false
    const cacheStale = filePath ? isCacheStale(filePath) : true

    if (!hasPRSection || cacheStale) {
      try {
        const reviews = await getPullReviews(owner, name, todo.pr)
        const today = new Date().toISOString().slice(0, 10)

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
