import { closeIssue, createComment } from '../../clients/github.js'
import { TodoStore } from '../../storage/todo-store.js'
import { getContribDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'

export async function issueClose(
  issueNumber: number,
  comment?: string,
  todoItem?: string,
  repo?: string,
): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const results: string[] = []

  if (comment) {
    await createComment(owner, name, issueNumber, comment)
    results.push(`Added comment to #${issueNumber}`)
  }

  await closeIssue(owner, name, issueNumber)
  results.push(`Closed **${owner}/${name}#${issueNumber}**`)

  if (todoItem) {
    const contribDir = getContribDir(owner, name)
    const store = new TodoStore(contribDir)

    const resolved = store.resolveItem(todoItem)
    if (resolved) {
      const archived = store.archiveAndDelete(resolved.storeIndex)
      if (archived) {
        results.push(`Done & archived todo: ${archived.title}`)
      }
    }
  }

  return results.join('\n')
}
