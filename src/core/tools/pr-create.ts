import { parseRepo, createPull } from '../clients/github.js'
import { TodoStore } from '../storage/todo-store.js'
import { getContribDir } from '../utils/config.js'

export async function prCreate(
  title: string,
  head?: string,
  base?: string,
  body?: string,
  draft?: boolean,
  todoItem?: string,
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)

  // Resolve todo first — may provide branch for head
  let resolved: ReturnType<TodoStore['resolveItem']> | undefined
  if (todoItem) {
    resolved = store.resolveItem(todoItem)
  }

  // Auto-fill head from todo branch if not provided
  let effectiveHead = head
  if (!effectiveHead && resolved?.item.branch) {
    // For cross-repo PRs, prefix with fork owner
    const { RepoConfig } = await import('../storage/repo-config.js')
    const config = new RepoConfig(contribDir)
    const repoConfig = config.load()
    if (repoConfig?.fork) {
      const forkOwner = parseRepo(repoConfig.fork).owner
      effectiveHead = `${forkOwner}:${resolved.item.branch}`
    } else {
      effectiveHead = resolved.item.branch
    }
  }

  if (!effectiveHead) {
    return 'Error: `head` branch is required. Provide it explicitly or link a todo with a branch.'
  }

  const pr = await createPull(owner, name, title, effectiveHead, base ?? 'main', body, draft)
  const results: string[] = [
    `Created PR **${owner}/${name}#${pr.number}**: https://github.com/${owner}/${name}/pull/${pr.number}`,
  ]

  if (resolved) {
    store.update(resolved.storeIndex, { pr: pr.number, status: 'pr_submitted' })
    results.push(`Linked todo: ${resolved.item.title} → PR #${pr.number}`)
  }

  return results.join('\n')
}
