import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BountyStore } from '../../storage/bounty-store.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { projectDirectory, type RepositoryRef } from '../../utils/repository-ref.js'
import {
  bountyClaim,
  bountyCreate,
  bountyDetail,
  bountyLinkPr,
  bountyList,
  bountyMarkReady,
  bountySettle,
} from './bounties.js'

const fixture = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async original => ({
  ...await original<typeof import('node:os')>(),
  homedir: () => fixture.home,
}))

const repository: RepositoryRef = {
  platform: 'github',
  instance: 'https://github.com',
  path: 'darkingtail/contribbot',
}

describe('bounty tools', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bounty-tools-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates and lists bounties', () => {
    const created = bountyCreate({
      ref: '#123',
      title: 'Fix issue',
      amount: '25',
      currency: 'USDC',
      rail: 'arc-usdc',
      creator: 'maintainer',
    }, repository, dir)

    expect(created).toContain('Created bounty **bounty-1**')
    const list = bountyList(repository, undefined, dir)
    expect(list).toContain('## Bounties — darkingtail/contribbot')
    expect(list).toContain('bounty-1')
    expect(list).toContain('arc-usdc')
  })

  it('shows bounty detail', () => {
    bountyCreate({ ref: '#123', title: 'Fix issue', amount: '25', currency: 'USDC', rail: 'manual' }, repository, dir)

    const detail = bountyDetail('bounty-1', repository, dir)

    expect(detail).toContain('## Bounty bounty-1')
    expect(detail).toContain('Fix issue')
    expect(detail).toContain('open')
  })

  it('claims a bounty', () => {
    bountyCreate({ ref: '#123', title: 'Fix issue', amount: '25', currency: 'USDC', rail: 'arc-usdc' }, repository, dir)

    const result = bountyClaim('bounty-1', {
      claimant: 'contributor',
      claimant_wallet: '0xabc',
      claim_note: 'I will handle the tests',
    }, repository, dir)

    expect(result).toContain('Claimed bounty **bounty-1**')
    expect(result).toContain('0xabc')
    expect(new BountyStore(dir).resolve('bounty-1')?.status).toBe('claimed')
  })

  it('links a PR and marks ready', () => {
    bountyCreate({ ref: '#123', title: 'Fix issue', amount: '25', currency: 'USDC', rail: 'manual' }, repository, dir)
    bountyClaim('bounty-1', { claimant: 'contributor' }, repository, dir)

    expect(bountyLinkPr('bounty-1', 456, repository, dir)).toContain('Linked bounty **bounty-1** to PR [#456]')
    expect(bountyMarkReady('bounty-1', repository, dir)).toContain('marked ready for settlement')
    expect(new BountyStore(dir).resolve('bounty-1')?.status).toBe('ready')
  })

  it('settles an Arc USDC bounty with an instruction', () => {
    bountyCreate({ ref: '#123', title: 'Fix issue', amount: '25', currency: 'USDC', rail: 'arc-usdc' }, repository, dir)
    bountyClaim('bounty-1', { claimant: 'contributor', claimant_wallet: '0xabc' }, repository, dir)
    bountyMarkReady('bounty-1', repository, dir)

    const result = bountySettle('bounty-1', {
      rail: 'arc-usdc',
      tx: '0xtx',
      note: 'Arc testnet transfer',
    }, repository, dir)

    expect(result).toContain('Settled bounty **bounty-1**')
    expect(result).toContain('Arc USDC settlement')
    expect(result).toContain('0xtx')
    expect(new BountyStore(dir).resolve('bounty-1')?.status).toBe('settled')
  })

  it('returns a useful message for missing bounties', () => {
    expect(() => bountyDetail('missing', repository, dir)).toThrow('Bounty not found')
  })
})

describe('bounty v3 project boundary', () => {
  const input = { title: 'Fix issue', amount: '25', rail: 'manual' as const }

  beforeEach(() => {
    fixture.home = mkdtempSync(join(tmpdir(), 'bounty-project-'))
  })

  afterEach(() => {
    rmSync(fixture.home, { recursive: true, force: true })
  })

  it('does not initialize a project by creating a bounty', async () => {
    await expect(bountyCreate(input, repository)).rejects.toThrow(/not initialized/i)
    expect(existsSync(projectDirectory(repository))).toBe(false)
  })

  it('does not read orphaned bounties without a v3 config', async () => {
    const directory = projectDirectory(repository)
    new BountyStore(directory).add({ ...input, ref: null, currency: 'USDC', creator: null })

    await expect(bountyList(repository)).rejects.toThrow(/not initialized/i)
    await expect(bountyDetail('bounty-1', repository)).rejects.toThrow(/not initialized/i)
  })

  it('rejects a config for a different repository in the same directory', async () => {
    const other = { ...repository, path: 'darkingtail/other' }
    const otherDirectory = projectDirectory(other)
    new RepoConfig(otherDirectory).save({
      schema_version: 3, repository: other, lifecycle: { status: 'active' },
      parent: { status: 'unknown' }, tracking: { status: 'pending' },
    })
    const directory = projectDirectory(repository)
    mkdirSync(directory, { recursive: true })
    copyFileSync(join(otherDirectory, 'config.yaml'), join(directory, 'config.yaml'))

    await expect(bountyList(repository)).rejects.toThrow(/identity does not match/i)
    await expect(bountyCreate(input, repository)).rejects.toThrow(/identity does not match/i)
    expect(existsSync(join(directory, 'bounties.yaml'))).toBe(false)
  })

  it('creates and reads bounties in an initialized project', async () => {
    const directory = projectDirectory(repository)
    new RepoConfig(directory).save({
      schema_version: 3, repository, lifecycle: { status: 'active' },
      parent: { status: 'unknown' }, tracking: { status: 'pending' },
    })

    expect(await bountyCreate(input, repository)).toContain('Created bounty **bounty-1**')
    expect(await bountyList(repository)).toContain('bounty-1')
    expect(new BountyStore(directory).resolve('bounty-1')?.title).toBe(input.title)
  })
})
