import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { parseRepo, getCurrentUser, searchIssues } from '../clients/github.js'
import { markdownTable } from '../utils/format.js'

function listAllProjects(): string[] {
  const contribRoot = join(homedir(), '.contribbot')
  if (!existsSync(contribRoot)) return []

  const projects: string[] = []
  const owners = readdirSync(contribRoot).filter(f =>
    statSync(join(contribRoot, f)).isDirectory() && !f.startsWith('.'),
  )
  for (const owner of owners) {
    const ownerDir = join(contribRoot, owner)
    const repos = readdirSync(ownerDir).filter(f =>
      statSync(join(ownerDir, f)).isDirectory(),
    )
    for (const repo of repos) {
      projects.push(`${owner}/${repo}`)
    }
  }
  return projects
}

export async function contributionStats(
  days?: number,
  author?: string,
  repo?: string,
): Promise<string> {
  const effectiveDays = days ?? 7
  const since = new Date()
  since.setDate(since.getDate() - effectiveDays)
  const sinceStr = since.toISOString().slice(0, 10)

  let username = author
  if (!username) {
    const user = await getCurrentUser()
    username = user?.login
  }
  if (!username) {
    return 'Error: Could not determine GitHub username. Pass `author` parameter.'
  }

  let repos: string[]
  if (repo === 'all' || !repo) {
    repos = listAllProjects()
  } else {
    repos = [repo.includes('/') ? repo : `${parseRepo(repo).owner}/${parseRepo(repo).name}`]
  }

  if (repos.length === 0) {
    return 'Error: No projects found. Use contribbot tools first to track projects.'
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
    const s = allStats[0]
    lines.push(markdownTable(
      ['Metric', 'Count'],
      [
        ['PRs Created', String(s.prsCreated)],
        ['Issues Created', String(s.issuesCreated)],
        ['Reviews', String(s.reviews)],
      ],
    ))
  } else {
    const headers = ['Metric', ...repos.map(r => r.split('/')[1]), 'Total']
    const rows = [
      ['PRs Created', ...allStats.map(s => String(s.prsCreated)), String(totalPRs)],
      ['Issues Created', ...allStats.map(s => String(s.issuesCreated)), String(totalIssues)],
      ['Reviews', ...allStats.map(s => String(s.reviews)), String(totalReviews)],
    ]
    lines.push(markdownTable(headers, rows))
  }

  return lines.join('\n')
}
