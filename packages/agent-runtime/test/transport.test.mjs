import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MAX_OUTPUT_BYTES, nativeBindings, pipeTransport } from '../dist/index.js'

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'contribbot transport \u4e2d\u6587 '))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const run = (script, extras = {}, control = { onProcess() {}, shouldTerminate: () => false }) =>
    pipeTransport.run({
      executable: process.execPath, argv: ['-e', script], cwd, env: { ...process.env, ...extras },
    }, 'question with Unicode: \u4e2d\u6587', nativeBindings.claude, control)
  return { cwd, run }
}

test('streams Unicode via stdin and preserves cwd without shell interpolation', async t => {
  const { cwd, run } = fixture(t)
  const output = await run(`
    let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => input+=s);
    process.stdin.on('end', () => {
      console.log(JSON.stringify({type:'system',subtype:'init',tools:[]}));
      console.log(JSON.stringify({type:'result',result:input+' '+process.cwd(),is_error:false}));
    });
  `)
  assert.equal(output.outcome, 'returned')
  assert.equal(output.integrity, 'ok')
  assert.deepEqual(output.unresolved, [])
  assert.ok(output.text.includes('\u4e2d\u6587'))
  assert.ok(output.text.includes(cwd))
})

test('bounds output, rejects incomplete frames and redacts inherited auth values', async t => {
  const { run } = fixture(t)
  const malformed = await run('console.log("incomplete")')
  assert.equal(malformed.outcome, 'failed')
  const large = await run('process.stdout.write("x".repeat(1100000))')
  assert.equal(large.outcome, 'failed')
  assert.equal(large.integrity, 'truncated')
  assert.equal(large.text, null)
  assert.ok(Buffer.byteLength(large.stdout) <= MAX_OUTPUT_BYTES)
  const secret = 'fixture-token-only-123456'
  const redacted = await run('console.error(process.env.ANTHROPIC_API_KEY)', { ANTHROPIC_API_KEY: secret })
  assert.ok(!redacted.stderr.includes(secret))
  assert.ok(redacted.stderr.includes('[REDACTED]'))
})

test('never spawns when the final authorization guard rejects', async t => {
  const { cwd } = fixture(t)
  let processes = 0
  await assert.rejects(pipeTransport.run({
    executable: process.execPath, argv: ['-e', 'process.exit(99)'], cwd, env: process.env,
  }, '', nativeBindings.claude, {
    onProcess: () => { processes++ },
    shouldTerminate: () => false,
    dispatch: () => { throw new Error('revoked') },
  }), /revoked/)
  assert.equal(processes, 0)
})

test('terminating the parent does not establish descendant or remote liveness', async t => {
  const { run } = fixture(t)
  const result = await run('setInterval(()=>{},100)', {}, { onProcess() {}, shouldTerminate: () => true })
  assert.equal(result.outcome, 'cancelled')
  assert.notDeepEqual(result.unresolved, [])
})

test('abnormal exit without a terminal receipt retains unresolved liveness', async t => {
  const { run } = fixture(t)
  const output = await run('process.exit(7)')
  assert.equal(output.outcome, 'failed')
  assert.equal(output.exit_code, 7)
  assert.notDeepEqual(output.unresolved, [])
})

test('zero exit without a terminal receipt is not proof of safe settlement', async t => {
  const { run } = fixture(t)
  const output = await run('console.log("not a terminal receipt")')
  assert.equal(output.outcome, 'failed')
  assert.equal(output.exit_code, 0)
  assert.notDeepEqual(output.unresolved, [])
})
