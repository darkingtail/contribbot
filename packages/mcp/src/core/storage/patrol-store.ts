import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validatePathSegment } from '../utils/config.js'
import { safeWriteFileSync } from '../utils/fs.js'

export interface PatrolRunInput {
  runId: string
  report: string
  snapshot: unknown
  analysis: unknown
  trace: unknown[]
  run?: unknown
  actions?: unknown[]
}

export interface PatrolRunPaths {
  runDir: string
  reportPath: string
  latestReportPath: string
}

export interface StoredPatrolRun {
  report: string
  snapshot: unknown
  analysis: unknown
  trace: unknown[]
  run: unknown
  actions: unknown[]
}

export class PatrolStore {
  constructor(private baseDir: string) {}

  writeRun(input: PatrolRunInput): PatrolRunPaths {
    const runId = validatePathSegment(input.runId)
    const patrolDir = join(this.baseDir, 'patrol')
    const runDir = join(patrolDir, 'runs', runId)
    this.ensureDir(runDir)

    const reportPath = join(runDir, 'report.md')
    safeWriteFileSync(reportPath, input.report)
    safeWriteFileSync(join(runDir, 'snapshot.json'), `${JSON.stringify(input.snapshot, null, 2)}\n`)
    safeWriteFileSync(join(runDir, 'analysis.json'), `${JSON.stringify(input.analysis, null, 2)}\n`)
    safeWriteFileSync(join(runDir, 'trace.json'), `${JSON.stringify(input.trace, null, 2)}\n`)
    if (input.run !== undefined) safeWriteFileSync(join(runDir, 'run.json'), `${JSON.stringify(input.run, null, 2)}\n`)
    if (input.actions !== undefined) safeWriteFileSync(join(runDir, 'actions.json'), `${JSON.stringify(input.actions, null, 2)}\n`)

    const latestReportPath = join(patrolDir, 'latest.md')
    safeWriteFileSync(latestReportPath, input.report)
    safeWriteFileSync(join(patrolDir, 'latest.json'), `${JSON.stringify({
      run_id: runId,
      recorded_at: new Date().toISOString(),
      report: `runs/${runId}/report.md`,
      status: typeof input.run === 'object' && input.run !== null && 'status' in input.run
        ? (input.run as { status: unknown }).status
        : undefined,
    }, null, 2)}\n`)

    return { runDir, reportPath, latestReportPath }
  }

  readRun(inputRunId: string): StoredPatrolRun {
    const runId = validatePathSegment(inputRunId)
    const runDir = join(this.baseDir, 'patrol', 'runs', runId)
    const required = ['report.md', 'snapshot.json', 'analysis.json', 'trace.json', 'run.json', 'actions.json']
    const missing = required.filter(file => !existsSync(join(runDir, file)))
    if (missing.length) throw new Error(`Patrol run "${runId}" is incomplete or missing: ${missing.join(', ')}`)
    return {
      report: readFileSync(join(runDir, 'report.md'), 'utf-8'),
      snapshot: JSON.parse(readFileSync(join(runDir, 'snapshot.json'), 'utf-8')),
      analysis: JSON.parse(readFileSync(join(runDir, 'analysis.json'), 'utf-8')),
      trace: JSON.parse(readFileSync(join(runDir, 'trace.json'), 'utf-8')) as unknown[],
      run: JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf-8')),
      actions: JSON.parse(readFileSync(join(runDir, 'actions.json'), 'utf-8')) as unknown[],
    }
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}
