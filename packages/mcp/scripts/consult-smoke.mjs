import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { projectDirectory } from 'contribbot-core/repository/ref'
import { stringify } from 'yaml'
import { consultDecide, consultPrepare, consultRead, consultRequest, consultStatus, createConsultStore } from '../dist/index.js'

const execute = promisify(execFile)
const [runtime, executable] = process.argv.slice(2)
if (!['claude', 'codex'].includes(runtime) || !executable) {
  throw new Error('Usage: node scripts/consult-smoke.mjs <claude|codex> <absolute-native-executable>. Makes one real model call with synthetic data.')
}
if (!/^(?:[A-Za-z]:[\\/]|[\\/])/.test(executable)) {
  throw new Error('The Provider executable must be an absolute native executable path.')
}

const originalHome = homedir()
const home = mkdtempSync(join(tmpdir(), 'contribbot-consult-smoke-'))
const workspace = join(home, 'workspace')
mkdirSync(workspace)
process.env.CLAUDE_CONFIG_DIR ??= join(originalHome, '.claude')
process.env.CODEX_HOME ??= join(originalHome, '.codex')
process.env.HOME = home
process.env.USERPROFILE = home

const repo = { platform: 'github', instance: 'https://github.com', path: 'consult-smoke/synthetic' }
const dataDirectory = projectDirectory(repo, join(home, '.contribbot'))
const runnerCli = fileURLToPath(new URL('../../runner/dist/cli.js', import.meta.url))
const question = 'A synthetic counter displays 0 initially, increments to 1, and reset returns it to 0. Give one short suggested test. Do not use tools or read any files.'
const authorization = {
  explicit_once: {
    source: 'manual:consult-smoke-command',
    statement: 'Run one real advisor smoke call with the disclosed read/write boundary.',
  },
}

async function runRunner(args) {
  const result = await execute(process.execPath, [runnerCli, ...args], {
    cwd: process.cwd(), env: process.env, shell: false, windowsHide: true,
    maxBuffer: 512 * 1024, encoding: 'utf8',
  })
  if (result.stderr.trim()) console.error(result.stderr.trim())
  return JSON.parse(result.stdout)
}

const inspected = await runRunner(['provider', 'inspect', '--runtime', runtime, '--executable', executable])
assert.ok(inspected.binding)
assert.equal(existsSync(join(home, '.contribbot')), false, 'Provider inspection must not create Consult records.')
mkdirSync(dataDirectory, { recursive: true })
writeFileSync(join(dataDirectory, 'config.yaml'), stringify({
  schema_version: 3, repository: repo, lifecycle: { status: 'active' },
  parent: { status: 'unknown' }, tracking: { status: 'pending' },
}))
const input = {
  repo, request_id: 'smoke-one', purpose: 'research', mode: 'fresh', binding: inspected.binding,
  packet: { workspace, question },
}
const preview = await consultPrepare(input)
console.log(JSON.stringify({ phase: 'preview', runtime, data: home, disclosure: preview.preview.binding.disclosure }))

const requested = await consultRequest({ ...input, authorization, confirmed_preview: preview.preview.digest })
console.log(JSON.stringify({ phase: 'requested', ...requested }))
assert.equal(requested.status, 'pending')
assert.equal(requested.replayed, false)
assert.deepEqual(await consultRequest({ ...input, authorization, confirmed_preview: preview.preview.digest }), {
  schema_version: 1, discussion_id: requested.discussion_id, turn_id: requested.turn_id, replayed: true,
  status: 'pending', status_tool: 'consult_status', read_tool: 'consult_read',
  notes: 'Original reservation returned without starting another Provider. Start the exact turn with contribbot-run.',
})

const started = await runRunner(requested.runner.args)
console.log(JSON.stringify({ phase: 'started', ...started }))
let turn
for (let attempt = 0; attempt < 180; attempt++) {
  const status = await consultStatus({ repo, discussion_id: requested.discussion_id, turn_id: requested.turn_id })
  turn = status.turns[0]
  if (['settled', 'reconciling', 'reconciled_by_attestation'].includes(turn.lifecycle)) break
  await new Promise(resolve => setTimeout(resolve, 1000))
}

// Recovery is explicit and never retries the Provider. It is useful when a
// worker published a receipt after the status reader observed the reservation.
if (!['settled', 'reconciling', 'reconciled_by_attestation'].includes(turn?.lifecycle)) {
  const recovered = await runRunner([
    'consult', 'recover', '--directory', dataDirectory,
    '--discussion', requested.discussion_id, '--turn', requested.turn_id,
  ])
  console.log(JSON.stringify({ phase: 'recover', ...recovered }))
  const status = await consultStatus({ repo, discussion_id: requested.discussion_id, turn_id: requested.turn_id })
  turn = status.turns[0]
}

const read = await consultRead({ repo, discussion_id: requested.discussion_id, turn_id: requested.turn_id })
if (turn.outcome !== 'returned' || turn.lifecycle !== 'settled') {
  console.log(JSON.stringify({ phase: 'not-passed', lifecycle: turn.lifecycle, outcome: turn.outcome,
    reason: read.turns[0].reason, unresolved: turn.unresolved, data: home }))
  process.exitCode = 1
}
else {
  assert.ok(read.turns[0].text?.trim())
  const store = createConsultStore(dataDirectory)
  await consultDecide({
    repo, discussion_id: requested.discussion_id, expected_revision: store.get(requested.discussion_id).revision,
    command: {
      action: 'synthesize', id: 'smoke-synthesis', author: 'smoke-harness',
      text: 'Synthetic smoke verifies readable advisory output, not correctness of the advice.',
      sources: [{ turn_id: turn.id, digest: turn.output_digest }],
    },
  })
  assert.equal((await consultRequest({ ...input, authorization, confirmed_preview: preview.preview.digest })).replayed, true)
  assert.equal(store.get(requested.discussion_id).turns.length, 1)
  assert.equal(existsSync(join(store.directory, 'todos.yaml')), false)
  assert.ok(readFileSync(join(store.directory, 'consult', 'discussions.yaml'), 'utf8').includes('smoke-synthesis'))
  console.log(JSON.stringify({ phase: 'passed', runtime, output_bytes: Buffer.byteLength(read.turns[0].text),
    replayed: true, todo_unchanged: true, data: home }))
}
// Keep this isolated fixture for inspection; do not erase records on failures or uncertainty.
