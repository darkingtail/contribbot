import { ghApi, parseRepo } from '../clients/github.js'
import { markdownTable, relativeTime, truncate } from '../utils/format.js'

interface WorkflowRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  created_at: string
  updated_at: string
  html_url: string
  head_branch: string
  head_commit: { message: string } | null
  actor: { login: string } | null
}

interface WorkflowRunsResponse {
  total_count: number
  workflow_runs: WorkflowRun[]
}

function conclusionIcon(run: WorkflowRun): string {
  if (run.status !== 'completed') return '⏳'
  switch (run.conclusion) {
    case 'success': return '✅'
    case 'failure': return '❌'
    case 'cancelled': return '⊘'
    case 'skipped': return '⏭'
    default: return '❓'
  }
}

export async function actionsStatus(repo?: string, branch?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const params: Record<string, string | number> = { per_page: 20 }
  if (branch) params.branch = branch

  let data: WorkflowRunsResponse
  try {
    data = await ghApi<WorkflowRunsResponse>(`/repos/${owner}/${name}/actions/runs`, params)
  }
  catch (e) {
    return `Error fetching workflow runs: ${e instanceof Error ? e.message : String(e)}`
  }

  if (data.workflow_runs.length === 0) {
    return `## Actions — ${owner}/${name}\n\n_No workflow runs found._`
  }

  const runs = data.workflow_runs

  // Summary by workflow name
  const byWorkflow = new Map<string, WorkflowRun[]>()
  for (const run of runs) {
    const key = run.name ?? 'Unknown'
    if (!byWorkflow.has(key)) byWorkflow.set(key, [])
    byWorkflow.get(key)!.push(run)
  }

  const lines = [
    `## Actions — ${owner}/${name}`,
    `> ${data.total_count} total runs · showing latest 20`,
    '',
    `### Latest Runs`,
  ]

  const headers = ['Status', 'Workflow', 'Branch', 'Triggered by', 'Updated']
  const rows = runs.slice(0, 15).map(run => [
    conclusionIcon(run),
    truncate(run.name ?? '?', 30),
    run.head_branch,
    `@${run.actor?.login ?? '?'}`,
    relativeTime(run.updated_at),
  ])
  lines.push(markdownTable(headers, rows))

  // Highlight failures
  const failures = runs.filter(r => r.conclusion === 'failure')
  if (failures.length > 0) {
    lines.push('')
    lines.push(`### ❌ Recent Failures (${failures.length})`)
    for (const f of failures) {
      const msg = f.head_commit?.message?.split('\n')[0] ?? ''
      lines.push(`- **${f.name}** on \`${f.head_branch}\` — ${truncate(msg, 60)} (${relativeTime(f.updated_at)})`)
    }
  }

  return lines.join('\n')
}
