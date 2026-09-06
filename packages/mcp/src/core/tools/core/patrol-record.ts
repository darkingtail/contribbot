import { PatrolStore } from '../../storage/patrol-store.js'
import { getContribDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value)
  }
  catch {
    throw new Error(`${label} must be valid JSON.`)
  }
}

export async function patrolRecord(args: {
  repo?: string
  run_id: string
  report: string
  snapshot_json: string
  analysis_json: string
  trace_json: string
  run_json?: string
  actions_json?: string
}): Promise<string> {
  const { owner, name } = await resolveRepo(args.repo)
  const snapshot = parseJson(args.snapshot_json, 'snapshot_json')
  const analysis = parseJson(args.analysis_json, 'analysis_json')
  const trace = parseJson(args.trace_json, 'trace_json')
  if (!Array.isArray(trace)) throw new Error('trace_json must contain a JSON array.')
  const run = args.run_json ? parseJson(args.run_json, 'run_json') : undefined
  const actions = args.actions_json ? parseJson(args.actions_json, 'actions_json') : undefined
  if (actions !== undefined && !Array.isArray(actions)) throw new Error('actions_json must contain a JSON array.')

  const store = new PatrolStore(getContribDir(owner, name))
  store.writeRun({
    runId: args.run_id,
    report: args.report,
    snapshot,
    analysis,
    trace,
    run,
    actions,
  })

  return [
    `## Patrol run recorded — \`${args.run_id}\``,
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| Repo | ${owner}/${name} |`,
    `| Report | \`~/.contribbot/${owner}/${name}/patrol/runs/${args.run_id}/report.md\` |`,
    `| Latest | \`~/.contribbot/${owner}/${name}/patrol/latest.md\` |`,
    '',
    'Snapshot, structured analysis, and execution trace were saved with the report.',
  ].join('\n')
}

export async function patrolRunGet(repo: string | undefined, runId: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const store = new PatrolStore(getContribDir(owner, name))
  return JSON.stringify(store.readRun(runId))
}
