import { describe, expect, it } from 'vitest'
import { renderGuidance } from './project-guidance.js'

describe('renderGuidance', () => {
  it('explains the fallback when no guidance exists', () => {
    const output = renderGuidance('owner/repo', [])

    expect(output).toContain('No guidance documents were found')
    expect(output).toContain('Branch naming fallback')
  })

  it('renders repository guidance before local knowledge', () => {
    const output = renderGuidance('owner/repo', [
      { source: 'repository', path: 'CONTRIBUTING.md', content: 'Use feature/* branches.', url: 'https://github.com/owner/repo/blob/HEAD/CONTRIBUTING.md' },
      { source: 'knowledge', path: 'knowledge/branching', content: 'Prefer short branch names.' },
    ])

    expect(output.indexOf('repository: CONTRIBUTING.md')).toBeLessThan(output.indexOf('knowledge: knowledge/branching'))
    expect(output).toContain('Use feature/* branches.')
    expect(output).toContain('Prefer short branch names.')
  })
})
