import { getIssue, getIssueComments, getIssueTimeline, parseRepo } from '../clients/github.js'
import { relativeTime, truncate } from '../utils/format.js'

export async function issueDetail(issueNumber: number, repo?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const [issue, comments, timeline] = await Promise.all([
    getIssue(owner, name, issueNumber),
    getIssueComments(owner, name, issueNumber),
    getIssueTimeline(owner, name, issueNumber),
  ])

  const labels = issue.labels
    .map(l => typeof l === 'string' ? l : l.name)
    .filter(Boolean)
    .join(', ')

  // Find linked PRs from timeline events
  const linkedPRs = timeline
    .filter((e: any) => e.event === 'cross-referenced' && e.source?.issue?.pull_request)
    .map((e: any) => ({
      number: e.source.issue.number,
      title: e.source.issue.title,
      state: e.source.issue.state,
    }))

  // Find antd issue references in the body
  const antdRefs = (issue.body ?? '').match(/ant-design\/ant-design#\d+|antd#\d+/g) ?? []

  const lines: string[] = [
    `## Issue #${issue.number}: ${issue.title}`,
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| **State** | ${issue.state} |`,
    `| **Author** | @${issue.user?.login ?? 'unknown'} |`,
    `| **Created** | ${relativeTime(issue.created_at)} |`,
    `| **Updated** | ${relativeTime(issue.updated_at)} |`,
    `| **Labels** | ${labels || 'none'} |`,
    `| **Comments** | ${comments.length} |`,
    `| **Assignees** | ${issue.assignees?.map(a => `@${a.login}`).join(', ') || 'none'} |`,
    `| **Milestone** | ${issue.milestone?.title ?? 'none'} |`,
  ]

  if (issue.body) {
    lines.push('')
    lines.push(`### Description`)
    lines.push(truncate(issue.body, 1000))
  }

  if (linkedPRs.length > 0) {
    lines.push('')
    lines.push(`### Linked PRs`)
    for (const pr of linkedPRs) {
      lines.push(`- #${pr.number} (${pr.state}): ${pr.title}`)
    }
  }

  if (antdRefs.length > 0) {
    lines.push('')
    lines.push(`### Ant Design References`)
    for (const ref of antdRefs) {
      lines.push(`- ${ref}`)
    }
  }

  return lines.join('\n')
}
