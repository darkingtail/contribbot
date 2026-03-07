import { getPull, getPullChecks, getPullFiles, getPullReviews, parseRepo } from '../clients/github.js'
import { markdownTable, relativeTime } from '../utils/format.js'

function groupFilesByComponent(files: { filename: string, status: string, additions: number, deletions: number }[]): Map<string, typeof files> {
  const groups = new Map<string, typeof files>()
  for (const file of files) {
    // Extract component name from path like packages/antdv-next/src/{component}/...
    const match = file.filename.match(/packages\/antdv-next\/src\/([^/]+)\//)
    const group = match?.[1] ?? '_other'
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group)!.push(file)
  }
  return groups
}

export async function prSummary(prNumber: number, repo?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const [pr, files, reviews] = await Promise.all([
    getPull(owner, name, prNumber),
    getPullFiles(owner, name, prNumber),
    getPullReviews(owner, name, prNumber),
  ])

  let checks: Awaited<ReturnType<typeof getPullChecks>> | null = null
  try {
    checks = await getPullChecks(owner, name, pr.head.sha)
  }
  catch {
    // Checks API might not be available
  }

  const lines: string[] = [
    `## PR #${pr.number}: ${pr.title}`,
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| **State** | ${pr.state}${pr.merged ? ' (merged)' : pr.draft ? ' (draft)' : ''} |`,
    `| **Author** | @${pr.user?.login ?? 'unknown'} |`,
    `| **Branch** | \`${pr.head.ref}\` → \`${pr.base.ref}\` |`,
    `| **Created** | ${relativeTime(pr.created_at)} |`,
    `| **Updated** | ${relativeTime(pr.updated_at)} |`,
    `| **Labels** | ${pr.labels.map(l => l.name).join(', ') || 'none'} |`,
    `| **Reviewers** | ${pr.requested_reviewers?.map((r: any) => `@${r.login}`).join(', ') || 'none'} |`,
    `| **Changes** | +${pr.additions} / -${pr.deletions} (${files.length} files) |`,
  ]

  // Reviews summary
  if (reviews.length > 0) {
    lines.push('')
    lines.push(`### Reviews`)
    const reviewHeaders = ['Reviewer', 'State', 'Time']
    const reviewRows = reviews.map(r => [
      `@${r.user?.login ?? 'unknown'}`,
      r.state,
      relativeTime(r.submitted_at!),
    ])
    lines.push(markdownTable(reviewHeaders, reviewRows))
  }

  // CI checks summary
  if (checks && checks.check_runs.length > 0) {
    lines.push('')
    lines.push(`### CI Checks`)
    const passed = checks.check_runs.filter(c => c.conclusion === 'success').length
    const failed = checks.check_runs.filter(c => c.conclusion === 'failure').length
    const pending = checks.check_runs.filter(c => c.status !== 'completed').length
    lines.push(`✅ ${passed} passed | ❌ ${failed} failed | ⏳ ${pending} pending`)

    if (failed > 0) {
      lines.push('')
      lines.push('**Failed checks:**')
      for (const check of checks.check_runs.filter(c => c.conclusion === 'failure')) {
        lines.push(`- ${check.name}`)
      }
    }
  }

  // Files grouped by component
  const grouped = groupFilesByComponent(files)
  lines.push('')
  lines.push(`### Changed Files by Component`)
  for (const [component, componentFiles] of grouped) {
    lines.push(`\n**${component}** (${componentFiles.length} files)`)
    for (const f of componentFiles) {
      lines.push(`- \`${f.filename}\` [${f.status}] +${f.additions}/-${f.deletions}`)
    }
  }

  return lines.join('\n')
}
