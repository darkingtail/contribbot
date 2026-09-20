import { TodoStore } from '../../storage/todo-store.js'
import type { TodoEvidence, TodoExecutionProgress } from '../../storage/todo-store.js'
import type { TodoExecutionPhase } from '../../enums.js'
import { getContribDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'

export interface TodoProgressFields {
  phase?: TodoExecutionPhase
  next?: string
  blocked_on?: string | null
  evidence?: TodoEvidence[]
}

export async function todoProgress(item: string, fields: TodoProgressFields, repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const store = new TodoStore(getContribDir(owner, name))
  return store.transaction(() => {
    const resolved = store.resolveItem(item)
    if (!resolved) throw new Error(`Todo not found: "${item}". Use todo_list to see available items.`)

    const execution = store.progressExecution(resolved.storeIndex, fields as TodoExecutionProgress)
    return [
      `Updated execution for **${resolved.item.title}**${resolved.item.ref ? ` (${resolved.item.ref})` : ''}:`,
      `- Phase → ${execution.phase}`,
      `- Next → ${execution.next}`,
      `- Blocked on → ${execution.blocked_on ?? '—'}`,
      `- Evidence → ${execution.evidence.length} item(s)`,
    ].join('\n')
  })
}
