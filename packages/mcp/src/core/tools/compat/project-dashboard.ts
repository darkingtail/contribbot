import { getLatestRelease, getRepoCommits, getRepoIssues, getRepoPulls, parseRepo } from '../../clients/github.js'
import { markdownTable, relativeTime, truncate } from '../../utils/format.js'
import { listAllKnowledge } from '../core/knowledge-resources.js'

export async function projectDashboard(repo?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const [issues, pulls, commits, release] = await Promise.all([
    getRepoIssues(owner, name, 'open', 100),
    getRepoPulls(owner, name, 'open', 100),
    getRepoCommits(owner, name, 10),
    getLatestRelease(owner, name),
  ])

  // Group issues by label
  const labelGroups = new Map<string, number>()
  for (const issue of issues) {
    const labels = issue.labels.map(l => typeof l === 'string' ? l : l.name).filter(Boolean)
    if (labels.length === 0) {
      labelGroups.set('unlabeled', (labelGroups.get('unlabeled') ?? 0) + 1)
    }
    for (const label of labels) {
      if (label) labelGroups.set(label, (labelGroups.get(label) ?? 0) + 1)
    }
  }

  // Group PRs by label
  const prLabelGroups = new Map<string, number>()
  for (const pr of pulls) {
    const labels = pr.labels.map(l => l.name).filter(Boolean)
    if (labels.length === 0) {
      prLabelGroups.set('unlabeled', (prLabelGroups.get('unlabeled') ?? 0) + 1)
    }
    for (const label of labels) {
      if (label) prLabelGroups.set(label, (prLabelGroups.get(label) ?? 0) + 1)
    }
  }

  const lines: string[] = [
    `## Project Dashboard: ${owner}/${name}`,
    '',
    `| Metric | Count |`,
    `| --- | --- |`,
    `| **Open Issues** | ${issues.length} |`,
    `| **Open PRs** | ${pulls.length} |`,
    `| **Latest Release** | ${release ? `${release.tag_name} (${relativeTime(release.published_at!)})` : 'none'} |`,
  ]

  // Issues by label
  if (labelGroups.size > 0) {
    lines.push('')
    lines.push(`### Issues by Label`)
    const sorted = [...labelGroups.entries()].sort((a, b) => b[1] - a[1])
    const headers = ['Label', 'Count']
    const rows = sorted.map(([label, count]) => [label, String(count)])
    lines.push(markdownTable(headers, rows))
  }

  // PRs by label
  if (prLabelGroups.size > 0) {
    lines.push('')
    lines.push(`### PRs by Label`)
    const sorted = [...prLabelGroups.entries()].sort((a, b) => b[1] - a[1])
    const headers = ['Label', 'Count']
    const rows = sorted.map(([label, count]) => [label, String(count)])
    lines.push(markdownTable(headers, rows))
  }

  // Open PRs
  if (pulls.length > 0) {
    lines.push('')
    lines.push(`### Open PRs`)
    const headers = ['#', 'Title', 'Author', 'Updated']
    const rows = pulls.slice(0, 15).map(pr => [
      String(pr.number),
      truncate(pr.title, 60),
      `@${pr.user?.login ?? '?'}`,
      relativeTime(pr.updated_at),
    ])
    lines.push(markdownTable(headers, rows))
  }

  // Recent commits
  if (commits.length > 0) {
    lines.push('')
    lines.push(`### Recent Commits`)
    const headers = ['SHA', 'Message', 'Author', 'Date']
    const rows = commits.map(c => [
      c.sha.slice(0, 7),
      truncate(c.commit.message.split('\n')[0] ?? '', 60),
      `@${c.author?.login ?? c.commit.author?.name ?? '?'}`,
      relativeTime(c.commit.author?.date ?? ''),
    ])
    lines.push(markdownTable(headers, rows))
  }

  // Project knowledge
  const repoKey = `${owner}/${name}`
  const knowledge = listAllKnowledge().filter(k => k.repo === repoKey)
  if (knowledge.length > 0) {
    lines.push('')
    lines.push(`### Knowledge (${knowledge.length})`)
    const headers = ['Name', 'Description']
    const rows = knowledge.map(k => [k.name, k.description])
    lines.push(markdownTable(headers, rows))
    lines.push(`> Read details: \`knowledge://${repoKey}/{name}\``)
  }

  return lines.join('\n')
}
