import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BountyStore } from '../../storage/bounty-store.js'
import {
  bountyClaim,
  bountyCreate,
  bountyDetail,
  bountyLinkPr,
  bountyList,
  bountyMarkReady,
  bountySettle,
} from './bounties.js'

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
    }, 'darkingtail/contribbot', dir)

    expect(created).toContain('Created bounty **bounty-1**')
    const list = bountyList('darkingtail/contribbot', undefined, dir)
    expect(list).toContain('## Bounties — darkingtail/contribbot')
    expect(list).toContain('bounty-1')
    expect(list).toContain('arc-usdc')
  })

  it('shows bounty detail', () => {
    bountyCreate({ ref: '#123', title: 'Fix issue', amount: '25', currency: 'USDC', rail: 'manual' }, 'darkingtail/contribbot', dir)

    const detail = bountyDetail('bounty-1', 'darkingtail/contribbot', dir)

    expect(detail).toContain('## Bounty bounty-1')
    expect(detail).toContain('Fix issue')
    expect(detail).toContain('open')
  })

  it('claims a bounty', () => {
    bountyCreate({ ref: '#123', title: 'Fix issue', amount: '25', currency: 'USDC', rail: 'arc-usdc' }, 'darkingtail/contribbot', dir)

    const result = bountyClaim('bounty-1', {
      claimant: 'contributor',
      claimant_wallet: '0xabc',
      claim_note: 'I will handle the tests',
    }, 'darkingtail/contribbot', dir)

    expect(result).toContain('Claimed bounty **bounty-1**')
    expect(result).toContain('0xabc')
    expect(new BountyStore(dir).resolve('bounty-1')?.status).toBe('claimed')
  })

  it('links a PR and marks ready', () => {
    bountyCreate({ ref: '#123', title: 'Fix issue', amount: '25', currency: 'USDC', rail: 'manual' }, 'darkingtail/contribbot', dir)
    bountyClaim('bounty-1', { claimant: 'contributor' }, 'darkingtail/contribbot', dir)

    expect(bountyLinkPr('bounty-1', 456, 'darkingtail/contribbot', dir)).toContain('Linked bounty **bounty-1** to PR [#456]')
    expect(bountyMarkReady('bounty-1', 'darkingtail/contribbot', dir)).toContain('marked ready for settlement')
    expect(new BountyStore(dir).resolve('bounty-1')?.status).toBe('ready')
  })

  it('settles an Arc USDC bounty with an instruction', () => {
    bountyCreate({ ref: '#123', title: 'Fix issue', amount: '25', currency: 'USDC', rail: 'arc-usdc' }, 'darkingtail/contribbot', dir)
    bountyClaim('bounty-1', { claimant: 'contributor', claimant_wallet: '0xabc' }, 'darkingtail/contribbot', dir)
    bountyMarkReady('bounty-1', 'darkingtail/contribbot', dir)

    const result = bountySettle('bounty-1', {
      rail: 'arc-usdc',
      tx: '0xtx',
      note: 'Arc testnet transfer',
    }, 'darkingtail/contribbot', dir)

    expect(result).toContain('Settled bounty **bounty-1**')
    expect(result).toContain('Arc USDC settlement')
    expect(result).toContain('0xtx')
    expect(new BountyStore(dir).resolve('bounty-1')?.status).toBe('settled')
  })

  it('returns a useful message for missing bounties', () => {
    expect(() => bountyDetail('missing', 'darkingtail/contribbot', dir)).toThrow('Bounty not found')
  })
})
