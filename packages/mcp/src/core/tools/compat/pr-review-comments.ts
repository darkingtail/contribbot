import { parseRepo, getPullReviewComments } from '../../clients/github.js'
import { truncate } from '../../utils/format.js'

export async function prReviewComments(
  prNumber: number,
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const comments = await getPullReviewComments(owner, name, prNumber)

  if (comments.length === 0) {
    return `## Review Comments — ${owner}/${name}#${prNumber}\n\n_No review comments._`
  }

  const lines: string[] = [
    `## Review Comments — ${owner}/${name}#${prNumber}`,
    '',
    `> ${comments.length} comments`,
    '',
  ]

  for (const c of comments) {
    const author = c.user?.login ?? 'unknown'
    lines.push(`### ${c.path}:${c.line ?? '?'} — @${author} (ID: ${c.id})`)
    lines.push('')
    lines.push('```diff')
    lines.push(truncate(c.diff_hunk, 500))
    lines.push('```')
    lines.push('')
    lines.push(c.body)
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}
