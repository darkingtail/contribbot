import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, existsSync } from 'node:fs'
import { parseRepo } from '../clients/github.js'
import { TodoStore } from '../storage/todo-store.js'
import { RecordFiles } from '../storage/record-files.js'
import type { TodoStatus } from '../storage/todo-store.js'

function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contribbot', owner, name)
}

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

export function todoUpdate(
  item: string,
  fields: { status?: string; pr?: number; note?: string },
  repo?: string,
): string {
  const { owner, name } = parseRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)

  const allTodos = store.list()

  // Only consider open todos (not done)
  const openIndices: number[] = []
  allTodos.forEach((t, i) => {
    if (t.status !== 'done') openIndices.push(i)
  })

  if (openIndices.length === 0) {
    return 'Error: No open todos found.'
  }

  // Resolve item: 1-based index among open todos, or text substring match
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

  // Build update fields
  const updateFields: { status?: TodoStatus; pr?: number } = {}
  const changes: string[] = []

  // If pr is provided, set it and auto-set status to pr_submitted (unless explicit status given)
  if (fields.pr !== undefined) {
    updateFields.pr = fields.pr
    changes.push(`PR → #${fields.pr}`)

    if (!fields.status) {
      updateFields.status = 'pr_submitted'
      changes.push(`status → pr_submitted`)
    }
  }

  // If status is provided, use it (overrides auto-set from pr)
  if (fields.status) {
    updateFields.status = fields.status as TodoStatus
    changes.push(`status → ${fields.status}`)
  }

  // Persist the update
  const updated = store.update(targetStoreIndex, updateFields)
  if (!updated) {
    return `Error: Failed to update todo at index ${targetStoreIndex}.`
  }

  // If note is provided and a record file exists, append it
  if (fields.note && updated.ref) {
    const recordPath = resolveRecordFilePath(contribDir, updated.ref)
    if (recordPath && existsSync(recordPath)) {
      const today = new Date().toISOString().slice(0, 10)
      appendFileSync(recordPath, `\n\n> Note (${today}): ${fields.note}\n`, 'utf-8')
      changes.push(`note appended`)
    }
  }

  if (changes.length === 0) {
    return `No changes specified for: **${updated.title}**`
  }

  return `Updated **${updated.title}**: ${changes.join(', ')}`
}
