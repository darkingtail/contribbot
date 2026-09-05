import { getPull, getPullChecks, ghApi, parseRepo } from '../../clients/github.js'
import { markdownTable, relativeTime, truncate } from '../../utils/format.js'

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

export async function actionsStatus(repo?: string, branch?: string, prNumber?: number): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const params: Record<string, string | number> = { per_page: 20 }
  let scope = branch ? `branch \`${branch}\`` : 'latest repository runs'
  let checks: Awaited<ReturnType<typeof getPullChecks>> | null = null
  if (prNumber !== undefined) {
    const pr = await getPull(owner, name, prNumber)
    params.head_sha = pr.head.sha
    scope = `PR #${prNumber} head \`${pr.head.ref}\` (${pr.head.sha.slice(0, 7)})`
    try {
      checks = await getPullChecks(owner, name, pr.head.sha)
    }
    catch {
      // Workflow runs still provide PR-scoped evidence when check-runs are unavailable.
    }
  }
  else if (branch) {
    params.branch = branch
  }

  let data: WorkflowRunsResponse
  try {
    data = await ghApi<WorkflowRunsResponse>(`/repos/${owner}/${name}/actions/runs`, params)
  }
  catch (e) {
    return `Error fetching workflow runs: ${e instanceof Error ? e.message : String(e)}`
  }

  if (data.workflow_runs.length === 0) {
    const noRuns = [`## Actions — ${owner}/${name}`, `> Scope: ${scope}`, '', '_No workflow runs found._']
    if (checks?.check_runs.length) noRuns.push('', renderChecks(checks.check_runs))
    return noRuns.join('\n')
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
    `> Scope: ${scope}`,
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

  if (checks?.check_runs.length) lines.push('', renderChecks(checks.check_runs))

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

export function renderChecks(checks: Array<{ name: string, status: string, conclusion: string | null }>): string {
  const rows = checks.map(check => [
    check.status === 'completed' && check.conclusion === 'success' ? '✅' : check.status !== 'completed' ? '⏳' : '❌',
    check.name,
    check.status,
    check.conclusion ?? 'pending',
    check.conclusion === 'success' ? 'passed' : check.status !== 'completed' ? 'still running' : 'blocks merge readiness',
  ])
  return ['### PR Check Runs', markdownTable(['Status', 'Check', 'State', 'Conclusion', 'Notes'], rows)].join('\n')
}
