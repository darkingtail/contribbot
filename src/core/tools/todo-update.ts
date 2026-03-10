import { appendFileSync, existsSync } from 'node:fs'
import { TodoStore } from '../storage/todo-store.js'
import { RecordFiles } from '../storage/record-files.js'
import { TODO_STATUSES, validateEnum } from '../enums.js'
import type { TodoStatus } from '../enums.js'
import { getContribDir } from '../utils/config.js'
import { resolveRepo } from '../utils/resolve-repo.js'
import { todayDate } from '../utils/format.js'

export async function todoUpdate(
  item: string,
  fields: { status?: string; pr?: number; branch?: string; note?: string },
  repo?: string,
): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)
  const records = new RecordFiles(contribDir)

  const resolved = store.resolveItem(item)
  if (!resolved) {
    throw new Error(`Todo not found: "${item}". Use todo_list to see available items.`)
  }

  const { storeIndex } = resolved

  // Build update fields
  const updateFields: { status?: TodoStatus; pr?: number; branch?: string } = {}
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

  if (fields.branch !== undefined) {
    updateFields.branch = fields.branch
    changes.push(`branch → ${fields.branch}`)
  }

  // If status is provided, use it (overrides auto-set from pr)
  if (fields.status) {
    updateFields.status = validateEnum(TODO_STATUSES, fields.status, 'status')
    changes.push(`status → ${fields.status}`)
  }

  // Persist the update
  const updated = store.update(storeIndex, updateFields)
  if (!updated) {
    throw new Error(`Failed to update todo at index ${storeIndex}.`)
  }

  // If note is provided, append to record file
  if (fields.note && updated.ref) {
    const recordPath = records.resolveRefPath(updated.ref)
    if (recordPath && existsSync(recordPath)) {
      const today = todayDate()
      appendFileSync(recordPath, `\n\n> Note (${today}): ${fields.note}\n`, 'utf-8')
      changes.push(`note appended`)
    } else {
      changes.push(`note skipped (no record file — use todo_activate first)`)
    }
  }

  if (changes.length === 0) {
    return `No changes specified for: **${updated.title}**`
  }

  return `Updated **${updated.title}**: ${changes.join(', ')}`
}
