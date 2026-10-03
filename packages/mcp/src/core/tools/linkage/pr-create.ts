import { createPull, getRepoPulls } from '../../clients/github.js'
import { RecordFiles } from '../../storage/record-files.js'
import { currentTodoExecution, isTerminalTodo, TodoStore } from '../../storage/todo-store.js'
import { todayDate } from '../../utils/format.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import type { RepositoryInput } from '../../utils/repository-ref.js'
import { assertDispatchAllowed } from '../../execution/workflow.js'
import { RemoteEffects } from '../../storage/remote-effects.js'
import type { RemoteEffectRequest } from '../../storage/remote-effects.js'
import { isDeepStrictEqual } from 'node:util'
import { linkTodoPull } from '../../storage/todo-pulls.js'
import { sameRepository } from '../../utils/repository-ref.js'

export async function prCreate(
  title: string,
  head?: string,
  base?: string,
  body?: string,
  draft?: boolean,
  todoItem?: string,
  repo?: RepositoryInput,
): Promise<string> {
  const { owner, name, directory: contribDir, repository } = await resolveRepo(repo)
  if (repository.platform !== 'github' || repository.instance !== 'https://github.com') {
    throw new Error('pr_create supports GitHub.com repositories only; no remote changes were attempted.')
  }
  const store = new TodoStore(contribDir)

  // Resolve todo first — may provide branch for head
  let resolved: ReturnType<TodoStore['resolveItem']> | undefined
  let linkedTodo: { id: string; executionId: string | null } | undefined
  if (todoItem) {
    resolved = store.transaction(() => {
      const selected = store.resolveItem(todoItem)
      if (!selected) throw new Error(`Todo not found: "${todoItem}". Use todo_list to see available items.`)
      const identified = store.ensureTodoId(selected.storeIndex)
      if (!identified?.id) throw new Error(`Failed to assign a stable id to todo "${todoItem}".`)
      if (identified.ref) {
        new RecordFiles(contribDir).ensureTodoRecord(
          identified.ref,
          identified.title,
          identified.type,
          todayDate(),
          identified.id,
          { adoptUnowned: !store.hasArchivedRef(identified.ref, identified.id) },
        )
      }
      return { storeIndex: selected.storeIndex, item: identified }
    })
    linkedTodo = {
      id: resolved.item.id!,
      executionId: currentTodoExecution(resolved.item)?.id ?? null,
    }
  }

  // A Todo branch belongs to the managed repository; never infer a fork from parent.
  let effectiveHead = head
  if (!effectiveHead && resolved?.item.branch) {
    effectiveHead = resolved.item.branch
  }

  if (!effectiveHead) {
    throw new Error('`head` branch is required. Provide it explicitly or link a todo with a branch.')
  }

  const effects = linkedTodo ? new RemoteEffects(contribDir, linkedTodo.id) : null
  const request: RemoteEffectRequest = {
    kind: 'pr', repo: repository, execution_id: linkedTodo?.executionId ?? null,
    payload: { title, head: effectiveHead, base: base ?? 'main', body: body ?? '', draft: draft ?? false },
  }
  const submitted = store.transaction(() => {
    if (linkedTodo && effects) {
      const existing = effects.find(request) ?? effects.list().find(effect => effect.state !== 'linked'
        && effect.request.kind === 'pr' && sameRepository(effect.request.repo, request.repo)
        && isDeepStrictEqual(effect.request.payload, request.payload))
      if (existing) return { effect: existing }
      const current = store.resolveItemById(linkedTodo.id)?.item
      if (!current || (currentTodoExecution(current)?.id ?? null) !== linkedTodo.executionId) throw new Error('Linked Todo changed before PR submission.')
      const state = currentTodoExecution(current)?.workflow
      if (state) assertDispatchAllowed(state)
      if (isTerminalTodo(current)) throw new Error('Reopen the terminal Todo before new PR submission.')
      const effect = effects.reserve(request)
      const markedBody = `${body ?? ''}\n\n<!-- contribbot:pr-op ${effect.id} -->`.trim()
      return { effect, result: createPull(owner, name, title, effectiveHead!, base ?? 'main', markedBody, draft) }
    }
    return { result: createPull(owner, name, title, effectiveHead!, base ?? 'main', body, draft) }
  })
  let number: number
  if (submitted.result) {
    const pr = await submitted.result
    number = pr.number
    if (submitted.effect) {
      try { effects!.receive(submitted.effect.id, number, pr as unknown as Record<string, unknown>) }
      catch (error) { throw new Error(`PR ${owner}/${name}#${number} was created, but its receipt could not be saved: ${String(error)}. Recover the original request; do not create another PR.`) }
    }
  }
  else {
    const effect = submitted.effect!
    if (effect.receipt) number = effect.receipt.number
    else {
      const pulls = await getRepoPulls(owner, name, 'all', 100)
      const matches = pulls.filter(pull => pull.body?.includes(`<!-- contribbot:pr-op ${effect.id} -->`))
      if (matches.length !== 1) throw new Error(`PR request ${effect.id} remains unresolved. Recover the original remote result; no new PR was dispatched. An absent or ambiguous marker is not proof that no effect occurred.`)
      const original = matches[0]!
      number = original.number
      effects!.receive(effect.id, number, original as unknown as Record<string, unknown>)
    }
  }
  const results: string[] = [
    `${submitted.result ? 'Created' : 'Recovered'} PR **${owner}/${name}#${number}**: https://github.com/${owner}/${name}/pull/${number}`,
  ]

  if (linkedTodo) {
    const identity = linkedTodo
    try {
      const updated = store.transaction(() => {
        const current = store.resolveItemById(identity.id)
        if (!current) throw new Error(`linked todo ${identity.id} changed or was removed`)
        if (effects!.list().find(effect => effect.id === submitted.effect!.id)?.state === 'linked') return current.item
        const updated = store.update(current.storeIndex, linkTodoPull(current.item, repository, number))
        if (!updated) throw new Error(`linked todo ${identity.id} could not be updated`)
        effects!.linked(submitted.effect!.id)
        return updated
      })
      results.push(`Linked todo: ${updated.title} → PR #${number}`)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `PR ${owner}/${name}#${number} was created, but local linkage failed: ${message}. `
        + `Retry the exact original pr_create request to recover its saved receipt and linkage without creating another PR. `
        + `Todo ID ${linkedTodo.id}; todo_update(pr=${number}) alone does not settle the pending effect.`,
      )
    }
  }

  return results.join('\n')
}
