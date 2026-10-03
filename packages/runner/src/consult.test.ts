import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localMachine } from 'contribbot-agent-runtime'
import { createConsultStore } from './composition.js'
import { digest } from 'contribbot-core'
import type { TurnResult } from 'contribbot-core'
import { recoverConsultTurn, runConsultTurn } from './consult.js'
import type { ConsultStore } from 'contribbot-core'
import type { ConsultRunnerDependencies, ConsultRuntimeHooks } from './orchestration.js'
import { executableDigest, pipeTransport } from 'contribbot-agent-runtime'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'consult-runner-'))
  writeFileSync(join(directory, 'config.yaml'), JSON.stringify({
    schema_version: 3,
    repository: { platform: 'github', instance: 'https://github.com', path: 'fixture/runner' },
    lifecycle: { status: 'active' }, parent: { status: 'unknown' }, tracking: { status: 'pending' },
  }))
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const decision = { source: 'fixture:user', statement: 'Run the selected test advisor once.' }
async function reserve(store: ConsultStore) {
  return store.reserve({
    request_id: 'runner-request', discussion_id: 'runner-discussion', purpose: 'design',
    mode: 'fresh', todo_id: null, expected_todo: null,
    packet: {
      workspace: directory, head: null, manifest: [], body: 'Fixture question',
      digest: digest('Fixture question'), omitted: [],
    },
    binding: {
      runtime: 'claude', executable: process.execPath, executable_digest: await executableDigest(process.execPath),
      runtime_version: 'fixture', binding_version: '1', model: null,
      protocol: 'native-oneshot', transport: 'pipe', execution_location: 'local', model_location: 'unknown',
      write_boundary: 'tool_free', read_boundary: 'tools_disabled',
      disclosure: 'Test-only runtime.', disclosure_digest: digest('Test-only runtime.'),
    },
    authorization: { explicit_once: decision },
  })
}

it('runs one exact turn through injected test runtime dependencies and replays without redispatch', async () => {
  const store = createConsultStore(directory)
  const reserved = await reserve(store)
  const protocol = {
    runtime: 'claude' as const,
    protocol: 'native-oneshot' as const,
    argv: () => [],
    terminal: (stdout: string) => stdout.includes('fixture.result'),
    decode: (stdout: string, exitCode: number | null) => {
      const event = JSON.parse(stdout.trim()) as { type: string; text: string }
      return exitCode === 0 && event.type === 'fixture.result'
        ? { text: event.text, outcome: 'returned' as const, reason: null }
        : { text: null, outcome: 'failed' as const, reason: 'Fixture process failed.' }
    },
  }
  const transportRun = vi.fn((...args: Parameters<typeof pipeTransport.run>) => pipeTransport.run(...args))
  const dependencies: ConsultRunnerDependencies = {
    describeSupervisor: async () => ({
      pid: process.pid, machine: localMachine(), started_at: null, observed_at: new Date().toISOString(),
    }),
    runtime: {
      verifyBinding: vi.fn(async binding => {
        expect(Object.isFrozen(binding)).toBe(true)
        expect(() => { binding.executable = 'changed-after-verification' }).toThrow(TypeError)
      }),
      prepare: vi.fn(async () => {
        const plan = {
          executable: process.execPath,
          argv: ['-e', `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>console.log(JSON.stringify({type:'fixture.result',text:input})))`],
          cwd: directory, env: {},
        }
        return {
          status: 'ready' as const, preparations: [{ scratch_directory: null, probe: null }],
          run: (prompt: string, hooks: ConsultRuntimeHooks) => transportRun(plan, prompt, protocol, {
            dispatch: start => hooks.dispatch(start) as import('node:child_process').ChildProcessWithoutNullStreams,
            onProcess: hooks.onProcess,
            shouldTerminate: hooks.shouldTerminate,
          }),
        }
      }),
    },
  }

  await runConsultTurn(store, 'runner-discussion', reserved.turn.id, dependencies)
  const settled = store.get('runner-discussion').turns[0]!
  const result = store.readResult(settled)!
  expect(settled).toMatchObject({ lifecycle: 'settled', outcome: 'returned', unresolved: [] })
  expect(result.text).toContain('Fixture question')
  expect(transportRun).toHaveBeenCalledTimes(1)

  await runConsultTurn(store, 'runner-discussion', reserved.turn.id, dependencies)
  expect(transportRun).toHaveBeenCalledTimes(1)
  expect(store.get('runner-discussion').turns).toHaveLength(1)
  expect(store.settle('runner-discussion', reserved.turn.id, result)).toEqual(store.get('runner-discussion').turns[0])
  const conflicting: TurnResult = { ...result, text: 'Different result' }
  expect(() => store.settle('runner-discussion', reserved.turn.id, conflicting)).toThrow(/immutable/i)
  expect(readdirSync(join(directory, 'consult')).filter(name => name.endsWith('.yaml'))).toEqual(['discussions.yaml'])
})

it('does not recover or settle a turn explicitly released before dispatch', async () => {
  const store = createConsultStore(directory)
  const reserved = await reserve(store)
  store.control('runner-discussion', reserved.turn.id, 'abandon', decision)

  expect(() => recoverConsultTurn(store, 'runner-discussion', reserved.turn.id))
    .toThrow(/released before dispatch/i)
  expect(() => store.settle('runner-discussion', reserved.turn.id, {
    outcome: 'returned', text: 'late fixture', stdout: '', stderr: '', exit_code: 0, signal: null,
    integrity: 'ok', reason: null, unresolved: [],
  })).toThrow(/released before dispatch/i)
})

it('cleans an injected scratch directory when preparation publication loses a state race', async () => {
  const store = createConsultStore(directory)
  const reserved = await reserve(store)
  const firstScratch = mkdtempSync(join(tmpdir(), 'consult-runner-race-'))
  const secondScratch = mkdtempSync(join(tmpdir(), 'consult-runner-race-'))
  const dependencies: ConsultRunnerDependencies = {
    describeSupervisor: async () => ({
      pid: process.pid, machine: localMachine(), started_at: null, observed_at: new Date().toISOString(),
    }),
    runtime: {
      verifyBinding: async () => {},
      prepare: async () => {
        store.settle('runner-discussion', reserved.turn.id, {
          outcome: 'failed', text: null, stdout: '', stderr: '', exit_code: null, signal: null,
          integrity: 'ok', reason: 'Fixture wins the state race.', unresolved: [],
        })
        return {
          status: 'ready' as const,
          preparations: [
            { scratch_directory: firstScratch, probe: null, cleanup: () => rmSync(firstScratch, { recursive: true, force: true }) },
            { scratch_directory: secondScratch, probe: null, cleanup: () => rmSync(secondScratch, { recursive: true, force: true }) },
          ],
          run: async () => { throw new Error('must not run') },
        }
      },
    },
  }

  await runConsultTurn(store, 'runner-discussion', reserved.turn.id, dependencies)
  expect(existsSync(firstScratch)).toBe(false)
  expect(existsSync(secondScratch)).toBe(false)
  expect(store.get('runner-discussion').turns[0]).toMatchObject({
    lifecycle: 'settled', outcome: 'failed',
  })
})

it.each([
  { outcome: 'cancelled', integrity: 'ok', reason: 'User requested advisor termination.', unresolved: ['Descendants unknown'] },
  { outcome: 'failed', integrity: 'truncated', reason: 'Advisor output byte limit exceeded.', unresolved: ['Terminal receipt missing'] },
  { outcome: 'failed', integrity: 'ok', reason: 'Protocol failed.', unresolved: ['Remote consumption unknown'] },
] as const)('preserves the exact $outcome/$integrity receipt and digest', async variant => {
  const store = createConsultStore(directory)
  const reserved = await reserve(store)
  const expected: TurnResult = {
    outcome: variant.outcome,
    text: null, stdout: 'bounded output', stderr: '', exit_code: null, signal: null,
    integrity: variant.integrity, reason: variant.reason,
    unresolved: [...variant.unresolved],
  }
  await runConsultTurn(store, 'runner-discussion', reserved.turn.id, {
    describeSupervisor: async pid => ({
      pid, machine: localMachine(), started_at: null, observed_at: new Date().toISOString(),
    }),
    runtime: {
      verifyBinding: async () => {},
      prepare: async () => ({
        status: 'ready', preparations: [],
        run: async (_prompt, hooks) => {
          hooks.dispatch(() => undefined)
          return expected
        },
      }),
    },
  })
  const settled = store.get('runner-discussion').turns[0]!
  const content = readFileSync(join(directory, 'consult', `${settled.id}.result.json`), 'utf8')
  expect(JSON.parse(content)).toEqual(expected)
  expect(content).toBe(JSON.stringify(expected))
  expect(settled.output_digest).toBe(digest(content))
  expect(settled.lifecycle).toBe('reconciling')
})
