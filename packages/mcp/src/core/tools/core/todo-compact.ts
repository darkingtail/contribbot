import { TodoStore } from '../../storage/todo-store.js'
import { getContribDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'

export async function todoCompact(
  before?: string,
  keep?: number,
  repo?: string,
): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)

  if (before && keep !== undefined) {
    throw new Error('Cannot use both "before" and "keep" — they are mutually exclusive.')
  }

  // No params — show archive stats
  if (!before && keep === undefined) {
    const archived = store.listArchived()
    if (archived.length === 0) {
      return `Archive is empty for ${owner}/${name}. Nothing to compact.`
    }
    const oldest = archived[0]?.archived ?? '—'
    const newest = archived[archived.length - 1]?.archived ?? '—'
    return [
      `## Archive — ${owner}/${name}`,
      '',
      `> ${archived.length} items · oldest: ${oldest} · newest: ${newest}`,
      '',
      'Use `before` (date) or `keep` (count) to compact:',
      '- `todo_compact(before="2025-01-01")` — remove entries before this date',
      '- `todo_compact(keep=50)` — keep only the latest 50 entries',
    ].join('\n')
  }

  const result = store.compact({ before, keep })
  return `Compacted archive for ${owner}/${name}: removed ${result.removed}, remaining ${result.remaining}.`
}
