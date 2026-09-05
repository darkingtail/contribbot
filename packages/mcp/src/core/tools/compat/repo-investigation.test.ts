import { describe, expect, it } from 'vitest'
import { renderCommitDetail, renderCompareRefs } from './repo-investigation.js'

describe('repository investigation rendering', () => {
  it('renders commit files and patch evidence', () => {
    const output = renderCommitDetail('owner/repo', {
      sha: 'abcdef123456', html_url: 'https://example.test/commit', author: { login: 'maintainer' },
      commit: { message: 'fix: correct behavior', author: { name: 'Maintainer', date: '2026-09-01' } },
      stats: { additions: 2, deletions: 1, total: 3 },
      files: [{ filename: 'src/index.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@' }],
    })
    expect(output).toContain('src/index.ts')
    expect(output).toContain('@@ -1 +1 @@')
  })

  it('renders ref comparison evidence', () => {
    const output = renderCompareRefs('owner/repo', 'main', 'feature/dev', {
      commits: [], total_commits: 2, status: 'ahead', ahead_by: 2, behind_by: 0,
      files: [{ filename: 'src/custom.ts', status: 'added', additions: 10, deletions: 0 }],
    })
    expect(output).toContain('main...feature/dev')
    expect(output).toContain('src/custom.ts')
  })
})
