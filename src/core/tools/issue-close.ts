import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseRepo, closeIssue, createComment } from '../clients/github.js'
import { TodoStore } from '../storage/todo-store.js'

function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contribbot', owner, name)
}

export async function issueClose(
  issueNumber: number,
  comment?: string,
  todoItem?: string,
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)
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
    const allTodos = store.list()
    const openIndices: number[] = []
    allTodos.forEach((t, i) => {
      if (t.status !== 'done') openIndices.push(i)
    })

    const num = Number.parseInt(todoItem, 10)
    let targetIndex: number | undefined

    if (!Number.isNaN(num) && num >= 1 && num <= openIndices.length) {
      targetIndex = openIndices[num - 1]
    } else {
      targetIndex = openIndices.find(i =>
        allTodos[i].title.toLowerCase().includes(todoItem.toLowerCase()),
      )
    }

    if (targetIndex !== undefined) {
      store.update(targetIndex, { status: 'done' })
      results.push(`Marked todo as done: ${allTodos[targetIndex].title}`)
    }
  }

  return results.join('\n')
}
