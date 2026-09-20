import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExecutionArtifacts } from './artifacts.js'

describe('immutable execution artifacts', () => {
  let directory: string
  let artifacts: ExecutionArtifacts
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'contribbot-artifacts-'))
    artifacts = new ExecutionArtifacts(directory, 'execution')
  })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

  it('round trips JSON and reuses identical immutable content', () => {
    const content = { output: 'observed result' }
    const key = artifacts.put(content)
    expect(artifacts.get(key)).toEqual(content)
    expect(artifacts.put(content)).toBe(key)
    const result = artifacts.putReceipt('operation:one', content)
    expect(artifacts.getReceipt('operation:one')).toEqual({ digest: result, value: content })
    expect(artifacts.putReceipt('operation:one', content)).toBe(result)
    expect(() => artifacts.putReceipt('operation:one', { output: 'replacement' })).toThrow(/Immutable/i)
    expect(artifacts.getReceipt('operation:one')?.value).toEqual(content)
  })

  it('publishes async process receipts immutably and separately from result receipts', async () => {
    const handle = { pid: 123, started_at: 1000 }
    const [first, repeated] = await Promise.all([
      artifacts.putReceiptAsync('operation', handle, 'process'),
      artifacts.putReceiptAsync('operation', handle, 'process'),
    ])
    expect(first).toBe(repeated)
    expect(artifacts.getReceipt('operation', 'process')).toEqual({ digest: first, value: handle })
    expect(artifacts.getReceipt('operation')).toBeUndefined()
    await expect(artifacts.putReceiptAsync('operation', { pid: 456 }, 'process')).rejects.toThrow(/Immutable/i)
    const result = artifacts.putReceipt('operation', { code: 0 })
    expect(artifacts.getReceipt('operation')?.digest).toBe(result)
    expect(artifacts.getReceipt('operation', 'process')?.value).toEqual(handle)
  })

  it('rejects symlinked directories in the async publisher', async () => {
    const external = join(directory, 'external')
    mkdirSync(external)
    const artifactDir = join(directory, 'executions', 'execution', 'artifacts')
    rmSync(artifactDir, { recursive: true })
    symlinkSync(external, artifactDir, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(artifacts.putReceiptAsync('operation', { code: 0 }, 'process')).rejects.toThrow(/link/i)
  })

  it('rejects corrupted and missing content without treating it as empty success', () => {
    const key = artifacts.putReceipt('operation', { code: 0 })
    const file = join(directory, 'executions', 'execution', 'artifacts', `${key}.json`)
    writeFileSync(file, '{"code":1}')
    expect(() => artifacts.getReceipt('operation')).toThrow(/digest/i)
    rmSync(file)
    expect(() => artifacts.getReceipt('operation')).toThrow()
  })

  it('rejects escaped ids and symlinked storage directories', () => {
    expect(() => new ExecutionArtifacts(directory, '../escape')).toThrow(/Unsafe/i)
    expect(() => artifacts.get('../escape')).toThrow(/digest/i)
    const external = join(directory, 'external')
    mkdirSync(external)
    const execution = join(directory, 'executions', 'execution')
    rmSync(join(execution, 'artifacts'), { recursive: true })
    symlinkSync(external, join(execution, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => artifacts.put({ anything: true })).toThrow(/link/i)
  })

  it('stores only the requested JSON, not surrounding process environment', () => {
    const key = artifacts.put({ output: 'safe' })
    expect(readFileSync(join(directory, 'executions', 'execution', 'artifacts', `${key}.json`), 'utf8'))
      .toBe('{"output":"safe"}')
  })
})
