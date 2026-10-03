import { z } from 'zod'
import { repositoryIdentityKey, repositoryRefSchema } from '../repository/ref.js'

export const todoPullSchema = z.object({
  repo: repositoryRefSchema,
  number: z.number().int().positive().safe(),
}).strict()

export type TodoPull = z.infer<typeof todoPullSchema>

export function pullIdentity(pull: TodoPull): string {
  return JSON.stringify([repositoryIdentityKey(pull.repo), pull.number])
}

export function normalizeTodoPulls(value: unknown): TodoPull[] {
  const unique = new Map<string, TodoPull>()
  for (const pull of z.array(todoPullSchema).parse(value)) {
    unique.set(pullIdentity(pull), pull)
  }
  return [...unique.values()]
}
