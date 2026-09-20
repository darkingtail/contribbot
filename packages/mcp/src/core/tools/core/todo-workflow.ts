import { applyHostCommand, executionContext } from '../../execution/local.js'
import { getContribDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { TodoStore } from '../../storage/todo-store.js'
import { todoConsultations } from '../../consult/projection.js'

export async function todoContext(repo: string, todoId: string, executionId?: string, repairDocument = false) {
  const canonical = await resolveRepo(repo)
  const directory = getContribDir(canonical.owner, canonical.name)
  // Validate the exact execution before performing even a derived-document write.
  const context = executionContext(directory, todoId, executionId)
  const repaired = repairDocument ? new TodoStore(directory).refreshRecord(todoId) : null
  return {
    ...(repaired ? executionContext(directory, todoId, executionId) : context),
    ...(repaired ? { document_projection: repaired } : {}),
    repo: `${canonical.owner}/${canonical.name}`,
    consultations: todoConsultations(directory, todoId),
  }
}

export async function todoWorkflowCommand(
  repo: string,
  kind: 'plan' | 'operation' | 'control',
  input: { todo_id: string; execution_id: string; request_id: string; expected_revision: number; command: Record<string, unknown> },
) {
  const allowed = kind === 'plan' ? ['propose_plan', 'confirm_plan']
    : kind === 'control' ? ['request_control'] : ['begin_operation', 'return_operation', 'adopt_operation', 'mark_unknown']
  if (!allowed.includes(String(input.command.action))) throw new Error(`Unsupported ${kind} action.`)
  const canonical = await resolveRepo(repo)
  const directory = getContribDir(canonical.owner, canonical.name)
  const workflow = applyHostCommand(directory, input)
  const context = executionContext(directory, input.todo_id, input.execution_id)
  return { schema_version: 1 as const, repo: `${canonical.owner}/${canonical.name}`, todo_id: input.todo_id, execution_id: input.execution_id,
    workflow, document_projection: context.document_projection }
}
