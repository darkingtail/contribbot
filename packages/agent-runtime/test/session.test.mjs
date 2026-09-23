import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { executableDigest, prepareProviderRun, verifyProviderBinding } from '../dist/index.js'

test('native preparation owns scratch and respects the final dispatch callback', async () => {
  const binding = {
    runtime: 'claude', executable: process.execPath,
    executable_digest: await executableDigest(process.execPath), model: null,
  }
  await verifyProviderBinding(binding)
  await assert.rejects(verifyProviderBinding({ ...binding, executable_digest: 'a'.repeat(64) }), {
    message: 'Advisor executable changed after authorization. Obtain a new preview.',
  })
  const prepared = await prepareProviderRun(binding)
  try {
    assert.equal(prepared.status, 'ready')
    assert.equal(prepared.preparations.length, 1)
    assert.equal(prepared.preparations[0].capability, null)
    assert.equal(existsSync(prepared.preparations[0].directory), true)
    await assert.rejects(prepared.run('synthetic question', {
      dispatch: () => { throw new Error('revoked before process start') },
      shouldTerminate: () => false,
      onProcess: () => assert.fail('No process may start'),
    }), /revoked before process start/)
  }
  finally { for (const item of prepared.preparations) item.cleanup?.() }
  assert.equal(existsSync(prepared.preparations[0].directory), false)
})

test('failed capability probe returns bounded evidence and never offers a model run', async () => {
  const prepared = await prepareProviderRun({
    runtime: 'codex', executable: process.execPath,
    executable_digest: await executableDigest(process.execPath), model: null,
  })
  assert.equal(prepared.status, 'blocked')
  assert.equal(prepared.run, undefined)
  assert.equal(prepared.preparations.length, 1)
  const evidence = prepared.preparations[0]
  assert.equal(evidence.directory, null)
  assert.deepEqual(Object.keys(evidence.capability).sort(), ['digest', 'reason', 'verified'])
  assert.equal(evidence.capability.verified, false)
  assert.equal(prepared.reason, `Advisor unavailable: ${evidence.capability.reason} Probe digest: ${evidence.capability.digest}. No model call was made.`)
})
