import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTodoLock } from './todo-lock.js'

describe('short Todo transaction ownership', () => {
  let directory: string
  let locks: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'contribbot-lock-'))
    locks = join(directory, '.locks')
    mkdirSync(locks)
  })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
  const seed = (pid: number, host = hostname(), malformed = false) => {
    const token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const file = join(locks, `todos.${pid}.${token}.ticket-1.json`)
    writeFileSync(file, malformed ? '{' : JSON.stringify({ pid, host, token, created_at: new Date().toISOString() }))
  }

  it('reenters synchronous work and cleans its own files after exceptions', () => {
    expect(withTodoLock(directory, () => withTodoLock(directory, () => 42))).toBe(42)
    expect(() => withTodoLock(directory, () => { throw new Error('test failure') })).toThrow('test failure')
    expect(readdirSync(locks)).toEqual([])
    expect(withTodoLock(directory, () => 43)).toBe(43)
  })

  it('rejects async callbacks without invoking them and refuses returned promises', () => {
    let called = false
    expect(() => withTodoLock(directory, async () => { called = true })).toThrow(/synchronous/i)
    expect(called).toBe(false)
    expect(() => withTodoLock(directory, () => Promise.resolve())).toThrow(/Promise/i)
    expect(readdirSync(locks)).toEqual([])
  })

  it.each(['live', 'foreign', 'malformed'])('does not take over a %s owner', (kind) => {
    seed(process.pid, kind === 'foreign' ? 'another-host' : hostname(), kind === 'malformed')
    const before = readdirSync(locks)
    const run = vi.fn()
    expect(() => withTodoLock(directory, run, 15)).toThrow(/Timed out/i)
    expect(run).not.toHaveBeenCalled()
    expect(readdirSync(locks)).toEqual(before)
  })

  it('ignores a proven exited local process but never deletes its ticket', () => {
    const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true })
    expect(child.status).toBe(0)
    seed(child.pid)
    const before = readdirSync(locks)
    expect(withTodoLock(directory, () => 1, 100)).toBe(1)
    expect(readdirSync(locks)).toEqual(before)
  })

  it('fails if its own ownership disappeared during the transaction', () => {
    expect(() => withTodoLock(directory, () => {
      for (const file of readdirSync(locks)) rmSync(join(locks, file))
    })).toThrow()
    expect(withTodoLock(directory, () => true)).toBe(true)
  })

  it('blocks malformed published owner names instead of assuming no owner', () => {
    writeFileSync(join(locks, 'todos.invalid.json'), '{}')
    expect(() => withTodoLock(directory, () => true, 15)).toThrow(/Timed out/i)
  })

  it('ignores uncommitted publication files', () => {
    writeFileSync(join(locks, 'todos.unpublished.pending'), '{')
    expect(withTodoLock(directory, () => true, 15)).toBe(true)
  })
})
