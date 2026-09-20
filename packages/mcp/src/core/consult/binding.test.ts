import { expect, it } from 'vitest'
import { advisorEnvironment, nativeBindings } from './binding.js'
import type { Binding } from './contracts.js'

it('does not pass unrelated secrets, shell startup hooks or generic proxy settings to an advisor', () => {
  const env = advisorEnvironment('claude', {
    PATH: 'system-bin', USERPROFILE: 'home', GITHUB_TOKEN: 'git-secret', AWS_SECRET_ACCESS_KEY: 'aws-secret',
    NODE_OPTIONS: '--require evil.js', HTTP_PROXY: 'secret-proxy', ANTHROPIC_API_KEY: 'authorized-auth',
  })
  expect(env).toMatchObject({ PATH: 'system-bin', USERPROFILE: 'home', ANTHROPIC_API_KEY: 'authorized-auth' })
  for (const key of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'HTTP_PROXY']) expect(env[key]).toBeUndefined()
})

it('builds argument arrays with tool-free Claude and non-escalating read-only Codex', () => {
  const binding = { model: null } as Binding
  const claude = nativeBindings.claude.argv(binding)
  expect(claude[claude.indexOf('--tools') + 1]).toBe('')
  expect(claude).toContain('--no-session-persistence')
  const codex = nativeBindings.codex.argv(binding)
  expect(codex.slice(0, 3)).toEqual(['-a', 'never', 'exec'])
  expect(codex[codex.indexOf('--sandbox') + 1]).toBe('read-only')
  expect(codex).not.toContain('--dangerously-bypass-approvals-and-sandbox')
})

it('requires successful protocol terminal messages and verifies Claude exposes no tools', () => {
  const encode = (events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n')
  expect(nativeBindings.claude.decode(encode([
    { type: 'system', subtype: 'init', tools: [] }, { type: 'result', is_error: false, result: 'Advice' },
  ]), 0)).toMatchObject({ outcome: 'returned', text: 'Advice' })
  expect(nativeBindings.claude.decode(encode([
    { type: 'system', subtype: 'init', tools: ['Bash'] }, { type: 'result', result: 'not safe' },
  ]), 0).outcome).toBe('failed')
  const message = { type: 'item.completed', item: { type: 'agent_message', text: 'Advice' } }
  expect(nativeBindings.codex.decode(encode([message]), 0).outcome).toBe('failed')
  expect(nativeBindings.codex.decode(encode([message, { type: 'turn.completed' }]), 0).outcome).toBe('returned')
  expect(nativeBindings.codex.decode(encode([message, { type: 'turn.failed' }]), 0).outcome).toBe('failed')
})
