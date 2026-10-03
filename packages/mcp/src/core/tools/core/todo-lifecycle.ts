import { createHash } from 'node:crypto'
import { z } from 'zod'
import { currentTodoExecution, isTerminalTodo, TodoStore } from '../../storage/todo-store.js'
import type { TodoItem } from '../../storage/todo-store.js'
import { unresolvedOperations } from '../../execution/workflow.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import type { RepositoryInput } from '../../utils/repository-ref.js'

export const archiveSelectionSchema = z.object({
  todo_id: z.string().min(1),
  snapshot: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type ArchiveSelection = z.infer<typeof archiveSelectionSchema>

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function todoArchiveSnapshot(todo: TodoItem): string {
  const { archived: _archived, pending_transition: _pending, ...content } = todo as TodoItem & { archived?: string }
  return createHash('sha256').update(canonical(content)).digest('hex')
}

function assertSettledTerminal(todo: TodoItem): void {
  if (!isTerminalTodo(todo) || currentTodoExecution(todo)) throw new Error('Only an ended Todo with no open execution can be archived.')
  for (const execution of todo.executions) {
    const state = execution.workflow
    if (state && (!state.closure || state.closing_id || unresolvedOperations(state).length)) {
      throw new Error('Managed execution has unresolved work or closure; reconcile it before archival.')
    }
  }
}

const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')

export async function archiveTodos(repo?: RepositoryInput, selections?: ArchiveSelection[], prepare = false): Promise<string> {
  const { directory } = await resolveRepo(repo)
  const store = new TodoStore(directory)
  if (prepare && selections !== undefined) throw new Error('Prepare identities and confirm archival in separate calls.')
  if (selections === undefined) {
    return store.transaction(() => {
      const archived = store.listArchived()
      if (prepare) {
        for (const [index, todo] of store.list().entries()) {
          if (!isTerminalTodo(todo) || todo.id || todo.pending_transition) continue
          assertSettledTerminal(todo)
          store.ensureTodoId(index)
        }
      }
      const lines = ['## Archive Preview', '', '| Todo ID | Title | Status | Snapshot | Note |', '| --- | --- | --- | --- | --- |']
      const eligible: ArchiveSelection[] = []
      for (const todo of store.list().filter(isTerminalTodo)) {
        let note = 'Not archived; requires explicit selection.'
        let snapshot = ''
        try {
          assertSettledTerminal(todo)
          if (todo.pending_transition || archived.some(item => item.id === todo.id && todo.id)) {
            note = 'Pending transition; reconcile the original request, do not start new archival.'
          }
          else if (!todo.id) note = 'Legacy identity missing. Use prepare=true, then review the new preview.'
          else {
            snapshot = todoArchiveSnapshot(todo)
            eligible.push({ todo_id: todo.id, snapshot })
          }
        }
        catch (error) { note = (error as Error).message }
        lines.push(`| ${todo.id ?? 'unassigned'} | ${cell(todo.title)} | ${todo.status} | ${snapshot || '-'} | ${note} |`)
      }
      lines.push('', 'Pass only the entries explicitly selected by the user as selections. No archival was performed.',
        '```json', JSON.stringify(eligible, null, 2), '```')
      return lines.join('\n')
    })
  }
  const selected = z.array(archiveSelectionSchema).max(1000).parse(selections)
  if (new Set(selected.map(item => item.todo_id)).size !== selected.length) throw new Error('Duplicate Todo selections.')
  const lines = ['## Archive Results', '', '| Todo ID | Result | Note |', '| --- | --- | --- |']
  for (const selection of selected) {
    try {
      const result = store.transaction(() => {
        const active = store.list().find(todo => todo.id === selection.todo_id)
        const archived = store.listArchived().find(todo => todo.id === selection.todo_id)
        const todo = active ?? archived
        if (!todo) throw new Error('Selected Todo no longer exists.')
        if (todo.pending_transition === 'restore') throw new Error('Restoration is pending; reconcile it first.')
        assertSettledTerminal(todo)
        if (todoArchiveSnapshot(todo) !== selection.snapshot) throw new Error('Todo changed after preview; review and confirm a new snapshot.')
        if (!active) return 'Already archived; no changes.'
        if (archived && todoArchiveSnapshot(archived) !== selection.snapshot) throw new Error('Archive conflicts with the selected snapshot.')
        store.archiveAndDelete(store.list().findIndex(item => item.id === selection.todo_id))
        return archived ? 'Reconciled partial archival.' : 'Archived; outcome and history preserved.'
      })
      lines.push(`| ${selection.todo_id} | success | ${result} |`)
    }
    catch (error) { lines.push(`| ${cell(selection.todo_id)} | failed | ${cell((error as Error).message)} |`) }
  }
  if (!selected.length) lines.push('', 'Empty selection; no changes.')
  return lines.join('\n')
}

export async function todoRestore(item: string, repo?: RepositoryInput): Promise<string> {
  const { directory } = await resolveRepo(repo)
  const store = new TodoStore(directory)
  return store.transaction(() => {
    if (store.resolveItemFromAll(item)?.id !== item) throw new Error('Exact stable Todo id required to restore.')
    const restored = store.restoreArchived(item)
    const current = restored ?? store.resolveItemById(item)
    if (!current || current.item.id !== item) throw new Error('Exact stable Todo id required to restore.')
    return `Visible: ${current.item.title} · status: ${current.item.status} · Todo ID: \`${item}\`. No execution started.`
  })
}

export async function todoReopen(item: string, repo?: RepositoryInput): Promise<string> {
  const { directory } = await resolveRepo(repo)
  const result = new TodoStore(directory).reopen(item)
  return `Reopened: ${result.item.title} · backlog · Todo ID: \`${item}\`. No execution started; use todo_activate when work begins.`
}

export async function todoCancel(repo: RepositoryInput, todoId: string, expectedLifecycleRevision: number, decision: string) {
  const { owner, name, directory } = await resolveRepo(repo)
  const todo = new TodoStore(directory).cancelTodo(todoId, expectedLifecycleRevision, decision)
  return { schema_version: 1 as const, repo: `${owner}/${name}`, todo_id: todoId, todo, archived: false }
}
