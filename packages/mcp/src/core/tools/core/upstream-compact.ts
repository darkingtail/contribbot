import { UpstreamStore } from '../../storage/upstream-store.js'
import { getContribDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'

export async function upstreamCompact(
  upstreamRepo: string,
  before?: string,
  keep?: number,
  repo?: string,
): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new UpstreamStore(contribDir)

  if (before && keep !== undefined) {
    throw new Error('Cannot use both "before" and "keep" — they are mutually exclusive.')
  }

  // No params — show stats
  if (!before && keep === undefined) {
    const stats = store.getDailyStats(upstreamRepo)
    if (stats.total === 0) {
      return `No daily commits for ${upstreamRepo} in ${owner}/${name}. Nothing to compact.`
    }
    return [
      `## Daily Commits — ${upstreamRepo} (${owner}/${name})`,
      '',
      `> ${stats.total} total · ${stats.pending} pending · ${stats.processed} processed · oldest: ${stats.oldest ?? '—'}`,
      '',
      'Use `before` (date) or `keep` (count) to compact processed commits:',
      '- `upstream_compact(before="2025-01-01")` — remove processed commits before this date',
      '- `upstream_compact(keep=100)` — keep only the latest 100 processed commits',
    ].join('\n')
  }

  const result = store.compactDaily(upstreamRepo, { before, keep })
  return `Compacted daily commits for ${upstreamRepo}: removed ${result.removed} processed, remaining ${result.remaining} total.`
}
