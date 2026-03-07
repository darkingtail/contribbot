import { parseRepo, searchIssues } from '../clients/github.js'
import { markdownTable } from '../utils/format.js'

export async function issueList(
  repo?: string,
  state?: string,
  labels?: string,
  query?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const parts = [`repo:${owner}/${name}`, 'type:issue']
  if (state) parts.push(`state:${state}`)
  else parts.push('state:open')
  if (labels) {
    for (const l of labels.split(',').map(s => s.trim()).filter(Boolean)) {
      parts.push(`label:"${l}"`)
    }
  }
  if (query) parts.push(query)

  const items = await searchIssues(parts.join(' '), 30)

  if (items.length === 0) {
    return `## Issues — ${owner}/${name}\n\n_No issues found._`
  }

  const headers = ['#', 'Title', 'Labels', 'Author', 'Updated']
  const rows = items
    .filter(i => !i.pull_request)
    .map(i => [
      `[#${i.number}](${i.html_url})`,
      i.title.length > 60 ? `${i.title.slice(0, 57)}...` : i.title,
      i.labels.map(l => l.name).join(', ') || '—',
      i.user?.login ?? '—',
      i.updated_at.slice(0, 10),
    ])

  return `## Issues — ${owner}/${name}\n\n> ${rows.length} results\n\n${markdownTable(headers, rows)}`
}

export async function prList(
  repo?: string,
  state?: string,
  query?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const parts = [`repo:${owner}/${name}`, 'type:pr']
  if (state) parts.push(`state:${state}`)
  else parts.push('state:open')
  if (query) parts.push(query)

  const items = await searchIssues(parts.join(' '), 30)

  if (items.length === 0) {
    return `## PRs — ${owner}/${name}\n\n_No PRs found._`
  }

  const headers = ['#', 'Title', 'Author', 'Updated']
  const rows = items
    .filter(i => i.pull_request)
    .map(i => [
      `[#${i.number}](${i.html_url})`,
      i.title.length > 60 ? `${i.title.slice(0, 57)}...` : i.title,
      i.user?.login ?? '—',
      i.updated_at.slice(0, 10),
    ])

  return `## PRs — ${owner}/${name}\n\n> ${rows.length} results\n\n${markdownTable(headers, rows)}`
}
