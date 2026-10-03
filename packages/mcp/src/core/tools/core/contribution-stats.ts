import { parseRepo, getCurrentUser, searchIssues } from '../../clients/github.js'
import { markdownTable } from '../../utils/format.js'
import { repositoryDisplay, type RepositoryInput } from '../../utils/repository-ref.js'
import { listStoredProjects } from './project-list.js'

function listAllProjects(): string[] {
  return (listStoredProjects() ?? []).map(({ config }) => {
    const repository = config.repository
    if (repository.platform !== 'github' || repository.instance !== 'https://github.com') {
      throw new Error(`contribution_stats supports GitHub.com repositories only: ${repositoryDisplay(repository)}. No GitHub request was attempted.`)
    }
    return repository.path
  })
}

export async function contributionStats(
  days?: number,
  author?: string,
  repo?: RepositoryInput,
): Promise<string> {
  const effectiveDays = days ?? 7
  const since = new Date()
  since.setDate(since.getDate() - effectiveDays)
  const sinceStr = since.toISOString().slice(0, 10)

  let repos: string[]
  if (!repo) {
    repos = listAllProjects()
  } else {
    const { owner, name } = parseRepo(repo)
    repos = [`${owner}/${name}`]
  }

  if (repos.length === 0) {
    return 'Error: No projects found. Use contribbot tools first to track projects.'
  }

  let username = author
  if (!username) {
    const user = await getCurrentUser()
    username = user?.login
  }
  if (!username) {
    return 'Error: Could not determine GitHub username. Pass `author` parameter.'
  }

  interface RepoStats {
    repo: string
    prsCreated: number
    issuesCreated: number
    reviews: number
  }

  const allStats: RepoStats[] = []

  for (const r of repos) {
    const [prsCreated, issuesCreated, reviews] = await Promise.all([
      searchIssues(`type:pr author:${username} repo:${r} created:>=${sinceStr}`, 100)
        .then(items => items.filter(i => i.pull_request).length),
      searchIssues(`type:issue author:${username} repo:${r} created:>=${sinceStr}`, 100)
        .then(items => items.filter(i => !i.pull_request).length),
      searchIssues(`type:pr reviewed-by:${username} repo:${r} created:>=${sinceStr}`, 100)
        .then(items => items.length),
    ])

    allStats.push({ repo: r, prsCreated, issuesCreated, reviews })
  }

  const totalPRs = allStats.reduce((s, r) => s + r.prsCreated, 0)
  const totalIssues = allStats.reduce((s, r) => s + r.issuesCreated, 0)
  const totalReviews = allStats.reduce((s, r) => s + r.reviews, 0)

  const lines: string[] = [
    `## Contribution Stats — @${username} (${effectiveDays} days)`,
    '',
    `> Since ${sinceStr}`,
    '',
  ]

  if (repos.length === 1) {
    const s = allStats[0]!
    lines.push(`> Repository: ${s.repo}`, '')
    lines.push(markdownTable(
      ['Metric', 'Count', 'Note'],
      [
        ['PRs Created', String(s.prsCreated), 'GitHub.com search'],
        ['Issues Created', String(s.issuesCreated), 'GitHub.com search'],
        ['Reviews', String(s.reviews), 'GitHub.com search'],
      ],
    ))
  } else {
    const headers = ['Metric', ...repos, 'Total', 'Note']
    const rows = [
      ['PRs Created', ...allStats.map(s => String(s.prsCreated)), String(totalPRs), 'GitHub.com search'],
      ['Issues Created', ...allStats.map(s => String(s.issuesCreated)), String(totalIssues), 'GitHub.com search'],
      ['Reviews', ...allStats.map(s => String(s.reviews)), String(totalReviews), 'GitHub.com search'],
    ]
    lines.push(markdownTable(headers, rows))
  }

  return lines.join('\n')
}
