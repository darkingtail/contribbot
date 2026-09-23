import assert from 'node:assert/strict'
import test from 'node:test'
import { advisorEnvironment, nativeBindings, providerDisclosure, providerRequiredFlags } from '../dist/index.js'

const encode = events => events.map(event => JSON.stringify(event)).join('\n')

test('advisor environment excludes unrelated secrets, startup hooks and generic proxies', () => {
  const env = advisorEnvironment('claude', {
    PATH: 'system-bin', USERPROFILE: 'home', GITHUB_TOKEN: 'git-secret', AWS_SECRET_ACCESS_KEY: 'aws-secret',
    NODE_OPTIONS: '--require evil.js', HTTP_PROXY: 'secret-proxy', ANTHROPIC_API_KEY: 'authorized-auth',
  })
  assert.equal(env.PATH, 'system-bin')
  assert.equal(env.USERPROFILE, 'home')
  assert.equal(env.ANTHROPIC_API_KEY, 'authorized-auth')
  for (const key of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'HTTP_PROXY']) {
    assert.equal(env[key], undefined)
  }
})

test('native providers expose bounded read-only launch arguments', () => {
  const binding = { model: null }
  const claude = nativeBindings.claude.argv(binding)
  assert.equal(claude[claude.indexOf('--tools') + 1], '')
  assert.ok(claude.includes('--no-session-persistence'))
  assert.ok(providerRequiredFlags.claude.every(flag => claude.includes(flag)))
  assert.ok(providerRequiredFlags.codex.every(flag => nativeBindings.codex.argv(binding).includes(flag)))
  assert.deepEqual(nativeBindings.codex.argv(binding).slice(0, 3), ['-a', 'never', 'exec'])
  assert.equal(nativeBindings.codex.argv(binding)[nativeBindings.codex.argv(binding).indexOf('--sandbox') + 1], 'read-only')
  assert.ok(!nativeBindings.codex.argv(binding).includes('--dangerously-bypass-approvals-and-sandbox'))
})

test('native providers require their terminal protocol before returning advice', () => {
  assert.deepEqual(nativeBindings.claude.decode(encode([
    { type: 'system', subtype: 'init', tools: [] }, { type: 'result', is_error: false, result: 'Advice' },
  ]), 0), { outcome: 'returned', text: 'Advice', reason: null })
  assert.equal(nativeBindings.claude.decode(encode([
    { type: 'system', subtype: 'init', tools: ['Bash'] }, { type: 'result', result: 'not safe' },
  ]), 0).outcome, 'failed')
  const message = { type: 'item.completed', item: { type: 'agent_message', text: 'Advice' } }
  assert.equal(nativeBindings.codex.decode(encode([message]), 0).outcome, 'failed')
  assert.deepEqual(nativeBindings.codex.decode(encode([message, { type: 'turn.completed' }]), 0), {
    outcome: 'returned', text: 'Advice', reason: null,
  })
  assert.equal(nativeBindings.codex.decode(encode([message, { type: 'turn.failed' }]), 0).outcome, 'failed')
})

test('provider disclosure is descriptive and contains no credential values', () => {
  const disclosure = providerDisclosure('claude', 'a'.repeat(64), 'fixture', 'model-x')
  assert.match(disclosure, /executable SHA-256/)
  assert.match(disclosure, /model-x/)
  assert.doesNotMatch(disclosure, /API_KEY|TOKEN|SECRET/)
})
