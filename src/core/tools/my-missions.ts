import { getCurrentUser, searchIssues, parseRepo } from '../clients/github.js'
import { markdownTable, relativeTime, truncate } from '../utils/format.js'

export async function myMissions(repo?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const user = await getCurrentUser()
  if (!user) {
    return 'Error: Could not get current GitHub user. Make sure gh CLI is authenticated.'
  }

  const login = user.login
  const repoQ = `repo:${owner}/${name}`

  // Fetch all signal types in parallel
  const [myPRs, assigned, commented, mentioned] = await Promise.all([
    searchIssues(`is:pr is:open author:${login} ${repoQ}`),
    searchIssues(`is:issue is:open assignee:${login} ${repoQ}`),
    searchIssues(`is:issue is:open commenter:${login} ${repoQ}`),
    searchIssues(`is:issue is:open mentions:${login} ${repoQ}`),
  ])

  // Deduplicate issues across categories
  const seen = new Set<number>()
  function dedup<T extends { number: number }>(items: T[]): T[] {
    return items.filter((item) => {
      if (seen.has(item.number)) return false
      seen.add(item.number)
      return true
    })
  }

  const dedupedPRs = dedup(myPRs)
  const dedupedAssigned = dedup(assigned)
  const dedupedCommented = dedup(commented.filter(i => !i.pull_request))
  const dedupedMentioned = dedup(mentioned.filter(i => !i.pull_request))

  const total = dedupedPRs.length + dedupedAssigned.length + dedupedCommented.length + dedupedMentioned.length

  const lines: string[] = [
    `## My Missions — @${login}`,
    `> ${owner}/${name} · ${total} items across all signals`,
    '',
  ]

  const renderTable = (items: typeof myPRs, reason: string) => {
    if (items.length === 0) return '_none_'
    const headers = ['#', 'Title', 'Labels', 'Updated', '备注']
    const rows = items.map(item => [
      `#${item.number}`,
      truncate(item.title, 45),
      item.labels.map(l => l.name).join(', ') || '—',
      relativeTime(item.updated_at),
      reason,
    ])
    return markdownTable(headers, rows)
  }

  if (dedupedPRs.length > 0) {
    lines.push(`### 🔨 My Open PRs (${dedupedPRs.length})`)
    lines.push(renderTable(dedupedPRs, '我提的 PR，待 review/merge'))
    lines.push('')
  }

  if (dedupedAssigned.length > 0) {
    lines.push(`### 📌 Assigned to Me (${dedupedAssigned.length})`)
    lines.push(renderTable(dedupedAssigned, '指派给我，待处理'))
    lines.push('')
  }

  if (dedupedCommented.length > 0) {
    lines.push(`### 💬 I Commented On (${dedupedCommented.length})`)
    lines.push(renderTable(dedupedCommented, '我参与过，可能有后续'))
    lines.push('')
  }

  if (dedupedMentioned.length > 0) {
    lines.push(`### 📣 Mentioned Me (${dedupedMentioned.length})`)
    lines.push(renderTable(dedupedMentioned, '提到了我，需关注'))
    lines.push('')
  }

  if (total === 0) {
    lines.push('_No active missions found. You\'re free!_ 🎉')
  }

  return lines.join('\n')
}
