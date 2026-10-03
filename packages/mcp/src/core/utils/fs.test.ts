import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeWriteFileSync } from './fs.js'

describe('safeWriteFileSync', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'contribbot-safe-write-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('rejects a preexisting temporary hard link without changing either file', () => {
    const target = join(directory, 'config.yaml')
    const outside = join(directory, 'unrelated.txt')
    writeFileSync(target, 'before')
    writeFileSync(outside, 'unrelated')
    linkSync(outside, `${target}.tmp`)

    expect(() => safeWriteFileSync(target, 'after')).toThrow()

    expect(readFileSync(target, 'utf8')).toBe('before')
    expect(readFileSync(outside, 'utf8')).toBe('unrelated')
    expect(readFileSync(`${target}.tmp`, 'utf8')).toBe('unrelated')
  })

  it('rejects a preexisting temporary directory without disturbing it', () => {
    const target = join(directory, 'config.yaml')
    writeFileSync(target, 'before')
    mkdirSync(`${target}.tmp`)
    writeFileSync(join(`${target}.tmp`, 'keep.txt'), 'keep')

    expect(() => safeWriteFileSync(target, 'new config')).toThrow()

    expect(readFileSync(target, 'utf8')).toBe('before')
    expect(readFileSync(join(`${target}.tmp`, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('preserves the destination and removes its own temporary file when publication fails', () => {
    const target = join(directory, 'config.yaml')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'keep')

    expect(() => safeWriteFileSync(target, 'replacement')).toThrow()

    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep')
    expect(existsSync(target)).toBe(true)
    expect(readdirSync(directory)).toEqual(['config.yaml'])
  })
})
