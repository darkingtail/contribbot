import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TodoStore } from './todo-store.js'

const fixture = fileURLToPath(new URL('./__fixtures__/todo-writer.ts', import.meta.url))
const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url))

describe('TodoStore process transactions', () => {
  let directory: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'contribbot-store-process-')) })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

  it('preserves every write from independent processes', async () => {
    const run = (label: string) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [tsx, fixture, directory, label, '8'], { windowsHide: true })
      let stderr = ''
      child.stderr.on('data', data => { stderr += data })
      child.on('error', reject)
      child.on('close', code => resolve({ code, stderr }))
    })
    const results = await Promise.all(['one', 'two', 'three'].map(run))
    expect(results, JSON.stringify(results)).toEqual(results.map(() => ({ code: 0, stderr: '' })))
    const items = new TodoStore(directory).list()
    expect(items).toHaveLength(24)
    expect(new Set(items.map(item => item.ref)).size).toBe(24)
  }, 20_000)
})
