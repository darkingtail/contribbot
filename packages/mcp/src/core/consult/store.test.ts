import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import { createConsultStorePorts } from './composition.js'
import { ConsultStore as BaseConsultStore } from './store.js'
import { digest, reconcileInputSchema } from './contracts.js'
import type { GrantSpec, TurnResult } from './contracts.js'
import { TodoStore } from '../storage/todo-store.js'
import * as processes from '../execution/processes.js'

class ConsultStore extends BaseConsultStore {
  constructor(directory: string) { super(directory, createConsultStorePorts(directory)) }
}

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'consult-store-')) })
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

const decision = { source: 'fixture:user-turn', statement: 'Ask this advisor once with the disclosed boundary.' }
function request(workspace: string, requestId = 'request-1') {
  return {
    request_id: requestId, discussion_id: 'discussion-1', purpose: 'design' as const,
    mode: 'fresh' as const, todo_id: null, expected_todo: null,
    packet: {
      workspace, head: null, manifest: [{
        category: 'question' as const, path: null, source: 'user', sha256: digest('Question'),
        bytes: 8, notes: [],
      }], body: 'Question', digest: digest('Question'), omitted: [],
    },
    binding: {
      runtime: 'claude' as const, executable: process.execPath, executable_digest: digest('binary'),
      runtime_version: 'fixture', binding_version: '1' as const, model: null,
      protocol: 'native-oneshot' as const, transport: 'pipe' as const,
      execution_location: 'local' as const, model_location: 'unknown' as const,
      write_boundary: 'tool_free' as const, read_boundary: 'tools_disabled' as const,
      disclosure: 'Remote model; advice only.', disclosure_digest: digest('Remote model; advice only.'),
    },
    authorization: { explicit_once: decision },
  }
}

it('persists a standalone advisory turn without creating a Todo and replays its request id', () => {
  const store = new ConsultStore(directory)
  const input = request(directory)
  const first = store.reserve(input)
  const repeated = new ConsultStore(directory).reserve(input)
  expect(repeated.turn).toEqual(first.turn)
  expect(repeated.replayed).toBe(true)
  expect(first).toMatchObject({ turn: { lifecycle: 'reserved', authorization: { source: 'explicit_once' } } })
  expect(existsSync(join(directory, 'todos.yaml'))).toBe(false)
})

const result = (text = 'Advisory text'): TurnResult => ({
  outcome: 'returned', text, stdout: JSON.stringify({ result: text }), stderr: '',
  exit_code: 0, signal: null, integrity: 'ok', reason: null, unresolved: [],
})
const handle = () => ({
  pid: process.pid, machine: { hostname: 'fixture', platform: process.platform },
  started_at: 1, observed_at: new Date().toISOString(),
})
function grantSpec(todoId: string): GrantSpec {
  return {
    source: 'todo_grant', todo_id: todoId, workspace: directory,
    runtimes: [{ runtime: 'claude', disclosure_digest: request(directory).binding.disclosure_digest }],
    purposes: ['design'], scope: { categories: ['question'], paths: [] }, max_turns: 1,
  }
}

it('claims a reserved turn once and refuses duplicate/conflicting requests and parallel advisors', () => {
  const store = new ConsultStore(directory)
  const first = store.reserve(request(directory))
  expect(store.claim('discussion-1', first.turn.id, handle())).toBe(true)
  expect(store.claim('discussion-1', first.turn.id, handle())).toBe(false)
  expect(() => store.reserve({ ...request(directory), purpose: 'review' })).toThrow(/different content/i)
  expect(() => store.reserve(request(directory, 'request-2'))).toThrow(/running|unresolved/i)
  store.settle('discussion-1', first.turn.id, result())
  expect(store.reserve(request(directory, 'request-2')).turn.id).not.toBe(first.turn.id)
})

it('reserves an allowance before dispatch and never refunds a missing result', () => {
  const todos = new TodoStore(directory)
  const todoId = todos.add({ ref: null, title: 'Test consult', type: 'feature' }).id!
  const before = readFileSync(join(directory, 'todos.yaml'))
  const store = new ConsultStore(directory)
  const spec = grantSpec(todoId)
  store.grant({ id: 'grant', spec, decision, confirmed_digest: digest(spec) })
  store.reserve({
    ...request(directory), todo_id: todoId, expected_todo: store.todoSnapshot(todoId), authorization: { grant_id: 'grant' },
  })
  expect(store.read().grants[0]!.events.map(item => item.kind)).toEqual(['granted', 'reserved', 'exhausted'])
  expect(readFileSync(join(directory, 'todos.yaml'))).toEqual(before)
  expect(() => store.reserve({
    ...request(directory, 'request-2'), discussion_id: 'discussion-2', todo_id: todoId,
    expected_todo: store.todoSnapshot(todoId), authorization: { grant_id: 'grant' },
  })).toThrow(/running|unresolved|exhausted/)
})

it('honors revocation between reservation and launch', () => {
  const todoId = new TodoStore(directory).add({ ref: null, title: 'Test', type: 'feature' }).id!
  const store = new ConsultStore(directory)
  const spec = grantSpec(todoId)
  store.grant({ id: 'grant', spec, decision, confirmed_digest: digest(spec) })
  const first = store.reserve({ ...request(directory), todo_id: todoId, expected_todo: store.todoSnapshot(todoId), authorization: { grant_id: 'grant' } })
  store.revoke('grant', { source: 'user:revoke', statement: 'Do not call the advisor.' })
  expect(() => store.claim('discussion-1', first.turn.id, handle())).toThrow(/revoked/)
})

it('rechecks authorization under the spawn lock after slow preparation and claims only one dispatch', () => {
  const todoId = new TodoStore(directory).add({ ref: null, title: 'Test', type: 'feature' }).id!
  const store = new ConsultStore(directory)
  const spec = grantSpec(todoId)
  store.grant({ id: 'grant', spec, decision, confirmed_digest: digest(spec) })
  const first = store.reserve({ ...request(directory), todo_id: todoId, expected_todo: store.todoSnapshot(todoId), authorization: { grant_id: 'grant' } })
  store.claim('discussion-1', first.turn.id, handle())
  store.revoke('grant', { source: 'user:revoke', statement: 'Cancel after preparation.' })
  let spawned = false
  expect(() => store.dispatch('discussion-1', first.turn.id, () => { spawned = true })).toThrow(/revoked/)
  expect(spawned).toBe(false)
  store.settle('discussion-1', first.turn.id, result())
  const second = store.reserve({ ...request(directory, 'request-2'), todo_id: todoId, expected_todo: store.todoSnapshot(todoId) })
  store.claim('discussion-1', second.turn.id, handle())
  expect(store.dispatch('discussion-1', second.turn.id, () => 'spawned')).toBe('spawned')
  expect(() => store.dispatch('discussion-1', second.turn.id, () => 'again')).toThrow(/already/)
})

it('rejects an async dispatch callback before invoking it or persisting dispatch intent', async () => {
  const store = new ConsultStore(directory)
  const first = store.reserve(request(directory))
  store.claim('discussion-1', first.turn.id, handle())
  const before = store.get('discussion-1')
  const events: string[] = []

  const asynchronousStart = (async () => {
    events.push('entered')
    await Promise.resolve()
    events.push('continued')
  }) as unknown as () => void
  if (false) {
    // @ts-expect-error Consult dispatch callbacks must not return PromiseLike values.
    store.dispatch('discussion-1', first.turn.id, async () => undefined)
  }
  expect(() => store.dispatch('discussion-1', first.turn.id, asynchronousStart)).toThrow(/synchronous|promise|thenable/i)

  await Promise.resolve()
  const after = store.get('discussion-1')
  expect(events).toEqual([])
  expect(after.revision).toBe(before.revision)
  expect(after.turns[0]!.dispatch_started_at).toBeNull()
})

it('records the residual contract when a synchronous callback returns a hidden Promise', async () => {
  const store = new ConsultStore(directory)
  const first = store.reserve(request(directory))
  store.claim('discussion-1', first.turn.id, handle())
  const events: string[] = []
  const hiddenPromise = (() => {
    events.push('entered')
    return Promise.resolve().then(() => { events.push('continued') })
  }) as unknown as () => void

  expect(() => store.dispatch('discussion-1', first.turn.id, hiddenPromise)).toThrow(/promise|thenable/i)
  await Promise.resolve()
  const turn = store.get('discussion-1').turns[0]!
  expect(events).toEqual(['entered', 'continued'])
  expect(turn.dispatch_started_at).not.toBeNull()
})

it('persists grant expiry when a policy changes, even though dispatch is rejected', () => {
  const store = new ConsultStore(directory)
  writeFileSync(join(directory, 'POLICY.md'), 'Allowed once')
  const spec: GrantSpec = {
    ...grantSpec('unused'), source: 'policy_acknowledged', todo_id: undefined,
    policy: { path: 'POLICY.md', digest: digest('Allowed once') },
  }
  store.grant({ id: 'grant', spec, decision, confirmed_digest: digest(spec) })
  const first = store.reserve({ ...request(directory), authorization: { grant_id: 'grant' } })
  store.claim('discussion-1', first.turn.id, handle())
  writeFileSync(join(directory, 'POLICY.md'), 'Not the acknowledged policy')
  expect(() => store.dispatch('discussion-1', first.turn.id, () => 'no')).toThrow(/expired/)
  expect(store.read().grants[0]!.events.at(-1)!.kind).toBe('expired')
})

it('freezes a paused Todo and retains its in-flight result without permitting synthesis', () => {
  const todos = new TodoStore(directory)
  const todoId = todos.add({ ref: null, title: 'Test', type: 'feature' }).id!
  const store = new ConsultStore(directory)
  const first = store.reserve({ ...request(directory), todo_id: todoId, expected_todo: store.todoSnapshot(todoId) })
  store.claim('discussion-1', first.turn.id, handle())
  const yamlPath = join(directory, 'todos.yaml')
  const data = parse(readFileSync(yamlPath, 'utf8'))
  data.todos[0].status = 'paused'
  writeFileSync(yamlPath, stringify(data))
  const settled = store.settle('discussion-1', first.turn.id, result())
  expect(settled.late).toBe(true)
  expect(() => store.reserve({ ...request(directory, 'request-2'), todo_id: todoId })).toThrow(/paused/)
  expect(store.readResult(settled)?.text).toBe('Advisory text')
  expect(() => store.synthesize('discussion-1', store.get('discussion-1').revision, {
    id: 's1', author: 'main', text: 'My synthesis', sources: [{ turn_id: settled.id, digest: settled.output_digest! }],
  })).toThrow(/paused|late/)
})

it('records stop-wait separately and never adopts an abandoned late response', () => {
  const store = new ConsultStore(directory)
  const first = store.reserve(request(directory))
  store.claim('discussion-1', first.turn.id, handle())
  expect(store.control('discussion-1', first.turn.id, 'stop_wait', decision).lifecycle).toBe('running')
  store.control('discussion-1', first.turn.id, 'abandon', decision)
  const settled = store.settle('discussion-1', first.turn.id, result())
  expect(settled).toMatchObject({ late: true, outcome: 'returned' })
  expect(() => store.synthesize('discussion-1', store.get('discussion-1').revision, {
    id: 's1', author: 'main', text: 'Adopt this', sources: [{ turn_id: settled.id, digest: settled.output_digest! }],
  })).toThrow(/late/)
})

it('versions synthesis with optimistic concurrency and appends user decisions without changing Todo', () => {
  const store = new ConsultStore(directory)
  const first = store.reserve(request(directory))
  const settled = store.settle('discussion-1', first.turn.id, result())
  const revision = store.get('discussion-1').revision
  const synthesis = { id: 's1', author: 'main', text: 'Summary', sources: [{ turn_id: settled.id, digest: settled.output_digest! }] }
  store.synthesize('discussion-1', revision, synthesis)
  expect(() => store.synthesize('discussion-1', revision, { ...synthesis, id: 's2' })).toThrow(/revision/)
  const after = store.decide('discussion-1', store.get('discussion-1').revision, {
    id: 'd1', decision, outcome: 'adopt', synthesis_id: 's1', note: 'Use this design.',
  })
  expect(after.decisions).toHaveLength(1)
  expect(existsSync(join(directory, 'todos.yaml'))).toBe(false)
  expect(store.history('discussion-1', 'codex').map(item => item.source)).toEqual([expect.stringContaining('decision:d1:')])
})

it('purges only raw data after exact confirmation, retains audit facts and refuses resurrection', () => {
  const store = new ConsultStore(directory)
  const first = store.reserve(request(directory))
  const settled = store.settle('discussion-1', first.turn.id, result('PRIVATE-ADVICE'))
  const preview = store.purgePreview('discussion-1')
  expect(() => store.purgeRaw('discussion-1', 'a'.repeat(64), decision)).toThrow(/preview/)
  store.purgeRaw('discussion-1', preview.digest, decision)
  const discussion = store.get('discussion-1')
  expect(discussion.turns[0]).toMatchObject({ raw_purged: true, output_digest: settled.output_digest })
  expect(store.readResult(discussion.turns[0]!)).toBeNull()
  expect(store.read().discussions[0]!.decisions[0]!.outcome).toBe('purge_raw')
  expect(readdirSync(join(directory, 'consult')).filter(file => file.endsWith('.json'))).toEqual([])
  expect(() => store.settle('discussion-1', first.turn.id, result('PRIVATE-ADVICE'))).toThrow(/purged/)
  expect(store.purgeRaw('discussion-1', preview.digest, decision).purged).toBe(true)
  expect(() => store.purgeRaw('discussion-1', preview.digest, { source: 'different', statement: 'Other decision' })).toThrow(/different decision/)
})

it('requires an actual authorization source and gives current denial precedence', () => {
  const store = new ConsultStore(directory)
  expect(() => store.reserve({ ...request(directory), authorization: {} })).toThrow(/authorization/i)
  expect(() => store.reserve({
    ...request(directory), authorization: { explicit_once: decision, denied: true },
  })).toThrow(/denied/i)
})

it('purges crash-left attributable raw pending copies but does not touch unrelated files', () => {
  const store = new ConsultStore(directory)
  const first = store.reserve(request(directory))
  store.settle('discussion-1', first.turn.id, result())
  const root = join(directory, 'consult')
  const orphan = `${first.turn.id}.result.json.11111111-2222-3333-4444-555555555555.pending`
  writeFileSync(join(root, orphan), 'Unlinked raw response')
  writeFileSync(join(root, 'unrelated.pending'), 'Preserve me')
  const preview = store.purgePreview('discussion-1')
  store.purgeRaw('discussion-1', preview.digest, decision)
  expect(existsSync(join(root, orphan))).toBe(false)
  expect(existsSync(join(root, 'unrelated.pending'))).toBe(true)
})

it('requires a new purge confirmation when a retry encounters new or changed raw files', () => {
  const store = new ConsultStore(directory)
  const first = store.reserve(request(directory))
  store.settle('discussion-1', first.turn.id, result())
  const root = join(directory, 'consult')
  const canonical = join(root, `${first.turn.id}.result.json`)
  const original = readFileSync(canonical)
  const preview = store.purgePreview('discussion-1')
  store.purgeRaw('discussion-1', preview.digest, decision)
  writeFileSync(canonical, original)
  expect(store.purgeRaw('discussion-1', preview.digest, decision).purged).toBe(true)
  writeFileSync(canonical, 'Changed after approval')
  expect(() => store.purgeRaw('discussion-1', preview.digest, decision)).toThrow(/changed|confirmation/)
  expect(readFileSync(canonical, 'utf8')).toBe('Changed after approval')
  const added = join(root, `${first.turn.id}.result.json.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pending`)
  writeFileSync(added, 'A newly restored raw copy')
  expect(() => store.purgeRaw('discussion-1', preview.digest, decision)).toThrow(/changed|confirmation/)
  const current = store.purgePreview('discussion-1')
  expect(current.turns[0]!.files).toHaveLength(2)
  store.purgeRaw('discussion-1', current.digest, decision)
  expect(existsSync(canonical)).toBe(false)
  expect(existsSync(added)).toBe(false)
})

function reconcileInput(store: ConsultStore, turnId: string) {
  const discussion = store.get('discussion-1')
  const turn = discussion.turns.find(item => item.id === turnId)!
  const observation = store.observeRelease('discussion-1', turnId, discussion.revision)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
  return {
    id: 'reconcile-1', expected_revision: observation.revision, observation_id: observation.id,
    decision: { source: 'fixture:user:release', statement: 'Release only local occupancy; remote work or billing may continue.' },
    accept_remote_uncertainty: true as const,
    report: {
      source: 'host_report' as const, actor: 'fixture-operator', locator: 'fixture:process-tree-report',
      machine: processes.localMachine(), observed_at: new Date().toISOString(),
      method: 'Inspect original handles and their descendants.', scope: `All local processes for ${turnId}, including unrecorded descendants.`,
      handles_covered: [turn.supervisor, turn.advisor].filter(item => item !== null),
      all_descendants_stopped: true as const, unresolved: [],
    },
  }
}

function lostTurn(store: ConsultStore) {
  const first = store.reserve(request(directory))
  const supervisor = { ...handle(), machine: processes.localMachine() }
  store.claim('discussion-1', first.turn.id, supervisor)
  store.dispatch('discussion-1', first.turn.id, () => undefined)
  store.attach('discussion-1', first.turn.id, { ...supervisor, pid: supervisor.pid + 1 })
  const lost = { ...result(), outcome: 'failed' as const, text: null, unresolved: ['No terminal receipt; descendants or remote request may still be running.'] }
  store.settle('discussion-1', first.turn.id, lost)
  return first.turn.id
}

function observeStopped() {
  return vi.spyOn(processes, 'observeProcess').mockImplementation(() => ({
    state: 'stopped', observed_at: new Date().toISOString(), reason: 'Fixture OS reports the PID absent.',
  }))
}

it('releases only local occupancy by attestation without changing the immutable result or redispatching', () => {
  const store = new ConsultStore(directory)
  const turnId = lostTurn(store)
  const before = store.get('discussion-1').turns[0]!
  const bytes = readFileSync(join(directory, 'consult', `${turnId}.result.json`))
  const observe = observeStopped()
  const input = reconcileInput(store, turnId)
  expect(() => store.reserve(request(directory, 'request-2'))).toThrow(/running|unresolved/)
  const released = store.reconcile('discussion-1', turnId, input)
  expect(released).toMatchObject({
    lifecycle: 'reconciled_by_attestation', outcome: before.outcome, output_digest: before.output_digest,
    unresolved: before.unresolved, late: true,
    reconciliations: [{
      id: input.id, released: 'local_occupancy_only', remote_generation: 'unknown', remote_consumption: 'unknown',
      operator_attestation: input.report,
      local_handles: [{ observation: { state: 'stopped' } }, { observation: { state: 'stopped' } }],
    }],
  })
  expect(readFileSync(join(directory, 'consult', `${turnId}.result.json`))).toEqual(bytes)
  expect(store.reconcile('discussion-1', turnId, input)).toEqual(released)
  expect(observe).toHaveBeenCalledTimes(4)
  expect(() => store.reconcile('discussion-1', turnId, { ...input, expected_revision: input.expected_revision + 1 })).toThrow(/conflict/i)
  expect(() => store.reconcile('discussion-1', turnId, { ...input, report: { ...input.report, method: 'Different report' } })).toThrow(/conflict/i)
  expect(() => store.reconcile('discussion-1', turnId, { ...input, id: 'reconcile-2', expected_revision: store.get('discussion-1').revision })).toThrow(/already|released/i)
  expect(() => store.reserve({ ...request(directory, 'request-2'), authorization: {} })).toThrow(/authorization/i)
  expect(store.reserve(request(directory, 'request-2')).replayed).toBe(false)
  expect(existsSync(join(directory, 'todos.yaml'))).toBe(false)
})

it.each(['running', 'unknown'] as const)('refuses local release while an original process is %s', state => {
  const store = new ConsultStore(directory)
  const turnId = lostTurn(store)
  vi.spyOn(processes, 'observeProcess').mockReturnValue({ state, observed_at: new Date().toISOString(), reason: 'Fixture observation' })
  expect(() => store.reconcile('discussion-1', turnId, reconcileInput(store, turnId))).toThrow(/running|unknown/i)
  expect(store.get('discussion-1').turns[0]!.lifecycle).toBe('reconciling')
})

it('requires exact handle coverage, current revision and a report made after dispatch', () => {
  const store = new ConsultStore(directory)
  const turnId = lostTurn(store)
  observeStopped()
  const input = reconcileInput(store, turnId)
  expect(() => store.reconcile('discussion-1', turnId, { ...input, expected_revision: input.expected_revision - 1 })).toThrow(/revision/i)
  expect(() => store.reconcile('discussion-1', turnId, { ...input, report: { ...input.report, handles_covered: input.report.handles_covered.slice(1) } })).toThrow(/handle/i)
  expect(() => store.reconcile('discussion-1', turnId, { ...input, report: { ...input.report, observed_at: '2000-01-01T00:00:00.000Z' } })).toThrow(/report|observ/i)
  expect(() => store.reconcile('discussion-1', turnId, { ...input, report: { ...input.report, observed_at: new Date(Date.now() + 60_000).toISOString() } })).toThrow(/report|future/i)
  expect(() => store.reconcile('discussion-1', turnId, { ...input, report: { ...input.report, machine: { ...input.report.machine, hostname: 'another-machine' } } })).toThrow(/machine/i)
  expect(() => store.reconcile('discussion-1', turnId, { ...input, report: { ...input.report, unresolved: ['Descendants not inspected'] } })).toThrow()
  expect(() => reconcileInputSchema.parse({ ...input, accept_remote_uncertainty: false })).toThrow()
  expect(() => store.reconcile('discussion-1', turnId, { ...input, decision: { source: '', statement: '' } })).toThrow()
})

it('never treats a reused PID with an unknown original start time as stopped', () => {
  const store = new ConsultStore(directory)
  const first = store.reserve(request(directory))
  store.claim('discussion-1', first.turn.id, { ...handle(), machine: processes.localMachine(), started_at: null })
  vi.spyOn(processes, 'observeProcess').mockReturnValue({ state: 'replaced', observed_at: new Date().toISOString(), reason: 'Different incarnation' })
  expect(() => store.reconcile('discussion-1', first.turn.id, reconcileInput(store, first.turn.id))).toThrow(/start|incarnation/i)
})

it('accepts a known replaced incarnation but refuses handles from another machine', () => {
  const store = new ConsultStore(directory)
  const first = store.reserve(request(directory))
  store.claim('discussion-1', first.turn.id, { ...handle(), machine: processes.localMachine() })
  vi.spyOn(processes, 'observeProcess').mockReturnValue({ state: 'replaced', observed_at: new Date().toISOString(), reason: 'Different incarnation' })
  const released = store.reconcile('discussion-1', first.turn.id, reconcileInput(store, first.turn.id))
  expect(released.reconciliations[0]!.local_handles[0]!.observation.state).toBe('replaced')
  const second = store.reserve(request(directory, 'request-2'))
  store.claim('discussion-1', second.turn.id, { ...handle(), machine: { hostname: 'foreign', platform: process.platform } })
  expect(() => store.reconcile('discussion-1', second.turn.id, { ...reconcileInput(store, second.turn.id), id: 'reconcile-2' })).toThrow(/machine/i)
})

it('preserves release and excludes a later published answer from history and synthesis', () => {
  const store = new ConsultStore(directory)
  const first = store.reserve(request(directory))
  store.claim('discussion-1', first.turn.id, { ...handle(), machine: processes.localMachine() })
  store.dispatch('discussion-1', first.turn.id, () => undefined)
  observeStopped()
  store.reconcile('discussion-1', first.turn.id, reconcileInput(store, first.turn.id))
  expect(store.get('discussion-1').turns[0]!.outcome).toBeNull()
  expect(() => store.dispatch('discussion-1', first.turn.id, () => { throw new Error('Unexpected spawn') })).toThrow(/running|started/i)
  expect(store.claim('discussion-1', first.turn.id, handle())).toBe(false)
  const late = store.settle('discussion-1', first.turn.id, result('Late answer'))
  expect(late).toMatchObject({ lifecycle: 'reconciled_by_attestation', outcome: 'returned', late: true })
  expect(store.history('discussion-1', 'claude')).toEqual([])
  expect(() => store.synthesize('discussion-1', store.get('discussion-1').revision, {
    id: 'late-synthesis', author: 'main', text: 'Use late advice',
    sources: [{ turn_id: first.turn.id, digest: late.output_digest! }],
  })).toThrow(/late|complete/i)
  expect(() => store.settle('discussion-1', first.turn.id, result('Replace late answer'))).toThrow(/immutable/i)
  expect(store.reserve(request(directory, 'request-2')).replayed).toBe(false)
})

it('keeps consumed allowance and Todo data unchanged and requires separate purge confirmation', () => {
  const store = new ConsultStore(directory)
  const todos = new TodoStore(directory)
  const todoId = todos.add({ ref: null, title: 'Fixture', type: 'feature' }).id!
  const before = readFileSync(join(directory, 'todos.yaml'))
  const spec = grantSpec(todoId)
  store.grant({ id: 'grant', spec, decision, confirmed_digest: digest(spec) })
  const first = store.reserve({ ...request(directory), todo_id: todoId, expected_todo: store.todoSnapshot(todoId), authorization: { grant_id: 'grant' } })
  store.claim('discussion-1', first.turn.id, { ...handle(), machine: processes.localMachine() })
  observeStopped()
  store.settle('discussion-1', first.turn.id, { ...result(), outcome: 'failed', unresolved: ['Unknown remote consumption'] })
  const grants = store.read().grants
  const oldPreview = store.purgePreview('discussion-1')
  store.reconcile('discussion-1', first.turn.id, reconcileInput(store, first.turn.id))
  expect(store.read().grants).toEqual(grants)
  expect(() => store.reserve({ ...request(directory, 'request-2'), todo_id: todoId, expected_todo: store.todoSnapshot(todoId), authorization: { grant_id: 'grant' } })).toThrow(/exhausted/i)
  expect(() => store.purgeRaw('discussion-1', oldPreview.digest, decision)).toThrow(/preview/i)
  expect(existsSync(join(directory, 'consult', `${first.turn.id}.packet.json`))).toBe(true)
  const current = store.purgePreview('discussion-1')
  store.purgeRaw('discussion-1', current.digest, decision)
  expect(store.get('discussion-1').turns[0]!.reconciliations).toHaveLength(1)
  expect(readFileSync(join(directory, 'todos.yaml'))).toEqual(before)
  expect(store.decide('discussion-1', store.get('discussion-1').revision, {
    id: 'close', decision, outcome: 'close', note: 'Close the released discussion.',
  }).status).toBe('closed')
})

it('refuses an original live local child, then releases after that child actually exits', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, shell: false })
  await once(child, 'spawn')
  const exit = once(child, 'exit')
  try {
    const store = new ConsultStore(directory)
    const first = store.reserve(request(directory))
    store.claim('discussion-1', first.turn.id, await processes.describeProcessAsync(child.pid!))
    expect(() => store.reconcile('discussion-1', first.turn.id, reconcileInput(store, first.turn.id))).toThrow(/running|unknown/i)
    child.kill()
    await exit
    const released = store.reconcile('discussion-1', first.turn.id, reconcileInput(store, first.turn.id))
    expect(released.reconciliations[0]!.local_handles[0]!.observation.state).toBe('stopped')
  }
  finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exit
  }
}, 15_000)

it('rejects a descendant report written while the spawning supervisor could still create unrecorded children', () => {
  const store = new ConsultStore(directory)
  const first = store.reserve(request(directory))
  store.claim('discussion-1', first.turn.id, { ...handle(), machine: processes.localMachine() })
  store.dispatch('discussion-1', first.turn.id, () => undefined)
  const reportTime = new Date().toISOString()
  // The supervisor can still spawn here, then exit before publishing an advisor handle.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
  observeStopped()
  const current = reconcileInput(store, first.turn.id)
  const stale = { ...current, report: { ...current.report, observed_at: reportTime } }
  expect(() => store.reconcile('discussion-1', first.turn.id, stale)).toThrow(/observation|preview|report/i)
  expect(store.get('discussion-1').turns[0]!.lifecycle).toBe('running')
})

it('keeps observation replay stable but invalidates it after control or receipt publication', () => {
  const store = new ConsultStore(directory)
  const turnId = lostTurn(store)
  observeStopped()
  const input = reconcileInput(store, turnId)
  const barrier = store.get('discussion-1').turns[0]!.release_observations[0]!
  expect(store.observeRelease('discussion-1', turnId, input.expected_revision - 1)).toEqual(barrier)
  expect(store.observeRelease('discussion-1', turnId, input.expected_revision)).toEqual(barrier)
  expect(store.get('discussion-1').turns[0]!.release_observations).toHaveLength(1)
  store.control('discussion-1', turnId, 'stop_wait', decision)
  expect(() => store.reconcile('discussion-1', turnId, input)).toThrow(/revision/i)
  expect(() => store.reconcile('discussion-1', turnId, { ...input, expected_revision: store.get('discussion-1').revision })).toThrow(/stale/i)
  const renewed = reconcileInput(store, turnId)
  store.reconcile('discussion-1', turnId, renewed)
  const second = store.reserve(request(directory, 'request-2'))
  store.claim('discussion-1', second.turn.id, { ...handle(), machine: processes.localMachine() })
  const pending = reconcileInput(store, second.turn.id)
  store.settle('discussion-1', second.turn.id, { ...result(), unresolved: ['Unknown descendants'] })
  expect(() => store.reconcile('discussion-1', second.turn.id, { ...pending, id: 'release-2' })).toThrow(/revision/i)
  expect(() => store.reconcile('discussion-1', second.turn.id, {
    ...pending, id: 'release-2', expected_revision: store.get('discussion-1').revision,
  })).toThrow(/stale/i)
})

it('refuses missing supervisor identity rather than interpreting absent handles as no spawn', () => {
  const store = new ConsultStore(directory)
  const first = store.reserve(request(directory))
  expect(() => store.observeRelease('discussion-1', first.turn.id, store.get('discussion-1').revision)).toThrow(/supervisor.*missing/i)
  expect(store.get('discussion-1').turns[0]!).toMatchObject({ lifecycle: 'reserved', release_observations: [] })
})

it('reobserves the original handles at release instead of treating the earlier observation as sufficient', () => {
  const store = new ConsultStore(directory)
  const turnId = lostTurn(store)
  const observation = observeStopped()
  const input = reconcileInput(store, turnId)
  observation.mockReturnValue({ state: 'unknown', observed_at: new Date().toISOString(), reason: 'Current observation failed' })
  expect(() => store.reconcile('discussion-1', turnId, input)).toThrow(/unknown/i)
  expect(store.get('discussion-1').turns[0]!).toMatchObject({ lifecycle: 'reconciling', reconciliations: [] })
})
