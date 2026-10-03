import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { type RepositoryRef, projectDirectory } from '../../utils/repository-ref.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { patrolRecord } from './patrol-record.js'

vi.mock('../../utils/resolve-repo.js', () => ({ resolveRepo: vi.fn() }))

const repository: RepositoryRef = {
  platform: 'gitlab',
  instance: 'https://code.example.test/gitlab',
  path: 'team/subgroup/repo',
}
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'patrol-record-'))
  vi.mocked(resolveRepo).mockResolvedValue({
    repository,
    directory: projectDirectory(repository, join(home, '.contribbot')),
    owner: 'team/subgroup',
    name: 'repo',
  })
})

afterEach(() => {
  vi.clearAllMocks()
  rmSync(home, { recursive: true, force: true })
})

it('reports the actual v3 patrol files for a self-hosted project', async () => {
  const output = await patrolRecord({
    repo: repository,
    run_id: 'run-1',
    report: '# Patrol report',
    snapshot_json: '{}',
    analysis_json: '{}',
    trace_json: '[]',
  })
  const directory = projectDirectory(repository, join(home, '.contribbot'))
  const reportPath = join(directory, 'patrol', 'runs', 'run-1', 'report.md')
  const latestPath = join(directory, 'patrol', 'latest.md')

  expect(readFileSync(reportPath, 'utf8')).toBe('# Patrol report')
  expect(existsSync(latestPath)).toBe(true)
  expect(output).toContain('| Repo | gitlab://code.example.test/gitlab/team/subgroup/repo |')
  expect(output).toContain(`| Report | \`${reportPath}\``)
  expect(output).toContain(`| Latest | \`${latestPath}\``)
  expect(output).not.toContain('~/.contribbot/team/subgroup/repo/patrol')
})
