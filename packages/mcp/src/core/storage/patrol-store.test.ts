import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PatrolStore } from './patrol-store.js'

describe('PatrolStore', () => {
  let dir: string
  let store: PatrolStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patrol-test-'))
    store = new PatrolStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a complete auditable patrol run and latest pointers', () => {
    const paths = store.writeRun({
      runId: '20260711-120000-abc123',
      report: '# Patrol Report\n',
      snapshot: { repo: 'owner/repo' },
      analysis: { health: 'attention' },
      trace: [{ phase: 'observe' }],
      run: { status: 'succeeded' },
      actions: [{ id: 'action-1', status: 'completed' }],
    })

    expect(existsSync(paths.reportPath)).toBe(true)
    expect(readFileSync(join(paths.runDir, 'snapshot.json'), 'utf-8')).toContain('owner/repo')
    expect(readFileSync(join(paths.runDir, 'analysis.json'), 'utf-8')).toContain('attention')
    expect(readFileSync(join(paths.runDir, 'trace.json'), 'utf-8')).toContain('observe')
    expect(readFileSync(join(paths.runDir, 'run.json'), 'utf-8')).toContain('succeeded')
    expect(readFileSync(join(paths.runDir, 'actions.json'), 'utf-8')).toContain('action-1')
    expect(readFileSync(paths.latestReportPath, 'utf-8')).toBe('# Patrol Report\n')
    expect(readFileSync(join(dir, 'patrol', 'latest.json'), 'utf-8')).toContain('20260711-120000-abc123')
    const loaded = store.readRun('20260711-120000-abc123')
    expect(loaded.run).toEqual({ status: 'succeeded' })
    expect(loaded.actions).toEqual([{ id: 'action-1', status: 'completed' }])
  })

  it('rejects unsafe run ids', () => {
    expect(() => store.writeRun({
      runId: '../escape',
      report: '',
      snapshot: {},
      analysis: {},
      trace: [],
    })).toThrow(/Invalid path segment/)
  })

  it('reports missing or legacy-incomplete runs', () => {
    expect(() => store.readRun('missing-run')).toThrow(/incomplete or missing/)
  })
})
