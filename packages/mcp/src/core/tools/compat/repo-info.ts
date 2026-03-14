import { ghApi, parseRepo } from '../../clients/github.js'
import { relativeTime } from '../../utils/format.js'

interface RepoData {
  full_name: string
  description: string | null
  html_url: string
  homepage: string | null
  stargazers_count: number
  forks_count: number
  watchers_count: number
  open_issues_count: number
  default_branch: string
  language: string | null
  topics: string[]
  license: { name: string } | null
  created_at: string
  updated_at: string
  pushed_at: string
  visibility: string
  archived: boolean
  fork: boolean
  parent?: { full_name: string }
}

interface ContributorsResponse {
  login: string
  contributions: number
}

export async function repoInfo(repo?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const [repoData, contributors] = await Promise.all([
    ghApi<RepoData>(`/repos/${owner}/${name}`),
    ghApi<ContributorsResponse[]>(`/repos/${owner}/${name}/contributors`, { per_page: 10 }).catch(() => []),
  ])

  const lines = [
    `## ${repoData.full_name}`,
    '',
    repoData.description ?? '_No description_',
    '',
    `| | |`,
    `| --- | --- |`,
    `| **Stars** | ⭐ ${repoData.stargazers_count.toLocaleString()} |`,
    `| **Forks** | 🍴 ${repoData.forks_count.toLocaleString()} |`,
    `| **Watchers** | 👁 ${repoData.watchers_count.toLocaleString()} |`,
    `| **Open Issues** | ${repoData.open_issues_count} |`,
    `| **Language** | ${repoData.language ?? '—'} |`,
    `| **License** | ${repoData.license?.name ?? '—'} |`,
    `| **Visibility** | ${repoData.visibility}${repoData.archived ? ' · archived' : ''} |`,
    `| **Default Branch** | \`${repoData.default_branch}\` |`,
    `| **Created** | ${relativeTime(repoData.created_at)} |`,
    `| **Last Push** | ${relativeTime(repoData.pushed_at)} |`,
  ]

  if (repoData.fork && repoData.parent) {
    lines.push(`| **Forked From** | ${repoData.parent.full_name} |`)
  }

  if (repoData.topics.length > 0) {
    lines.push('')
    lines.push(`**Topics**: ${repoData.topics.map(t => `\`${t}\``).join(' ')}`)
  }

  if (repoData.homepage) {
    lines.push('')
    lines.push(`**Homepage**: ${repoData.homepage}`)
  }

  if (contributors.length > 0) {
    lines.push('')
    lines.push(`### Top Contributors`)
    lines.push(contributors.map((c, i) => `${i + 1}. @${c.login} (${c.contributions} commits)`).join('\n'))
  }

  return lines.join('\n')
}
