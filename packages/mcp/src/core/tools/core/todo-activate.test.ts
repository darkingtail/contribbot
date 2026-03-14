import { describe, it, expect } from 'vitest'
import { generateDefaultBranchName } from './todo-activate.js'

describe('generateDefaultBranchName', () => {
  it('generates feat/number-slug for issue ref', () => {
    const name = generateDefaultBranchName({ ref: '#259', title: 'Cascader showSearch support', type: 'feature' })
    expect(name).toBe('feat/259-cascader-showsearch-support')
  })

  it('uses fix prefix for bug type', () => {
    const name = generateDefaultBranchName({ ref: '#42', title: 'Fix dropdown overflow', type: 'bug' })
    expect(name).toBe('fix/42-fix-dropdown-overflow')
  })

  it('uses docs prefix for docs type', () => {
    const name = generateDefaultBranchName({ ref: '#10', title: 'Update API documentation', type: 'docs' })
    expect(name).toBe('docs/10-update-api-documentation')
  })

  it('uses slug ref directly for non-issue ref', () => {
    const name = generateDefaultBranchName({ ref: 'playground', title: 'Setup playground', type: 'chore' })
    expect(name).toBe('feat/playground')
  })

  it('generates from title when no ref', () => {
    const name = generateDefaultBranchName({ ref: null, title: 'Research WebSocket integration', type: 'feature' })
    expect(name).toBe('feat/research-websocket-integration')
  })

  it('falls back to task when title has no usable words', () => {
    const name = generateDefaultBranchName({ ref: null, title: '测试', type: 'feature' })
    expect(name).toBe('feat/task')
  })

  it('filters stop words from slug', () => {
    const name = generateDefaultBranchName({ ref: '#1', title: 'Fix the bug with the modal', type: 'bug' })
    expect(name).toBe('fix/1-fix-bug-modal')
  })

  it('limits slug to 3 words', () => {
    const name = generateDefaultBranchName({ ref: '#1', title: 'Add new fancy dropdown component widget', type: 'feature' })
    expect(name).toBe('feat/1-add-new-fancy')
  })
})
