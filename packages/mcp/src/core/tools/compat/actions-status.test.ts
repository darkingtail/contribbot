import { describe, expect, it } from 'vitest'
import { renderChecks } from './actions-status.js'

describe('renderChecks', () => {
  it('marks failed and pending PR checks as not merge-ready', () => {
    const output = renderChecks([
      { name: 'test', status: 'completed', conclusion: 'failure' },
      { name: 'lint', status: 'in_progress', conclusion: null },
    ])
    expect(output).toContain('blocks merge readiness')
    expect(output).toContain('still running')
  })
})
