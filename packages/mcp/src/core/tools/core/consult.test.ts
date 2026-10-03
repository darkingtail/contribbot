import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recoverConsultTurn } from 'contribbot-core'
import { digest } from '../../consult/contracts.js'
import { todoConsultations } from '../../consult/projection.js'
import { localMachine } from '../../execution/processes.js'
import { TodoStore } from '../../storage/todo-store.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'
import { consultPrepare, consultRequest, consultStatus, consultRead, consultControl, consultDecide, consultPurgeRaw, consultStart, consultStore } from './consult.js'

let home: string
const repo: RepositoryRef = {
  platform: 'github', instance: 'https://github.com', path: 'consult-fixture/repo',
}
const decision = { source: 'fixture:user', statement: 'Ask this advisor once with these materials and disclosure.' }
const binding = {
  runtime: 'claude' as const, executable: process.execPath, executable_digest: digest('fixture'),
  runtime_version: 'fixture', binding_version: '1' as const, model: null,
  protocol: 'native-oneshot' as const, transport: 'pipe' as const,
  execution_location: 'local' as const, model_location: 'unknown' as const,
  write_boundary: 'tool_free' as const, read_boundary: 'tools_disabled' as const,
  disclosure: 'Fixture disclosure', disclosure_digest: digest('Fixture disclosure'),
}

function initializeProject(repository = repo) {
  new RepoConfig(projectDirectory(repository)).save({
    schema_version: 3, repository, lifecycle: { status: 'active' },
    parent: { status: 'unknown' }, tracking: { status: 'pending' },
  })
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'consult-service-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  initializeProject()
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { force: true, recursive: true })
})

function input(extra: Record<string, unknown> = {}) {
  return {
    repo, request_id: 'request-1', binding,
    packet: { workspace: home, question: 'Review a synthetic counter' },
    authorization: { explicit_once: decision },
    ...extra,
  }
}

async function reserve(extra: Record<string, unknown> = {}) {
  const raw = input(extra)
  const { authorization: _authorization, ...prepareInput } = raw
  void _authorization
  const preview = await consultPrepare(prepareInput)
  const receipt = await consultRequest({ ...raw, confirmed_preview: preview.preview.digest })
  return { raw, preview, receipt }
}

function finish(discussionId: string, turnId: string) {
  return consultStore(repo).settle(discussionId, turnId, {
    outcome: 'returned', text: 'Advice, not evidence', stdout: 'synthetic receipt', stderr: '',
    exit_code: 0, signal: null, integrity: 'ok', reason: null, unresolved: [],
  })
}

it('prepares and requests without inspecting or launching a Provider', async () => {
  const { preview, receipt } = await reserve()
  expect(preview.dispatched).toBe(false)
  expect(receipt).toMatchObject({ status: 'pending', replayed: false })
  expect(receipt.runner).toMatchObject({ command: 'contribbot-run' })
  expect(existsSync(join(projectDirectory(repo), 'consult', 'discussions.yaml'))).toBe(true)
})

it('isolates discussions with the same path across instances and platforms', async () => {
  const github = await reserve()
  const selfHosted: RepositoryRef = {
    platform: 'gitlab', instance: 'https://code.example.test/gitlab', path: repo.path,
  }
  const anotherInstance: RepositoryRef = {
    ...selfHosted, instance: 'https://other.example.test/gitlab',
  }
  initializeProject(selfHosted)
  initializeProject(anotherInstance)
  const gitlab = await reserve({ repo: selfHosted, request_id: 'request-gitlab' })
  await reserve({ repo: anotherInstance, request_id: 'request-gitlab' })

  expect(gitlab.receipt.discussion_id).not.toBe(github.receipt.discussion_id)
  expect(consultStore(repo).directory).not.toBe(consultStore(selfHosted).directory)
  expect(consultStore(selfHosted).directory).not.toBe(consultStore(anotherInstance).directory)
  expect((await consultStatus({ repo })).discussions).toHaveLength(1)
  expect((await consultStatus({ repo: selfHosted })).discussions).toHaveLength(1)
  expect((await consultStatus({ repo: anotherInstance })).discussions).toHaveLength(1)
  await expect(consultRead({ repo: selfHosted, discussion_id: github.receipt.discussion_id! }))
    .rejects.toThrow(/not found/i)
})

it('requires an explicit repository identity for Consult', async () => {
  await expect(consultPrepare({ ...input(), repo: repo.path })).rejects.toThrow()
  expect(() => consultStore(repo.path as unknown as RepositoryRef)).toThrow()
})

it('releases an explicitly abandoned reservation that was never dispatched', async () => {
  const { receipt } = await reserve()
  const before = await consultStatus({ repo, discussion_id: receipt.discussion_id! })
  expect(before.turns![0]).toMatchObject({ lifecycle: 'reserved', local_occupancy: 'held' })

  const released = await consultControl({
    repo,
    command: {
      action: 'turn', discussion_id: receipt.discussion_id!, turn_id: receipt.turn_id!,
      control: 'abandon', decision,
    },
  })
  expect(released.turn).toMatchObject({ lifecycle: 'released_before_dispatch', late: true })

  const after = await consultStatus({ repo, discussion_id: receipt.discussion_id! })
  expect(after.turns![0]).toMatchObject({ lifecycle: 'released_before_dispatch', local_occupancy: 'released' })

  const next = await reserve({ request_id: 'request-2', discussion_id: receipt.discussion_id })
  expect(next.receipt).toMatchObject({ replayed: false, discussion_id: receipt.discussion_id })
  expect(next.receipt.turn_id).not.toBe(receipt.turn_id)
})

it('keeps the old consult_start name as a non-executing migration response', async () => {
  const directory = projectDirectory(repo)
  const beforeConfig = readFileSync(join(directory, 'config.yaml'))
  const beforeEntries = readdirSync(directory).sort()
  const result = await consultStart({
    repo, request_id: 'legacy-request', advisor: { runtime: 'claude', executable: process.execPath },
    packet: { workspace: home, question: 'Legacy request' }, authorization: { explicit_once: decision },
  })
  expect(result).toMatchObject({ unsupported: true, replacement: { prepare_tool: 'consult_prepare', request_tool: 'consult_request' } })
  expect(readFileSync(join(directory, 'config.yaml'))).toEqual(beforeConfig)
  expect(readdirSync(directory).sort()).toEqual(beforeEntries)
})

it('returns the original reservation for an identical request and rejects changed content', async () => {
  const { raw, preview, receipt } = await reserve()
  const replay = await consultRequest({ ...raw, confirmed_preview: preview.preview.digest })
  expect(replay).toMatchObject({ replayed: true, turn_id: receipt.turn_id, status: 'pending' })
  await expect(consultRequest({ ...raw, packet: { ...raw.packet, question: 'Different' }, confirmed_preview: preview.preview.digest }))
    .rejects.toThrow(/different content/i)
})

it('rejects a Todo snapshot changed between preview and locked reservation', async () => {
  const store = consultStore(repo)
  const todos = new TodoStore(store.directory)
  const todo = todos.add({ ref: null, title: 'Concurrent Todo', type: 'feature' })
  const raw = input({ todo_id: todo.id })
  const { preview } = await (async () => {
  const { authorization: _authorization, ...prepareInput } = raw
  void _authorization
  return { preview: await consultPrepare(prepareInput) }
  })()
  todos.activateExecution(0)
  await expect(consultRequest({ ...raw, confirmed_preview: preview.preview.digest })).rejects.toThrow(/preview changed/i)
})

it('keeps Todo data unchanged while recording synthesis and purging only raw consultation data', async () => {
  const store = consultStore(repo)
  const todo = new TodoStore(store.directory).add({ ref: null, title: 'Synthetic Todo', type: 'feature' })
  const before = readFileSync(join(store.directory, 'todos.yaml'))
  const { receipt } = await reserve({ todo_id: todo.id })
  const turn = finish(receipt.discussion_id!, receipt.turn_id!)
  await consultDecide({
    repo, discussion_id: receipt.discussion_id!, expected_revision: store.get(receipt.discussion_id!).revision,
    command: { action: 'synthesize', id: 's1', author: 'main', text: 'A considered synthesis',
      sources: [{ turn_id: turn.id, digest: turn.output_digest! }] },
  })
  await consultDecide({
    repo, discussion_id: receipt.discussion_id!, expected_revision: store.get(receipt.discussion_id!).revision,
    command: { action: 'decision', id: 'd1', outcome: 'adopt', synthesis_id: 's1',
      note: 'Use this design, not an acceptance decision', decision },
  })
  expect(todoConsultations(store.directory, todo.id!).discussions).toHaveLength(1)
  const purge = await consultPurgeRaw({ repo, discussion_id: receipt.discussion_id! })
  await consultPurgeRaw({ repo, discussion_id: receipt.discussion_id!, confirmed_digest: purge.preview!.digest, decision })
  expect(readFileSync(join(store.directory, 'todos.yaml'))).toEqual(before)
  expect(store.get(receipt.discussion_id!).syntheses).toHaveLength(1)
  expect((await consultRead({ repo, discussion_id: receipt.discussion_id! })).turns![0]!.text).toBeNull()
})

it('does not recover a receipt from consult_status; recover is explicit and idempotent', async () => {
  const { receipt } = await reserve()
  const store = consultStore(repo)
  const turn = store.get(receipt.discussion_id!).turns[0]!
  const result = {
    outcome: 'returned', text: 'Recovered answer', stdout: '', stderr: '',
    exit_code: 0, signal: null, integrity: 'ok', reason: null, unresolved: [],
  }
  store.claim(receipt.discussion_id!, turn.id, {
    pid: process.pid, machine: localMachine(), started_at: null, observed_at: new Date().toISOString(),
  })
  store.dispatch(receipt.discussion_id!, turn.id, () => ({}))
  writeFileSync(join(store.directory, 'consult', `${turn.id}.result.json`), JSON.stringify(result))
  const before = store.get(receipt.discussion_id!).revision
  const status = await consultStatus({ repo, discussion_id: receipt.discussion_id! })
  expect(status.turns![0]).toMatchObject({ lifecycle: 'running', outcome: null })
  expect(store.get(receipt.discussion_id!).revision).toBe(before)
  const recovered = recoverConsultTurn(store, receipt.discussion_id!, receipt.turn_id!)
  expect(recovered).toMatchObject({ lifecycle: 'settled', outcome: 'returned' })
  expect(recoverConsultTurn(store, receipt.discussion_id!, receipt.turn_id!)).toEqual(recovered)
})

it('does not let MCP perform process reconciliation', async () => {
  const { receipt } = await reserve()
  const store = consultStore(repo)
  await expect(consultControl({
    repo,
    command: { action: 'reconcile', id: 'release-1', discussion_id: receipt.discussion_id!, turn_id: receipt.turn_id!,
      expected_revision: store.get(receipt.discussion_id!).revision },
  })).rejects.toThrow(/moved to contribbot-run/i)
})

it('keeps corrupt consultation records from blocking Todo projection', async () => {
  const { receipt } = await reserve()
  const store = consultStore(repo)
  writeFileSync(join(store.directory, 'consult', 'discussions.yaml'), 'invalid: record')
  expect(todoConsultations(store.directory, 't-1')).toMatchObject({ status: 'unavailable', discussions: [] })
  expect(receipt.turn_id).toBeTruthy()
})
