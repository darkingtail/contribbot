import { describe, expect, it } from 'vitest'
import { inferMode, repoConfigSchema, RepoConfig } from './repo-config.js'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RepoConfigData } from './repo-config.js'
import { projectDirectory } from '../utils/repository-ref.js'

const github = (path: string) => ({ platform: 'github' as const, instance: 'https://github.com', path })
const base: RepoConfigData = {
  schema_version: 3,
  repository: github('darkingtail/contribbot'),
  lifecycle: { status: 'active' as const },
  parent: { status: 'unknown' },
  tracking: { status: 'pending' as const },
}

describe('inferMode', () => {
  it('returns "none" when parent is unknown and tracking is not configured', () => {
    expect(inferMode(base)).toBe('none')
    expect(inferMode({ ...base, tracking: { status: 'none' } })).toBe('none')
  })

  it('returns "fork" when a direct parent exists but tracking is not configured', () => {
    expect(inferMode({
      ...base,
      parent: { status: 'confirmed', repository: github('makeplane/plane'), relation_verified_at: '2026-09-29T00:00:00Z' },
    })).toBe('fork')
  })

  it('returns "fork+tracking" when both relationships exist', () => {
    expect(inferMode({
      ...base,
      parent: { status: 'confirmed', repository: github('antdv-next/antdv-next'), relation_verified_at: '2026-09-29T00:00:00Z' },
      tracking: { status: 'configured', sources: [github('ant-design/ant-design')] },
    })).toBe('fork+tracking')
  })

  it('returns "tracking" when tracking exists without a fork', () => {
    expect(inferMode({
      ...base,
      tracking: { status: 'configured', sources: [github('some/repo')] },
    })).toBe('tracking')
  })
})

describe('RepoConfig', () => {
  it('rejects a dangling project directory link when reading config', (context) => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-config-link-'))
    try {
      const link = join(dir, 'project-link')
      try {
        symlinkSync(join(dir, 'missing'), link, process.platform === 'win32' ? 'junction' : 'dir')
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
          context.skip()
          return
        }
        throw error
      }
      expect(() => new RepoConfig(join(link, 'project')).load()).toThrow(/symbolic link/i)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('refuses to create a config over orphan project data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-config-orphan-'))
    try {
      writeFileSync(join(dir, 'todos.yaml'), 'todos: []\n')
      expect(() => new RepoConfig(dir).save(base)).toThrow(/contains data without a valid config/i)
      expect(existsSync(join(dir, 'config.yaml'))).toBe(false)
      expect(existsSync(join(dir, '.config.lock'))).toBe(false)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('reads the current config only after acquiring the update lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-config-update-lock-'))
    try {
      new RepoConfig(dir).save(base)
      let readWithLock = false
      class LockObservingRepoConfig extends RepoConfig {
        override load() {
          readWithLock = existsSync(join(dir, '.config.lock'))
          return super.load()
        }
      }

      const config = new LockObservingRepoConfig(dir)
      config.update({ tracking: { status: 'none' } })

      expect(readWithLock).toBe(true)
      expect(config.load()?.tracking).toEqual({ status: 'none' })
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects an expected snapshot that became stale before the update', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-config-update-stale-'))
    try {
      const config = new RepoConfig(dir)
      config.save(base)
      const expected = config.load()!
      new RepoConfig(dir).update({ tracking: { status: 'none' } })

      expect(() => config.update({
        lifecycle: { status: 'archived', archived_at: '2026-09-30T00:00:00Z' },
      }, expected)).toThrow(/changed since it was read/i)
      expect(config.load()?.tracking).toEqual({ status: 'none' })
      expect(config.load()?.lifecycle).toEqual({ status: 'active' })
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('compares repository identities independently of object key order', () => {
    const reordered = {
      path: 'darkingtail/contribbot',
      instance: 'https://github.com',
      platform: 'github',
    }
    expect(() => repoConfigSchema.parse({
      ...base,
      parent: {
        status: 'confirmed',
        repository: reordered,
        relation_verified_at: '2026-09-29T00:00:00Z',
      },
    })).toThrow(/parent cannot equal repository/i)
    expect(() => repoConfigSchema.parse({
      ...base,
      tracking: { status: 'configured', sources: [reordered] },
    })).toThrow(/tracking source cannot equal repository/i)
  })

  it('rejects the old flat schema instead of converting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-config-v2-'))
    try {
      const path = join(dir, 'config.yaml')
      writeFileSync(path, 'role: read\norg: null\nfork: null\nupstream: null\n')
      expect(() => new RepoConfig(dir).load()).toThrow(/schema v3/i)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid lifecycle combinations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-config-v2-'))
    try {
      const path = join(dir, 'config.yaml')
      writeFileSync(path, 'schema_version: 3\nrepository:\n  platform: github\n  instance: https://github.com\n  path: darkingtail/contribbot\nlifecycle:\n  status: active\n  archived_at: "2026-09-24T00:00:00.000Z"\nparent:\n  status: unknown\ntracking:\n  status: pending\n')
      expect(() => new RepoConfig(dir).load()).toThrow(/archived_at/i)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ['invalid calendar day', 'lifecycle:\n  status: archived\n  archived_at: "2026-02-30T00:00:00Z"\n'],
    ['invalid timezone', 'lifecycle:\n  status: archived\n  archived_at: "2026-09-29T00:00:00+25:00"\n'],
  ])('rejects an %s', (_label, replacement) => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-config-v3-'))
    try {
      const path = join(dir, 'config.yaml')
      writeFileSync(path, `schema_version: 3
repository:
  platform: github
  instance: https://github.com
  path: darkingtail/contribbot
${replacement}parent:
  status: unknown
tracking:
  status: pending
`)
      expect(() => new RepoConfig(dir).load()).toThrow(/archived_at/i)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it.each([
    ['duplicate key', 'parent:\n  status: none\n  status: unknown\n'],
    ['merge key', 'parent:\n  <<: {status: unknown}\n'],
    ['custom tag', 'parent: !custom {status: unknown}\n'],
  ])('rejects YAML %s', (_label, replacement) => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-config-v3-'))
    try {
      writeFileSync(join(dir, 'config.yaml'), `schema_version: 3
repository:
  platform: github
  instance: https://github.com
  path: darkingtail/contribbot
lifecycle:
  status: active
${replacement}tracking:
  status: pending
`)
      expect(() => new RepoConfig(dir).load()).toThrow()
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('schema v3 confirmed state matrix', () => {
  const observedAt = '2026-09-29T00:00:00Z'
  const parent = github('team/upstream')
  const anotherInstance = {
    platform: 'gitlab' as const, instance: 'https://code.example.invalid/gitlab', path: parent.path,
  }
  const lifecycles: RepoConfigData['lifecycle'][] = [
    { status: 'active' },
    { status: 'archived', archived_at: observedAt },
  ]
  const parents: RepoConfigData['parent'][] = [
    { status: 'unknown' },
    { status: 'none', relation_verified_at: observedAt },
    { status: 'confirmed', repository: parent, relation_verified_at: observedAt },
  ]
  const trackings: RepoConfigData['tracking'][] = [
    { status: 'pending' },
    { status: 'none' },
    { status: 'configured', sources: [parent, anotherInstance] },
  ]
  const cases = lifecycles.flatMap(lifecycle => parents.flatMap(parentConfig =>
    trackings.map(tracking => ({
      name: `${lifecycle.status}/${parentConfig.status}/${tracking.status}`,
      config: { ...base, lifecycle, parent: parentConfig, tracking },
    })),
  ))

  it.each(cases)('round-trips $name without deriving one state from another', ({ config }) => {
    const root = mkdtempSync(join(tmpdir(), 'repo-config-matrix-'))
    try {
      const directory = projectDirectory(config.repository, root)
      const store = new RepoConfig(directory)
      store.save(config)
      const before = readFileSync(join(directory, 'config.yaml'), 'utf8')
      const loaded = store.load()
      expect(loaded).toEqual(config)
      expect(Object.keys(loaded!).sort()).toEqual([
        'lifecycle', 'parent', 'repository', 'schema_version', 'tracking',
      ])
      expect(readFileSync(join(directory, 'config.yaml'), 'utf8')).toBe(before)
      expect(existsSync(join(directory, '.config.lock'))).toBe(false)
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  })

  it.each([
    ['active lifecycle with null timestamp', { lifecycle: { status: 'active', archived_at: null } }],
    ['archived lifecycle without timestamp', { lifecycle: { status: 'archived' } }],
    ['unknown parent with a timestamp', { parent: { status: 'unknown', relation_verified_at: observedAt } }],
    ['unknown parent with null repository', { parent: { status: 'unknown', repository: null } }],
    ['none parent without timestamp', { parent: { status: 'none' } }],
    ['none parent with a repository', { parent: { status: 'none', repository: parent, relation_verified_at: observedAt } }],
    ['confirmed parent without repository', { parent: { status: 'confirmed', relation_verified_at: observedAt } }],
    ['confirmed parent without timestamp', { parent: { status: 'confirmed', repository: parent } }],
    ['pending tracking with empty sources', { tracking: { status: 'pending', sources: [] } }],
    ['none tracking with null sources', { tracking: { status: 'none', sources: null } }],
    ['configured tracking with empty sources', { tracking: { status: 'configured', sources: [] } }],
    ['duplicate full source identities', { tracking: { status: 'configured', sources: [parent, { ...parent }] } }],
    ['unrecognized top-level field', { role: 'admin' }],
    ['unrecognized nested lifecycle field', { lifecycle: { status: 'active', role: 'admin' } }],
  ])('rejects %s', (_name, fields) => {
    expect(() => repoConfigSchema.parse({ ...base, ...fields })).toThrow()
  })
})
