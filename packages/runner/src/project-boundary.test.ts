import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { projectDirectory } from 'contribbot-core/repository/ref'
import { createConsultStore } from './composition.js'

let root: string
const repository = { platform: 'gitlab' as const, instance: 'https://private.example.invalid/gitlab', path: 'team/ui' }
const config = {
  schema_version: 3, repository, lifecycle: { status: 'active' },
  parent: { status: 'unknown' }, tracking: { status: 'pending' },
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'runner-project-boundary-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

it('rejects an uninitialized project without creating Consult files', () => {
  expect(() => createConsultStore(root)).toThrow(/not initialized/)
  expect(readdirSync(root)).toEqual([])
})

it.each([
  ['old schema', { repository: 'owner/repo' }],
  ['unknown config field', { ...config, unexpected: true }],
  ['wrong directory identity', { ...config, repository: { ...repository, path: 'team/other' } }],
])('rejects %s before creating a store and preserves existing bytes', (_label, value) => {
  const directory = projectDirectory(repository, root)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'config.yaml')
  const before = JSON.stringify(value)
  writeFileSync(file, before)
  expect(() => createConsultStore(directory)).toThrow(/schema v3|identity does not match/)
  expect(readdirSync(directory)).toEqual(['config.yaml'])
  expect(readFileSync(file, 'utf8')).toBe(before)
})

it('allows an initialized private project with no Todo and does not connect remotely', () => {
  const directory = projectDirectory(repository, root)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'config.yaml'), JSON.stringify(config))
  expect(createConsultStore(directory).directory).toBe(directory)
  expect(readdirSync(directory)).toEqual(['config.yaml'])
})
