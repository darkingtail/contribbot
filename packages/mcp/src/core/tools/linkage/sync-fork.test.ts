import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getProjectDir } from '../../utils/config.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { syncFork } from './sync-fork.js'

describe('syncFork', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'sync-fork-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it.each([
    { platform: 'gitlab', instance: 'https://code.example.com/gitlab', path: 'owner/repo' },
    { platform: 'github', instance: 'https://github.example.com', path: 'owner/repo' },
  ] as const)('rejects unsupported $platform instance before checking parent or invoking gh', async (repository) => {
    await expect(syncFork(repository)).rejects.toThrow(/GitHub\.com repositories only; no remote changes/)
    expect(existsSync(getProjectDir(repository))).toBe(false)
  })

  it('requires an initialized GitHub.com project before checking parent or invoking gh', async () => {
    const repository = { platform: 'github', instance: 'https://github.com', path: 'owner/repo' } as const
    await expect(syncFork(repository)).rejects.toThrow(/not initialized.*project_init/i)
    expect(existsSync(getProjectDir(repository))).toBe(false)
  })

  it.each([
    { status: 'unknown', outcome: 'reject' },
    { status: 'none', outcome: 'no parent' },
  ] as const)('distinguishes parent.$status before any remote operation', async ({ status, outcome }) => {
    const repository = { platform: 'github', instance: 'https://github.com', path: 'owner/repo' } as const
    new RepoConfig(getProjectDir(repository)).save({
      schema_version: 3,
      repository,
      lifecycle: { status: 'active' },
      parent: status === 'unknown'
        ? { status: 'unknown' }
        : { status: 'none', relation_verified_at: '2026-09-30T00:00:00Z' },
      tracking: { status: 'pending' },
    })
    if (outcome === 'reject') {
      await expect(syncFork(repository)).rejects.toThrow(/parent.*unknown.*refresh/i)
    }
    else {
      await expect(syncFork(repository)).resolves.toMatch(/confirmed.*no parent/i)
    }
  })
})
