import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseRepo, createPull } from '../clients/github.js'
import { TodoStore } from '../storage/todo-store.js'

function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contribbot', owner, name)
}

export async function prCreate(
  title: string,
  head: string,
  base?: string,
  body?: string,
  draft?: boolean,
  todoItem?: string,
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const pr = await createPull(owner, name, title, head, base ?? 'main', body, draft)
  const results: string[] = [
    `Created PR **${owner}/${name}#${pr.number}**: https://github.com/${owner}/${name}/pull/${pr.number}`,
  ]

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
      store.update(targetIndex, { pr: pr.number, status: 'pr_submitted' })
      results.push(`Linked todo: ${allTodos[targetIndex].title} → PR #${pr.number}`)
    }
  }

  return results.join('\n')
}
