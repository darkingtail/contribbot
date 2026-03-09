import { describe, it, expect } from 'vitest'
import { validatePathSegment } from './config.js'

describe('validatePathSegment', () => {
  it('accepts normal names', () => {
    expect(validatePathSegment('ant-design')).toBe('ant-design')
    expect(validatePathSegment('antdv-next')).toBe('antdv-next')
    expect(validatePathSegment('my.repo')).toBe('my.repo')
    expect(validatePathSegment('repo_name')).toBe('repo_name')
  })

  it('rejects path traversal', () => {
    expect(() => validatePathSegment('..')).toThrow('Invalid path segment')
    expect(() => validatePathSegment('../etc')).toThrow('Invalid path segment')
    expect(() => validatePathSegment('foo/bar')).toThrow('Invalid path segment')
    expect(() => validatePathSegment('foo\\bar')).toThrow('Invalid path segment')
  })

  it('rejects empty or whitespace', () => {
    expect(() => validatePathSegment('')).toThrow('Invalid path segment')
    expect(() => validatePathSegment('  ')).toThrow('Invalid path segment')
  })
})
