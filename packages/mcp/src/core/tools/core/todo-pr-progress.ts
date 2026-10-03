import { getPull } from '../../clients/github.js'
import { pullIdentity, todoPulls } from '../../storage/todo-pulls.js'
import type { TodoPull } from '../../storage/todo-pulls.js'
import type { TodoItem } from '../../storage/todo-store.js'
import { repositoryDisplay, repositoryWebUrl, type RepositoryRef } from '../../utils/repository-ref.js'

interface PullObservation {
  progress: 'draft' | 'open' | 'closed' | 'merged' | 'unknown'
  observed_at: string
}

export async function observeTodoPulls(pulls: TodoPull[]): Promise<Map<string, PullObservation>> {
  const observations = new Map<string, PullObservation>()
  // Display only: cap each request to avoid unbounded GitHub work for old histories.
  const pending = pulls.slice(0, 20)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (next < pending.length) {
      const pull = pending[next++]!
      let progress: PullObservation['progress'] = 'unknown'
      try {
        if (pull.repo.platform !== 'github' || pull.repo.instance !== 'https://github.com') {
          throw new Error('Unsupported pull request platform.')
        }
        const [owner, name] = pull.repo.path.split('/') as [string, string]
        const remote = await getPull(owner, name, pull.number)
        if (remote.number === pull.number && typeof remote.merged === 'boolean'
          && typeof remote.draft === 'boolean' && ['open', 'closed'].includes(remote.state)) {
          progress = remote.merged ? 'merged' : remote.state === 'closed' ? 'closed' : remote.draft ? 'draft' : 'open'
        }
      }
      catch {
        // Do not expose raw errors, credentials, or private-repository existence.
      }
      observations.set(pullIdentity(pull), { progress, observed_at: new Date().toISOString() })
    }
  }))
  return observations
}

export function formatTodoPullProgress(todo: TodoItem, repo: RepositoryRef, observations: Map<string, PullObservation>): string {
  const pulls = todoPulls(todo, repo)
  const lines = ['## Linked PR Progress', '',
    'Read-only observations, not acceptance evidence or a Todo completion decision.',
    'Only explicit links are shown; none is automatically a required deliverable.', '',
    '| Repository | PR | Progress | Observed / attempted at | Source | Note |',
    '| --- | --- | --- | --- | --- | --- |']
  if (!pulls.length) return '## Linked PR Progress\n\n_No linked PRs; a PR is not required for every Todo._'
  for (const pull of pulls) {
    const observed = observations.get(pullIdentity(pull))
    const legacy = !todo.pull_requests?.some(stored => pullIdentity(stored) === pullIdentity(pull))
    const note = observed?.progress === 'unknown' ? 'Read unavailable or invalid; not a closed/merged conclusion'
      : !observed ? 'Not read in this snapshot (new link or 20-PR read limit)'
        : 'Historical remote observation; no lifecycle change'
    const label = repositoryDisplay(pull.repo)
    const pr = pull.repo.platform === 'github' && pull.repo.instance === 'https://github.com'
      ? `[#${pull.number}](${repositoryWebUrl(pull.repo)}/pull/${pull.number})`
      : `#${pull.number}`
    lines.push(`| ${label} | ${pr} | ${observed?.progress ?? 'unknown'} | ${observed?.observed_at ?? '—'} | ${observed ? 'GitHub read' : 'Not read'} | ${legacy ? 'Legacy scalar association; ' : ''}${note} |`)
  }
  return lines.join('\n')
}
