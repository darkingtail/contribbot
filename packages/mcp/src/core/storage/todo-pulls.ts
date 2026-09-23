import { normalizeTodoPulls, pullIdentity, todoPullSchema } from 'contribbot-core/todo/pulls'
import type { TodoPull } from 'contribbot-core/todo/pulls'
export { normalizeTodoPulls, pullIdentity, todoPullSchema } from 'contribbot-core/todo/pulls'
export type { TodoPull } from 'contribbot-core/todo/pulls'
type PullCarrier = { pr: number | null; pull_requests?: TodoPull[] }

// Legacy scalar PRs belong to the explicit canonical project, never its fork.
export function todoPulls(todo: PullCarrier, repo: string): TodoPull[] {
  const pulls = normalizeTodoPulls(todo.pull_requests ?? [])
  if (Number.isSafeInteger(todo.pr) && todo.pr! > 0) {
    const legacy = todoPullSchema.parse({ repo, number: todo.pr })
    if (!pulls.some(pull => pullIdentity(pull) === pullIdentity(legacy))) {
      pulls.push({ ...legacy, repo: legacy.repo.toLowerCase() })
    }
  }
  return pulls
}

export function linkTodoPull(todo: PullCarrier, repo: string, number: number): { pr: number; pull_requests: TodoPull[] } {
  const pull = todoPullSchema.parse({ repo, number })
  return { pr: number, pull_requests: normalizeTodoPulls([...todoPulls(todo, repo), pull]) }
}

export function formatTodoPullLinks(todo: PullCarrier, repo: string): string {
  return todoPulls(todo, repo).map(pull =>
    `[${pull.repo.toLowerCase() === repo.toLowerCase() ? '' : pull.repo}#${pull.number}](https://github.com/${pull.repo}/pull/${pull.number})`,
  ).join(', ') || '—'
}
