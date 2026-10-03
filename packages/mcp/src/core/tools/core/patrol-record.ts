import { PatrolStore } from '../../storage/patrol-store.js'
import { markdownTable } from '../../utils/format.js'
import { repositoryDisplay, type RepositoryInput } from '../../utils/repository-ref.js'
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
  repo?: RepositoryInput
  run_id: string
  report: string
  snapshot_json: string
  analysis_json: string
  trace_json: string
  run_json?: string
  actions_json?: string
}): Promise<string> {
  const { repository, directory } = await resolveRepo(args.repo)
  const snapshot = parseJson(args.snapshot_json, 'snapshot_json')
  const analysis = parseJson(args.analysis_json, 'analysis_json')
  const trace = parseJson(args.trace_json, 'trace_json')
  if (!Array.isArray(trace)) throw new Error('trace_json must contain a JSON array.')
  const run = args.run_json ? parseJson(args.run_json, 'run_json') : undefined
  const actions = args.actions_json ? parseJson(args.actions_json, 'actions_json') : undefined
  if (actions !== undefined && !Array.isArray(actions)) throw new Error('actions_json must contain a JSON array.')

  const store = new PatrolStore(directory)
  const paths = store.writeRun({
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
    markdownTable(['Field', 'Value', 'Remark'], [
      ['Repo', repositoryDisplay(repository), 'Managed project'],
      ['Report', `\`${paths.reportPath}\``, 'This run'],
      ['Latest', `\`${paths.latestReportPath}\``, 'Most recent report'],
    ]),
    '',
    'Snapshot, structured analysis, and execution trace were saved with the report.',
  ].join('\n')
}

export async function patrolRunGet(repo: RepositoryInput | undefined, runId: string): Promise<string> {
  const { directory } = await resolveRepo(repo)
  const store = new PatrolStore(directory)
  return JSON.stringify(store.readRun(runId))
}
