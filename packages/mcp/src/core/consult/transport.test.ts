import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pipeTransport } from './transport.js'
import { nativeBindings } from './binding.js'

let cwd: string
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'consult transport ')) })
afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })
const run = (script: string, extras = {}, control = { onProcess: vi.fn(), shouldTerminate: () => false }) =>
  pipeTransport.run({
    executable: process.execPath, argv: ['-e', script], cwd,
    env: { ...process.env, ...extras },
  }, 'question with Unicode: \u4e2d\u6587', nativeBindings.claude, control)

it('streams Unicode via stdin and requires a terminal answer without shell interpolation', async () => {
  const output = await run(`
    let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => input+=s);
    process.stdin.on('end', () => {
      console.log(JSON.stringify({type:'system',subtype:'init',tools:[]}));
      console.log(JSON.stringify({type:'result',result:input+' '+process.cwd(),is_error:false}));
    });
  `)
  expect(output).toMatchObject({ outcome: 'returned', integrity: 'ok', unresolved: [] })
  expect(output.text).toContain('\u4e2d\u6587')
  expect(output.text).toContain(cwd)
}, 10_000)

it('bounds output, rejects incomplete frames and redacts explicitly inherited auth values', async () => {
  const malformed = await run('console.log("incomplete")')
  expect(malformed.outcome).toBe('failed')
  const large = await run('process.stdout.write("x".repeat(1100000))')
  expect(large).toMatchObject({ outcome: 'failed', integrity: 'truncated', text: null })
  const secret = 'fixture-token-only-123456'
  const redacted = await run('console.error(process.env.ANTHROPIC_API_KEY)', { ANTHROPIC_API_KEY: secret })
  expect(redacted.stderr).not.toContain(secret)
  expect(redacted.stderr).toContain('[REDACTED]')
}, 15_000)

it('never spawns when the final authorization guard rejects', async () => {
  const onProcess = vi.fn()
  await expect(pipeTransport.run({
    executable: process.execPath, argv: ['-e', 'process.exit(99)'], cwd, env: process.env,
  }, '', nativeBindings.claude, {
    onProcess, shouldTerminate: () => false,
    dispatch: () => { throw new Error('revoked') },
  })).rejects.toThrow('revoked')
  expect(onProcess).not.toHaveBeenCalled()
})

it('does not conflate terminating the parent with establishing descendant liveness', async () => {
  const result = await run('setInterval(()=>{},100)', {}, { onProcess: vi.fn(), shouldTerminate: () => true })
  expect(result.outcome).toBe('cancelled')
  expect(result.unresolved).not.toEqual([])
}, 10_000)

it('retains unresolved liveness after an abnormal exit without a terminal protocol receipt', async () => {
  const output = await run('process.exit(7)')
  expect(output.outcome).toBe('failed')
  expect(output.unresolved).not.toEqual([])
}, 10_000)

it('does not treat zero exit with a missing terminal receipt as proof of safe settlement', async () => {
  const output = await run('console.log("not a terminal receipt")')
  expect(output.outcome).toBe('failed')
  expect(output.unresolved).not.toEqual([])
}, 10_000)
