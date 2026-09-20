import { z } from 'zod'

export const todoPullSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/)
    .refine(value => !['.', '..'].includes(value.split('/')[1]!)),
  number: z.number().int().positive().safe(),
}).strict()

export type TodoPull = z.infer<typeof todoPullSchema>
type PullCarrier = { pr: number | null; pull_requests?: TodoPull[] }

export function pullIdentity(pull: TodoPull): string {
  return `${pull.repo.toLowerCase()}#${pull.number}`
}

export function normalizeTodoPulls(value: unknown): TodoPull[] {
  const unique = new Map<string, TodoPull>()
  for (const pull of z.array(todoPullSchema).parse(value)) {
    unique.set(pullIdentity(pull), { ...pull, repo: pull.repo.toLowerCase() })
  }
  return [...unique.values()]
}

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
