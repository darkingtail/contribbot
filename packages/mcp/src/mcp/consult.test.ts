import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, it } from 'vitest'
import { ConsultStore } from '../core/consult/store.js'
import { TodoStore } from '../core/storage/todo-store.js'
import { digest } from '../core/consult/contracts.js'
import { localMachine } from '../core/execution/processes.js'

it('exposes consult tools over real stdio without turning advisory records into task evidence', async () => {
  const home = mkdtempSync(join(tmpdir(), 'consult-stdio-'))
  const directory = join(home, '.contribbot', 'consult-fixture', 'repo')
  const todos = new TodoStore(directory)
  const todo = todos.add({ ref: null, title: 'Fixture', type: 'feature' })
  const store = new ConsultStore(directory)
  const decision = { source: 'fixture:user', statement: 'One synthetic advisor request' }
  const reservation = store.reserve({
    request_id: 'r1', discussion_id: 'd1', todo_id: todo.id!, purpose: 'design', mode: 'fresh',
    expected_todo: store.todoSnapshot(todo.id!),
    packet: { workspace: home, head: null, manifest: [], body: 'synthetic packet',
      digest: digest('synthetic packet'), omitted: [] },
    binding: {
      runtime: 'claude', executable: process.execPath, executable_digest: digest('fixture'),
      runtime_version: 'fixture', binding_version: '1', model: null,
      protocol: 'native-oneshot', transport: 'pipe', execution_location: 'local', model_location: 'unknown',
      write_boundary: 'tool_free', read_boundary: 'tools_disabled',
      disclosure: 'fixture', disclosure_digest: digest('fixture'),
    }, authorization: { explicit_once: decision },
  })
  const turn = store.settle('d1', reservation.turn.id, {
    outcome: 'returned', text: 'Synthetic advice', stdout: '', stderr: '',
    exit_code: 0, signal: null, integrity: 'ok', reason: null, unresolved: [],
  })
  const before = readFileSync(join(directory, 'todos.yaml'))
  const client = new Client({ name: 'consult-fixture', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      fileURLToPath(new URL('./index.ts', import.meta.url))],
    cwd: home,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      HOME: home, USERPROFILE: home, GH_CONFIG_DIR: join(home, 'gh'),
      GH_TOKEN: 'isolated-fixture-no-network', GITHUB_TOKEN: 'isolated-fixture-no-network',
    }, stderr: 'pipe',
  })
  try {
    await client.connect(transport)
    const listing = await client.listTools()
    for (const name of ['consult_start', 'consult_status', 'consult_read', 'consult_control', 'consult_decide', 'consult_purge_raw']) {
      expect(listing.tools.find(tool => tool.name === name)?.inputSchema.required).toContain('repo')
    }
    const context = await client.callTool({ name: 'todo_context', arguments: { repo: 'consult-fixture/repo', todo_id: todo.id } })
    expect(context.structuredContent).toMatchObject({ consultations: { status: 'available', discussions: [{ id: 'd1' }] } })
    const status = await client.callTool({ name: 'consult_read', arguments: { repo: 'consult-fixture/repo', discussion_id: 'd1' } })
    expect(status.structuredContent).toMatchObject({ turns: [{ text: 'Synthetic advice' }] })
    const synthesize = await client.callTool({ name: 'consult_decide', arguments: {
      repo: 'consult-fixture/repo', discussion_id: 'd1', expected_revision: store.get('d1').revision,
      command: { action: 'synthesize', id: 's1', author: 'primary', text: 'Synthesis',
        sources: [{ turn_id: turn.id, digest: turn.output_digest }] },
    } })
    expect(synthesize.isError, JSON.stringify(synthesize)).not.toBe(true)
    const forged = await client.callTool({ name: 'consult_decide', arguments: {
      repo: 'consult-fixture/repo', discussion_id: 'd1', expected_revision: store.get('d1').revision,
      command: { action: 'decision', id: 'd2', outcome: 'done', note: 'Pretend accepted', decision },
    } })
    expect(forged.isError).toBe(true)
    const recovery = store.reserve({
      request_id: 'r2', discussion_id: 'd2', todo_id: todo.id!, purpose: 'review', mode: 'fresh',
      expected_todo: store.todoSnapshot(todo.id!),
      packet: store.readPacket(reservation.turn), binding: reservation.turn.binding,
      authorization: { explicit_once: decision },
    })
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true, shell: false })
    await once(child, 'spawn')
    const handle = {
      pid: child.pid!, machine: localMachine(), started_at: null, observed_at: new Date().toISOString(),
    }
    await once(child, 'exit')
    store.claim('d2', recovery.turn.id, handle)
    store.settle('d2', recovery.turn.id, {
      outcome: 'failed', text: null, stdout: '', stderr: '', exit_code: 0, signal: null,
      integrity: 'ok', reason: 'Fixture lost receipt', unresolved: ['Remote generation and consumption unknown.'],
    })
    const recoveryPreview = await client.callTool({ name: 'consult_control', arguments: { repo: 'consult-fixture/repo', command: {
      action: 'reconcile', id: 'release-1', discussion_id: 'd2', turn_id: recovery.turn.id,
      expected_revision: store.get('d2').revision,
    } } })
    expect(recoveryPreview.isError, JSON.stringify(recoveryPreview)).not.toBe(true)
    const observation = (recoveryPreview.structuredContent as {
      release_observation: { id: string; revision: number };
    }).release_observation
    await delay(2)
    const recoveryCommand = {
      action: 'reconcile', id: 'release-1', discussion_id: 'd2', turn_id: recovery.turn.id,
      expected_revision: observation.revision, observation_id: observation.id, decision, accept_remote_uncertainty: true,
      report: {
        source: 'host_report', actor: 'fixture-runner', locator: 'fixture:child-exit',
        machine: localMachine(), observed_at: new Date().toISOString(),
        method: 'Awaited exit of a Node child whose only command was process.exit(0).',
        scope: 'The exact synthetic process, with no child creation or model call.',
        handles_covered: [handle], all_descendants_stopped: true, unresolved: [],
      },
    }
    const released = await client.callTool({ name: 'consult_control', arguments: { repo: 'consult-fixture/repo', command: recoveryCommand } })
    expect(released.isError, JSON.stringify(released)).not.toBe(true)
    expect(released.structuredContent).toMatchObject({
      turn: { lifecycle: 'reconciled_by_attestation', outcome: 'failed', reconciliations: [{ released: 'local_occupancy_only' }] },
    })
    const replayed = await client.callTool({ name: 'consult_control', arguments: { repo: 'consult-fixture/repo', command: recoveryCommand } })
    expect(replayed.structuredContent).toEqual(released.structuredContent)
    const observed = await client.callTool({ name: 'consult_status', arguments: { repo: 'consult-fixture/repo', discussion_id: 'd2' } })
    expect(observed.structuredContent).toMatchObject({
      turns: [{ local_occupancy: 'released', lifecycle: 'reconciled_by_attestation', reconciliations: [{ remote_consumption: 'unknown' }] }],
    })
    expect(readFileSync(join(directory, 'todos.yaml'))).toEqual(before)
  }
  finally {
    await client.close()
    await transport.close()
    rmSync(home, { recursive: true, force: true })
  }
}, 20_000)
