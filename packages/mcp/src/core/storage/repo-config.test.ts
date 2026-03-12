import { describe, it, expect } from 'vitest'
import { inferMode } from './repo-config.js'

describe('inferMode', () => {
  it('returns "none" when no fork and no upstream', () => {
    expect(inferMode({ role: 'admin', org: null, fork: null, upstream: null })).toBe('none')
  })

  it('returns "fork" when fork exists but no upstream', () => {
    expect(inferMode({ role: 'write', org: null, fork: 'darkingtail/plane', upstream: null })).toBe('fork')
  })

  it('returns "fork+upstream" when both exist', () => {
    expect(inferMode({
      role: 'write', org: 'antdv-next',
      fork: 'darkingtail/antdv-next', upstream: 'ant-design/ant-design',
    })).toBe('fork+upstream')
  })

  it('returns "upstream" when upstream exists but no fork', () => {
    expect(inferMode({ role: 'admin', org: null, fork: null, upstream: 'some/repo' })).toBe('upstream')
  })
})
