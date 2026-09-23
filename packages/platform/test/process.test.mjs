import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { describeProcessAsync, localMachine, observeProcess } from '../dist/index.js'

test('platform observes local identity without an agent or domain package', async () => {
  const handle = await describeProcessAsync(process.pid)
  assert.deepEqual(handle.machine, localMachine())
  assert.ok(handle.started_at !== null, 'the test host must supply a real process start time')
  assert.equal(observeProcess(handle).state, 'running')
  assert.equal(observeProcess({ ...handle, started_at: 0 }).state, 'replaced')
  assert.equal(observeProcess({ ...handle, started_at: null }).state, 'unknown')
  assert.equal(observeProcess({ ...handle, machine: { ...handle.machine, hostname: 'other-test-host' } }).state, 'unknown')
})

test('platform observes a child exit and rejects malformed process handles', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true, stdio: 'ignore', shell: false,
  })
  const closed = once(child, 'close')
  try {
    await once(child, 'spawn')
    const handle = await describeProcessAsync(child.pid)
    assert.equal(observeProcess(handle).state, 'running')
    child.kill()
    await closed
    assert.equal(observeProcess(handle).state, 'stopped')
    assert.throws(() => observeProcess({ ...handle, pid: -1 }), /Invalid process handle/)
    assert.throws(() => observeProcess({ ...handle, machine: null }), /Invalid process handle/)
  }
  finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
  }
})
