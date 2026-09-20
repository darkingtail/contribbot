import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { digest } from '../../consult/contracts.js'
import { inspectBinding } from '../../consult/binding.js'
import { launchConsultSupervisor } from '../../consult/runner.js'
import { todoConsultations } from '../../consult/projection.js'
import { TodoStore } from '../../storage/todo-store.js'
import { ConsultStore } from '../../consult/store.js'
import * as processes from '../../execution/processes.js'
import { setTimeout as delay } from 'node:timers/promises'
import {
  consultStart, consultStatus, consultRead, consultControl, consultDecide, consultPurgeRaw, consultStore,
} from './consult.js'

vi.mock('../../consult/binding.js', () => ({ inspectBinding: vi.fn() }))
vi.mock('../../consult/runner.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../consult/runner.js')>(),
  launchConsultSupervisor: vi.fn().mockResolvedValue(undefined),
}))
let home: string
const repo = 'consult-fixture/repo'
const decision = { source: 'fixture:user', statement: 'Ask this advisor once with these materials and disclosure.' }
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'consult-service-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.mocked(inspectBinding).mockResolvedValue({
    runtime: 'claude', executable: process.execPath, executable_digest: digest('fixture'),
    runtime_version: 'fixture', binding_version: '1', model: null,
    protocol: 'native-oneshot', transport: 'pipe', execution_location: 'local', model_location: 'unknown',
    write_boundary: 'tool_free', read_boundary: 'tools_disabled',
    disclosure: 'Fixture disclosure', disclosure_digest: digest('Fixture disclosure'),
  })
  vi.mocked(launchConsultSupervisor).mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(home, { force: true, recursive: true })
})
const input = () => ({
  repo, request_id: 'request-1', advisor: { runtime: 'claude', executable: process.execPath },
  packet: { workspace: home, question: 'Review a synthetic counter' },
  authorization: { explicit_once: decision },
})
async function start(extra = {}) {
  const raw = { ...input(), ...extra }
  const preview = await consultStart(raw)
  const confirmed = { ...raw, confirmed_preview: preview.preview!.digest }
  const receipt = await consultStart(confirmed)
  return { confirmed, receipt }
}
function finish(discussionId: string, turnId: string) {
  return consultStore(repo).settle(discussionId, turnId, {
    outcome: 'returned', text: 'Advice, not evidence', stdout: 'synthetic receipt', stderr: '',
    exit_code: 0, signal: null, integrity: 'ok', reason: null, unresolved: [],
  })
}

it('previews without writes/dispatch, requires exact approval, and prevents current denial', async () => {
  const raw = input()
  const preview = await consultStart({ ...raw, authorization: {} })
  expect(preview.dispatched).toBe(false)
  expect(existsSync(join(home, '.contribbot'))).toBe(false)
  expect(launchConsultSupervisor).not.toHaveBeenCalled()
  await expect(consultStart({ ...raw, authorization: {}, confirmed_preview: preview.preview!.digest })).rejects.toThrow(/authorization/)
  await expect(consultStart({ ...raw, authorization: { denied: true } })).rejects.toThrow(/denied/)
  await expect(consultStart({ ...raw, confirmed_preview: 'f'.repeat(64) })).rejects.toThrow(/preview changed/)
})

it('returns the original receipt after completion even when dynamic history has changed', async () => {
  const { confirmed, receipt } = await start()
  finish(receipt.discussion_id!, receipt.turn_id!)
  const replay = await consultStart(confirmed)
  expect(replay).toMatchObject({ replayed: true, turn_id: receipt.turn_id })
  expect(launchConsultSupervisor).toHaveBeenCalledTimes(1)
  await expect(consultStart({ ...confirmed, packet: { ...confirmed.packet, question: 'Different' } })).rejects.toThrow(/different content/)
  const read = await consultRead({ repo, discussion_id: receipt.discussion_id })
  expect(read.turns![0]!.text).toBe('Advice, not evidence')
})

it('rejects a Todo snapshot changed between confirmation and the locked reservation', async () => {
  const store = consultStore(repo)
  const todos = new TodoStore(store.directory)
  const todo = todos.add({ ref: null, title: 'Concurrent Todo', type: 'feature' })
  const raw = { ...input(), todo_id: todo.id }
  const preview = await consultStart(raw)
  const original = ConsultStore.prototype.reserve
  const spy = vi.spyOn(ConsultStore.prototype, 'reserve').mockImplementationOnce(function (this: ConsultStore, value) {
    todos.activateExecution(0)
    return original.call(this, value)
  })
  try {
    await expect(consultStart({ ...raw, confirmed_preview: preview.preview!.digest })).rejects.toThrow(/Todo.*changed/)
    expect(launchConsultSupervisor).not.toHaveBeenCalled()
  }
  finally { spy.mockRestore() }
})

it('associates and synthesizes advisory output without changing Todo, then purges only its raw data', async () => {
  const store = consultStore(repo)
  const todo = new TodoStore(store.directory).add({ ref: null, title: 'Synthetic Todo', type: 'feature' })
  const before = readFileSync(join(store.directory, 'todos.yaml'))
  const { receipt } = await start({ todo_id: todo.id })
  const turn = finish(receipt.discussion_id!, receipt.turn_id!)
  await consultDecide({
    repo, discussion_id: receipt.discussion_id, expected_revision: store.get(receipt.discussion_id!).revision,
    command: { action: 'synthesize', id: 's1', author: 'main', text: 'A considered synthesis',
      sources: [{ turn_id: turn.id, digest: turn.output_digest }] },
  })
  await consultDecide({
    repo, discussion_id: receipt.discussion_id, expected_revision: store.get(receipt.discussion_id!).revision,
    command: { action: 'decision', id: 'd1', outcome: 'adopt', synthesis_id: 's1',
      note: 'Use this design, not an acceptance decision', decision },
  })
  expect(todoConsultations(store.directory, todo.id!).discussions).toHaveLength(1)
  const preview = await consultPurgeRaw({ repo, discussion_id: receipt.discussion_id })
  await consultPurgeRaw({ repo, discussion_id: receipt.discussion_id, confirmed_digest: preview.preview!.digest, decision })
  expect(readFileSync(join(store.directory, 'todos.yaml'))).toEqual(before)
  expect(store.get(receipt.discussion_id!).syntheses).toHaveLength(1)
  expect((await consultRead({ repo, discussion_id: receipt.discussion_id })).turns![0]!.text).toBeNull()
})

it('recovers an immutable receipt after interrupted metadata publication without redispatch', async () => {
  const { receipt } = await start()
  const store = consultStore(repo)
  const turn = store.get(receipt.discussion_id!).turns[0]!
  writeFileSync(join(store.directory, 'consult', `${turn.id}.result.json`), JSON.stringify({
    outcome: 'returned', text: 'Recovered answer', stdout: '', stderr: '',
    exit_code: 0, signal: null, integrity: 'ok', reason: null, unresolved: [],
  }))
  const status = await consultStatus({ repo, discussion_id: receipt.discussion_id })
  expect(status.turns![0]).toMatchObject({ lifecycle: 'settled', outcome: 'returned' })
  expect(launchConsultSupervisor).toHaveBeenCalledTimes(1)
})

it('keeps corrupt consultation records from blocking Todo projection', async () => {
  const { receipt } = await start()
  const store = consultStore(repo)
  expect(receipt.turn_id).toBeTruthy()
  writeFileSync(join(store.directory, 'consult', 'discussions.yaml'), 'invalid: record')
  expect(todoConsultations(store.directory, 't-1')).toMatchObject({ status: 'unavailable', discussions: [] })
})

it('prepares stopped-root observations before accepting a report and recovers late output without another launch', async () => {
  const { confirmed, receipt } = await start()
  const store = consultStore(repo)
  const base = {
    action: 'reconcile', id: 'release-1', discussion_id: receipt.discussion_id, turn_id: receipt.turn_id,
  }
  await expect(consultControl({ repo, command: { ...base, expected_revision: store.get(receipt.discussion_id!).revision } })).rejects.toThrow(/supervisor.*missing/i)
  const handle = { pid: process.pid, machine: processes.localMachine(), started_at: 1, observed_at: new Date().toISOString() }
  store.claim(receipt.discussion_id!, receipt.turn_id!, handle)
  vi.spyOn(processes, 'observeProcess').mockReturnValue({ state: 'stopped', observed_at: new Date().toISOString(), reason: 'Fixture stopped root' })
  const preview = await consultControl({ repo, command: { ...base, expected_revision: store.get(receipt.discussion_id!).revision } })
  await delay(2)
  const command = {
    ...base, observation_id: preview.release_observation!.id,
    expected_revision: preview.release_observation!.revision, decision,
    accept_remote_uncertainty: true,
    report: {
      source: 'host_report', actor: 'fixture', locator: 'fixture:all-local-processes',
      machine: processes.localMachine(), observed_at: new Date().toISOString(),
      method: 'Inspected process tree and original launch records.', scope: 'All local supervisor/advisor processes, including unrecorded children.',
      handles_covered: [handle], all_descendants_stopped: true, unresolved: [],
    },
  }
  await expect(consultControl({ repo, command: { ...command, accept_remote_uncertainty: false } })).rejects.toThrow()
  await expect(consultControl({ repo, command: { ...command, decision: undefined } })).rejects.toThrow()
  await consultControl({ repo, command })
  expect(store.get(receipt.discussion_id!).turns[0]!).toMatchObject({
    outcome: null, reconciliations: [{ local_handles: [{ handle }], remote_generation: 'unknown', remote_consumption: 'unknown' }],
  })
  // A late receipt is recovered without reoccupying the local slot or becoming current advice.
  writeFileSync(join(store.directory, 'consult', `${receipt.turn_id}.result.json`), JSON.stringify({
    outcome: 'returned', text: 'Late recovered answer', stdout: '', stderr: '',
    exit_code: 0, signal: null, integrity: 'ok', reason: null, unresolved: [],
  }))
  const status = await consultStatus({ repo, discussion_id: receipt.discussion_id })
  expect(status.turns![0]).toMatchObject({
    lifecycle: 'reconciled_by_attestation', local_occupancy: 'released', late: true, outcome: 'returned',
  })
  const read = await consultRead({ repo, discussion_id: receipt.discussion_id })
  expect(read.turns![0]).toMatchObject({ local_occupancy: 'released', reconciliations: [{ released: 'local_occupancy_only' }] })
  await consultControl({ repo, command })
  const replay = await consultStart(confirmed)
  expect(replay.replayed).toBe(true)
  expect(launchConsultSupervisor).toHaveBeenCalledTimes(1)
})
