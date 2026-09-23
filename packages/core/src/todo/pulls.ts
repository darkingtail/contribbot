import { z } from 'zod'

export const todoPullSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/)
    .refine(value => !['.', '..'].includes(value.split('/')[1]!)),
  number: z.number().int().positive().safe(),
}).strict()

export type TodoPull = z.infer<typeof todoPullSchema>

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
