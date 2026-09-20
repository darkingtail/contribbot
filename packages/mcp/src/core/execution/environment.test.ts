import { release } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Candidate } from './candidate.js'
import { checkCommandSchema } from './contracts.js'
import {
  assertDependencyInputs, captureRunnerEnvironment, checkEnvironmentSchema,
  observeDependencyInputs, verifyDependencyObservation,
} from './environment.js'

const candidate: Candidate = {
  version: 1, root: '/fixture', git_dir: '/fixture/.git', common_dir: '/fixture/.git',
  head: 'fixture-head', digest: 'a'.repeat(64),
  files: [
    { path: 'package.json', digest: 'b'.repeat(64), index_mode: '100644', index_oid: 'fixture-index', executable: false },
    { path: 'packages/app/package.json', digest: 'c'.repeat(64), index_mode: null, index_oid: null, executable: false },
    { path: 'deleted.lock', digest: null, index_mode: '100644', index_oid: 'fixture-index', executable: false },
  ],
}

describe('check environment observations', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('keeps old command JSON unchanged and does not add implicit dependency declarations', () => {
    const command = { executable: 'node', argv: ['check.cjs'], timeout_ms: 1000, max_output_bytes: 4096 }
    const parsed = checkCommandSchema.parse(command)
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(command))
    expect(observeDependencyInputs(parsed, candidate)).toEqual([])
  })

  it.each([['../outside'], ['/absolute'], ['C:/outside'], ['.'], ['package.json', 'package.json']]
    .map(dependency_inputs => ({ dependency_inputs })))(
    'rejects unsafe, directory-root or duplicate declarations $dependency_inputs', ({ dependency_inputs }) => {
      expect(() => checkCommandSchema.parse({
        executable: 'node', argv: [], timeout_ms: 1000, max_output_bytes: 4096, dependency_inputs,
      })).toThrow()
    },
  )

  it('selects only declared input hashes, including nested untracked files', () => {
    const command = { dependency_inputs: ['packages/app/package.json'] }
    const observations = observeDependencyInputs(command, candidate)
    expect(observations).toEqual([{ path: 'packages/app/package.json', digest: 'c'.repeat(64) }])
    expect(() => verifyDependencyObservation(command, candidate, observations)).not.toThrow()
  })

  it.each(['deleted.lock', 'ignored.lock'])('reports unavailable input %s without inventing a hash', (path) => {
    const command = { dependency_inputs: [path] }
    expect(observeDependencyInputs(command, candidate)).toEqual([{ path, digest: null }])
    expect(() => assertDependencyInputs(command, candidate)).toThrow(path)
  })

  it('rejects substituted input paths or hashes even if the receipt otherwise looks complete', () => {
    const command = { dependency_inputs: ['package.json'] }
    expect(() => verifyDependencyObservation(command, candidate, [{ path: 'package.json', digest: 'c'.repeat(64) }])).toThrow()
    expect(() => verifyDependencyObservation(command, candidate, [{ path: 'other.json', digest: 'b'.repeat(64) }])).toThrow()
    expect(() => verifyDependencyObservation(command, candidate, null)).toThrow()
    expect(() => verifyDependencyObservation(command, null, [])).toThrow()
    expect(() => verifyDependencyObservation(command, null, null)).not.toThrow()
  })

  it('captures only explicit runner properties and does not serialize the surrounding environment', () => {
    vi.stubEnv('CONTRIBBOT_PRIVATE_FIXTURE', 'not-for-a-receipt')
    const observed = captureRunnerEnvironment()
    expect(checkEnvironmentSchema.parse(observed)).toEqual({
      platform: process.platform, node: process.version, arch: process.arch, os_release: release(),
      runner_executable: process.execPath, dependency_inputs: { before: null, after: null },
    })
    expect(JSON.stringify(observed)).not.toContain('not-for-a-receipt')
    expect(() => checkEnvironmentSchema.parse({ ...observed, env: process.env })).toThrow()
  })
})
