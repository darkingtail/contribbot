import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BountyStore } from './bounty-store.js'

describe('BountyStore', () => {
  let dir: string
  let store: BountyStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bounty-test-'))
    store = new BountyStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty list when no file exists', () => {
    expect(store.list()).toEqual([])
  })

  it('adds a bounty and persists it to YAML', () => {
    const bounty = store.add({
      ref: '#123',
      title: 'Fix the issue',
      amount: '25',
      currency: 'USDC',
      rail: 'arc-usdc',
      creator: 'maintainer',
    })

    expect(bounty.id).toBe('bounty-1')
    expect(bounty.status).toBe('open')
    expect(bounty.claimant).toBeNull()
    expect(bounty.settlement).toBeNull()
    expect(store.list()).toHaveLength(1)
    expect(existsSync(join(dir, 'bounties.yaml'))).toBe(true)
    expect(readFileSync(join(dir, 'bounties.yaml'), 'utf-8')).toContain('id: bounty-1')
  })

  it('increments ids from existing bounties', () => {
    store.add({ ref: '#1', title: 'First', amount: '10', currency: 'USDC', rail: 'manual', creator: null })
    const second = store.add({ ref: '#2', title: 'Second', amount: '20', currency: 'USDC', rail: 'manual', creator: null })

    expect(second.id).toBe('bounty-2')
  })

  it('resolves by id or ref', () => {
    const bounty = store.add({ ref: '#123', title: 'Fix', amount: '25', currency: 'USDC', rail: 'manual', creator: null })

    expect(store.resolve('bounty-1')?.id).toBe(bounty.id)
    expect(store.resolve('#123')?.id).toBe(bounty.id)
  })

  it('claims an open bounty', () => {
    store.add({ ref: '#123', title: 'Fix', amount: '25', currency: 'USDC', rail: 'arc-usdc', creator: null })

    const claimed = store.claim('bounty-1', {
      claimant: 'contributor',
      claimant_wallet: '0xabc',
      claim_note: 'I will fix this',
    })

    expect(claimed?.status).toBe('claimed')
    expect(claimed?.claimant).toBe('contributor')
    expect(claimed?.claimant_wallet).toBe('0xabc')
    expect(claimed?.claim_note).toBe('I will fix this')
  })

  it('does not claim a settled bounty', () => {
    store.add({ ref: '#123', title: 'Fix', amount: '25', currency: 'USDC', rail: 'manual', creator: null })
    store.claim('bounty-1', { claimant: 'contributor' })
    store.markReady('bounty-1')
    store.settle('bounty-1', { rail: 'manual', note: 'Paid outside contribbot' })

    expect(() => store.claim('bounty-1', { claimant: 'another' })).toThrow('Cannot claim bounty with status "settled"')
  })

  it('links a PR and marks a claimed bounty ready', () => {
    store.add({ ref: '#123', title: 'Fix', amount: '25', currency: 'USDC', rail: 'manual', creator: null })
    store.claim('bounty-1', { claimant: 'contributor' })
    const linked = store.linkPr('bounty-1', 456)
    const ready = store.markReady('bounty-1')

    expect(linked?.pr).toBe(456)
    expect(ready?.status).toBe('ready')
  })

  it('does not mark an open bounty ready', () => {
    store.add({ ref: '#123', title: 'Fix', amount: '25', currency: 'USDC', rail: 'manual', creator: null })

    expect(() => store.markReady('bounty-1')).toThrow('Only claimed bounties can be marked ready')
  })

  it('settles a ready bounty', () => {
    store.add({ ref: '#123', title: 'Fix', amount: '25', currency: 'USDC', rail: 'arc-usdc', creator: null })
    store.claim('bounty-1', { claimant: 'contributor', claimant_wallet: '0xabc' })
    store.markReady('bounty-1')

    const settled = store.settle('bounty-1', {
      rail: 'arc-usdc',
      tx: '0xtx',
      note: 'Arc testnet transfer',
    })

    expect(settled?.status).toBe('settled')
    expect(settled?.settlement).toEqual({
      rail: 'arc-usdc',
      tx: '0xtx',
      note: 'Arc testnet transfer',
      settled: expect.any(String),
    })
  })
})
