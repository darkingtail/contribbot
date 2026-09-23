import assert from 'node:assert/strict'
import test from 'node:test'
import { pipeTransport, describeProcess, observeProcess, localMachine } from '../dist/index.js'

test('runtime owns process identity observation without domain imports', () => {
  const handle = describeProcess(process.pid)
  assert.deepEqual(handle.machine, localMachine())
  assert.equal(observeProcess(handle).state, 'running')
})

test('pipe transport runs a bounded one-shot and returns a protocol outcome', async () => {
  const result = await pipeTransport.run({
    executable: process.execPath,
    argv: ['-e', 'let input="";process.stdin.on("data",s=>input+=s);process.stdin.on("end",()=>console.log(JSON.stringify({type:"done",text:input})))'],
    cwd: process.cwd(),
    env: process.env,
  }, 'runtime-fixture', {
    protocol: 'fixture',
    terminal: stdout => stdout.includes('"type":"done"'),
    decode: (stdout, exitCode) => ({
      outcome: exitCode === 0 ? 'returned' : 'failed',
      text: stdout,
      reason: null,
    }),
  }, {
    shouldTerminate: () => false,
    onProcess: () => {},
  })
  assert.equal(result.outcome, 'returned')
  assert.match(result.text, /runtime-fixture/)
})

test('pipe transport keeps cancellation distinct from a terminal response', async () => {
  const result = await pipeTransport.run({
    executable: process.execPath,
    argv: ['-e', 'setInterval(()=>{},1000)'],
    cwd: process.cwd(),
    env: process.env,
  }, 'runtime-fixture', {
    protocol: 'fixture',
    terminal: () => false,
    decode: () => ({ outcome: 'failed', text: null, reason: 'Unexpected terminal decode.' }),
  }, {
    shouldTerminate: () => true,
    onProcess: () => {},
  })
  assert.equal(result.outcome, 'cancelled')
  assert.equal(result.text, null)
  assert.notDeepEqual(result.unresolved, [])
})
