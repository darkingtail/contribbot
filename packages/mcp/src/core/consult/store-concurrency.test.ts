import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { localMachine } from '../execution/processes.js'
import { createConsultStore } from './composition.js'
import { digest } from './contracts.js'
import type { ConsultStore } from './store.js'
import { withTodoLock } from 'contribbot-core'

const fixture = fileURLToPath(new URL('./__fixtures__/dispatch-race-worker.ts', import.meta.url))
const tsx = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url))

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'consult-dispatch-race-'))
  writeFileSync(join(directory, 'config.yaml'), JSON.stringify({
    schema_version: 3,
    repository: { platform: 'github', instance: 'https://github.com', path: 'fixture/runner' },
    lifecycle: { status: 'active' }, parent: { status: 'unknown' }, tracking: { status: 'pending' },
  }))
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

function reserve(store: ConsultStore) {
  return store.reserve({
    request_id: 'race-request', discussion_id: 'race-discussion', purpose: 'design',
    mode: 'fresh', todo_id: null, expected_todo: null,
    packet: {
      workspace: directory, head: null, manifest: [], body: 'Race fixture',
      digest: digest('Race fixture'), omitted: [],
    },
    binding: {
      runtime: 'claude', executable: process.execPath, executable_digest: digest('race-runtime'),
      runtime_version: 'fixture', binding_version: '1', model: null,
      protocol: 'native-oneshot', transport: 'pipe', execution_location: 'local', model_location: 'unknown',
      write_boundary: 'tool_free', read_boundary: 'tools_disabled',
      disclosure: 'Race fixture.', disclosure_digest: digest('Race fixture.'),
    },
    authorization: { explicit_once: { source: 'fixture:user', statement: 'Run exactly one race fixture.' } },
  })
}

it('serializes overlapping process dispatch so only one exact turn side effect runs', async () => {
  const store = createConsultStore(directory)
  const reserved = reserve(store)
  store.claim('race-discussion', reserved.turn.id, {
    pid: process.pid, machine: localMachine(), started_at: null, observed_at: new Date().toISOString(),
  })
  const effectPath = join(directory, 'dispatch-effects.txt')
  const startPath = join(directory, 'start')
  const finishPath = join(directory, 'finish')
  const waitFor = async (predicate: () => boolean) => {
    const started = Date.now()
    while (!predicate()) {
      if (Date.now() - started > 10_000) throw new Error('Timed out waiting for dispatch race fixture.')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const run = (label: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const readyPath = join(directory, `ready-${label}`)
    const child = spawn(process.execPath, [
      tsx, fixture, directory, 'race-discussion', reserved.turn.id, label,
      effectPath, readyPath, startPath, finishPath,
    ], {
      windowsHide: true, shell: false,
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })

  const pending = ['one', 'two'].map(run)
  let overlapError: unknown
  let overlappingEffects: string[] = []
  try {
    await waitFor(() => existsSync(join(directory, 'ready-one')) && existsSync(join(directory, 'ready-two')))
    writeFileSync(startPath, 'start', 'utf8')
    await waitFor(() => existsSync(effectPath))
    await new Promise(resolve => setTimeout(resolve, 100))
    overlappingEffects = readFileSync(effectPath, 'utf8').trim().split(/\r?\n/)
  }
  catch (error) { overlapError = error }
  finally {
    if (!existsSync(startPath)) writeFileSync(startPath, 'start', 'utf8')
    if (!existsSync(finishPath)) writeFileSync(finishPath, 'finish', 'utf8')
  }
  const processes = await Promise.all(pending)
  if (overlapError) throw overlapError
  expect(overlappingEffects).toHaveLength(1)
  expect(processes.map(item => ({ code: item.code, stderr: item.stderr }))).toEqual([
    { code: 0, stderr: '' }, { code: 0, stderr: '' },
  ])
  const outcomes = processes.map(item => JSON.parse(item.stdout) as { label: string; dispatched: boolean; error: string | null })
  expect(outcomes.filter(item => item.dispatched && item.error === null)).toHaveLength(1)
  expect(outcomes.filter(item => !item.dispatched && /already|running/i.test(item.error ?? ''))).toHaveLength(1)
  expect(readFileSync(effectPath, 'utf8').trim().split(/\r?\n/)).toHaveLength(1)
  expect(store.get('race-discussion').turns[0]).toMatchObject({ lifecycle: 'running' })
  expect(store.get('race-discussion').turns[0]!.dispatch_started_at).not.toBeNull()
}, 20_000)

it.each([false, true])('MCP and Runner share the same process lock and fresh control state: revoke=%s', async revoked => {
  const store = createConsultStore(directory)
  const reserved = reserve(store)
  const ready = join(directory, 'runner-ready')
  const worker = fileURLToPath(new URL('./__fixtures__/runner-lock-worker.mjs', import.meta.url))
  let child: ReturnType<typeof spawn> | undefined
  let finished: Promise<{ code: number | null; stdout: string; stderr: string }> | undefined
  let failure: unknown
  try {
    withTodoLock(directory, () => {
      const before = store.get('race-discussion').revision
      child = spawn(process.execPath, [
        '--conditions=contribbot-source', '--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        worker, directory, 'race-discussion', reserved.turn.id, ready,
      ], { windowsHide: true, shell: false })
      finished = new Promise((resolve, reject) => {
        let stdout = '', stderr = ''
        child!.stdout!.on('data', data => { stdout += data })
        child!.stderr!.on('data', data => { stderr += data })
        child!.once('error', reject)
        child!.once('close', code => resolve({ code, stdout, stderr }))
      })
      const deadline = Date.now() + 10_000
      while (!existsSync(ready) || readdirSync(join(directory, '.locks')).filter(name => name.includes('.ticket-')).length < 2) {
        if (Date.now() > deadline) throw new Error('Runner did not contend on the shared lock.')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
      expect(store.get('race-discussion').revision).toBe(before)
      expect(store.get('race-discussion').turns[0]!.claimed_at).toBeNull()
      if (revoked) store.control('race-discussion', reserved.turn.id, 'abandon', {
        source: 'fixture:user', statement: 'Abandon the unclaimed turn.',
      })
    })
  }
  catch (error) { failure = error; child?.kill() }
  const result = await finished
  if (failure) throw new Error(`${String(failure)}\n${result?.stderr ?? ''}`, { cause: failure })
  expect(result?.code, result?.stderr).toBe(0)
  const observed = JSON.parse(result!.stdout) as { claimed: boolean; revision: number }
  expect(observed.claimed).toBe(!revoked)
  expect(observed.revision).toBe(store.get('race-discussion').revision)
  expect(store.get('race-discussion').turns[0]!.lifecycle).toBe(revoked ? 'released_before_dispatch' : 'running')
}, 20_000)
