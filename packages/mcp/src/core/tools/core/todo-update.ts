import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { TodoStore } from '../../storage/todo-store.js'
import { RecordFiles } from '../../storage/record-files.js'
import { TODO_UPDATABLE_STATUSES, validateEnum } from '../../enums.js'
import { getContribDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { todayDate } from '../../utils/format.js'
import { linkTodoPull } from '../../storage/todo-pulls.js'

function noteMarker(ref: string, note: string): string {
  const digest = createHash('sha256').update(`${ref}\0${note}`).digest('hex').slice(0, 16)
  return `<!-- contribbot:todo-note ${digest} -->`
}

export async function todoUpdate(
  item: string,
  fields: { status?: string; pr?: number; branch?: string; note?: string },
  repo?: string,
): Promise<string> {
  if (fields.status === 'done') {
    throw new Error('Use todo_done to close the execution and complete the Todo without archiving.')
  }
  const status = fields.status === undefined ? undefined : validateEnum(TODO_UPDATABLE_STATUSES, fields.status, 'status')
  const { owner, name } = await resolveRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)
  const records = new RecordFiles(contribDir)

  return store.transaction(() => {
    let resolved = store.resolveItem(item)
    if (!resolved) {
      throw new Error(`Todo not found: "${item}". Use todo_list to see available items.`)
    }
    if (fields.note && !resolved.item.ref) {
      throw new Error(`Todo "${resolved.item.title}" has no ref-backed record. Use todo_progress evidence or assign a ref before adding a note.`)
    }

    const { storeIndex } = resolved
    if (!resolved.item.id && resolved.item.ref && store.hasArchivedRef(resolved.item.ref)) {
      const identified = store.ensureTodoId(storeIndex)
      if (!identified) throw new Error(`Failed to assign a stable id to todo "${item}" before update.`)
      resolved = { ...resolved, item: identified }
    }

    // Build update fields
    const updateFields: Parameters<TodoStore['update']>[1] = {}
    const changes: string[] = []

    // Association is metadata, not a lifecycle transition or acceptance result.
    if (fields.pr !== undefined) {
      Object.assign(updateFields, linkTodoPull(resolved.item, `${owner}/${name}`, fields.pr))
      changes.push(`PR → #${fields.pr}`)
    }

    if (fields.branch !== undefined) {
      updateFields.branch = fields.branch
      changes.push(`branch → ${fields.branch}`)
    }

    // Explicit lifecycle decisions still pass the existing storage gates.
    if (status !== undefined) {
      updateFields.status = status
      changes.push(`status → ${fields.status}`)
    }

    const updated = store.update(storeIndex, updateFields)
    if (!updated) {
      throw new Error(`Failed to update todo at index ${storeIndex}.`)
    }

    // If note is provided, append to record file (auto-create if missing)
    if (fields.note && updated.ref) {
      const recordPath = records.ensureTodoRecord(
        updated.ref,
        updated.title,
        updated.type,
        todayDate(),
        updated.id,
        { adoptUnowned: Boolean(updated.id) && !store.hasArchivedRef(updated.ref, updated.id) },
      )
      if (fields.note) {
        const today = todayDate()
        const marker = noteMarker(updated.ref, fields.note)
        if (!readFileSync(recordPath, 'utf-8').includes(marker)) {
          appendFileSync(recordPath, `\n\n> Note (${today}): ${fields.note}\n${marker}\n`, 'utf-8')
          changes.push(`note appended`)
        }
        else {
          changes.push('note already recorded')
        }
      }
    }

    if (changes.length === 0) {
      return `No changes specified for: **${updated.title}**`
    }

    return `Updated **${updated.title}**: ${changes.join(', ')}`
  })
}
