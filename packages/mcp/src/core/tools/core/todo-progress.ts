import { TodoStore } from '../../storage/todo-store.js'
import type { TodoEvidence, TodoExecutionProgress } from '../../storage/todo-store.js'
import type { TodoExecutionPhase } from '../../enums.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import type { RepositoryInput } from '../../utils/repository-ref.js'

export interface TodoProgressFields {
  phase?: TodoExecutionPhase
  next?: string
  blocked_on?: string | null
  evidence?: TodoEvidence[]
}

export async function todoProgress(item: string, fields: TodoProgressFields, repo?: RepositoryInput): Promise<string> {
  const { directory } = await resolveRepo(repo)
  const store = new TodoStore(directory)
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
