import { UpstreamStore } from '../../storage/upstream-store.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { repositoryDisplay, repositoryRefSchema, type RepositoryInput, type RepositoryRef } from '../../utils/repository-ref.js'

export async function upstreamCompact(
  upstreamRepo: RepositoryRef,
  before?: string,
  keep?: number,
  repo?: RepositoryInput,
): Promise<string> {
  const source = repositoryRefSchema.parse(upstreamRepo)
  const label = repositoryDisplay(source)
  const { repository, directory: contribDir } = await resolveRepo(repo)
  const target = repositoryDisplay(repository)
  const store = new UpstreamStore(contribDir)

  if (before && keep !== undefined) {
    throw new Error('Cannot use both "before" and "keep" — they are mutually exclusive.')
  }

  // No params — show stats
  if (!before && keep === undefined) {
    const stats = store.getDailyStats(source)
    const archiveStats = store.getArchiveStats(source)
    if (stats.total === 0 && archiveStats.total === 0) {
      return `No daily commits for ${label} in ${target}. Nothing to compact.`
    }
    return [
      `## Daily Commits — ${label} (${target})`,
      '',
      `> Active: ${stats.total} total · ${stats.pending} pending · ${stats.processed} processed · oldest: ${stats.oldest ?? '—'}`,
      `> Archived: ${archiveStats.total} commits${archiveStats.oldest ? ` · oldest: ${archiveStats.oldest}` : ''}`,
      '',
      'Use `before` (date) or `keep` (count) to compact processed commits:',
      `- \`upstream_compact(repo=${JSON.stringify(repository)}, upstream_repo=${JSON.stringify(source)}, before="2025-01-01")\` — move older processed commits to archive`,
      `- \`upstream_compact(repo=${JSON.stringify(repository)}, upstream_repo=${JSON.stringify(source)}, keep=100)\` — keep the latest 100 processed commits`,
    ].join('\n')
  }

  const result = store.compactDaily(source, { before, keep })
  return `Compacted daily commits for ${label}: archived ${result.removed}, remaining ${result.remaining} active.`
}
