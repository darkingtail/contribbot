import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { consultStart, consultStatus, consultRead, consultDecide, ConsultStore } from '../dist/index.js'

const [runtime, executable] = process.argv.slice(2)
if (!['claude', 'codex'].includes(runtime) || !executable || !isAbsolute(executable) || !existsSync(executable)) {
  throw new Error('Usage: node scripts/consult-smoke.mjs <claude|codex> <absolute-native-executable>. Makes one real model call with synthetic data.')
}
const originalHome = homedir()
const home = mkdtempSync(join(tmpdir(), 'contribbot-consult-smoke-'))
const workspace = join(home, 'workspace')
mkdirSync(workspace)
process.env.CLAUDE_CONFIG_DIR ??= join(originalHome, '.claude')
process.env.CODEX_HOME ??= join(originalHome, '.codex')
process.env.HOME = home
process.env.USERPROFILE = home
const repo = 'consult-smoke/synthetic'
const input = {
  repo, request_id: 'smoke-one', purpose: 'research', mode: 'fresh',
  advisor: { runtime, executable },
  packet: {
    workspace,
    question: 'A synthetic counter displays 0 initially, increments to 1, and reset returns it to 0. Give one short suggested test. Do not use tools or read any files.',
  },
  authorization: { explicit_once: { source: 'manual:consult-smoke-command', statement: 'Run one real advisor smoke call with this synthetic packet and the disclosed read/write boundary.' } },
}
const preview = await consultStart(input)
console.log(JSON.stringify({ phase: 'preview', runtime, data: home, disclosure: preview.preview.binding.disclosure }))
const started = await consultStart({ ...input, confirmed_preview: preview.preview.digest })
console.log(JSON.stringify({ phase: 'started', ...started }))
let turn
for (;;) {
  const status = await consultStatus({ repo, discussion_id: started.discussion_id, turn_id: started.turn_id })
  turn = status.turns[0]
  if (turn.lifecycle === 'settled' || turn.lifecycle === 'reconciling') break
  await delay(1000)
}
const read = await consultRead({ repo, discussion_id: started.discussion_id, turn_id: started.turn_id })
if (turn.outcome !== 'returned' || turn.lifecycle !== 'settled') {
  console.log(JSON.stringify({ phase: 'not-passed', lifecycle: turn.lifecycle, outcome: turn.outcome,
    reason: read.turns[0].reason, unresolved: turn.unresolved, data: home }))
  process.exitCode = 1
}
else {
  assert.ok(read.turns[0].text?.trim())
  const store = new ConsultStore(join(home, '.contribbot', 'consult-smoke', 'synthetic'))
  await consultDecide({
    repo, discussion_id: started.discussion_id, expected_revision: store.get(started.discussion_id).revision,
    command: { action: 'synthesize', id: 'smoke-synthesis', author: 'smoke-harness',
      text: 'Synthetic smoke verifies readable advisory output, not correctness of the advice.',
      sources: [{ turn_id: turn.id, digest: turn.output_digest }] },
  })
  const count = store.get(started.discussion_id).turns.length
  const replay = await consultStart({ ...input, confirmed_preview: preview.preview.digest })
  assert.equal(replay.replayed, true)
  assert.equal(store.get(started.discussion_id).turns.length, count)
  assert.equal(existsSync(join(store.directory, 'todos.yaml')), false)
  assert.ok(readFileSync(join(store.directory, 'consult', 'discussions.yaml'), 'utf8').includes('smoke-synthesis'))
  console.log(JSON.stringify({ phase: 'passed', runtime, output_bytes: Buffer.byteLength(read.turns[0].text),
    replayed: true, todo_unchanged: true, data: home }))
}
// Keep only this isolated fixture for inspection; do not erase records on failures or uncertainty.
