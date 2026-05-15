import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { todayDate } from '../utils/format.js'
import { safeWriteFileSync } from '../utils/fs.js'

export const BOUNTY_RAILS = ['arc-usdc', 'github-sponsors', 'manual'] as const
export type BountyRail = typeof BOUNTY_RAILS[number]

export const BOUNTY_STATUSES = ['open', 'claimed', 'ready', 'settled', 'cancelled'] as const
export type BountyStatus = typeof BOUNTY_STATUSES[number]

export interface BountySettlement {
  rail: BountyRail
  tx: string | null
  note: string | null
  settled: string
}

export interface BountyItem {
  id: string
  ref: string | null
  title: string
  amount: string
  currency: string
  rail: BountyRail
  status: BountyStatus
  creator: string | null
  claimant: string | null
  claimant_wallet: string | null
  claim_note: string | null
  pr: number | null
  settlement: BountySettlement | null
  created: string
  updated: string
}

interface BountiesFile {
  bounties: BountyItem[]
}

export class BountyStore {
  private yamlPath: string

  constructor(private baseDir: string) {
    this.yamlPath = join(baseDir, 'bounties.yaml')
  }

  list(): BountyItem[] {
    if (!existsSync(this.yamlPath)) return []
    const content = readFileSync(this.yamlPath, 'utf-8')
    const data = parse(content) as BountiesFile | null
    return data?.bounties ?? []
  }

  resolve(idOrRef: string): BountyItem | undefined {
    return this.list().find(b => b.id === idOrRef || b.ref === idOrRef)
  }

  add(input: {
    ref: string | null
    title: string
    amount: string
    currency: string
    rail: BountyRail
    creator: string | null
  }): BountyItem {
    const bounties = this.list()
    const today = todayDate()
    const item: BountyItem = {
      id: this.nextId(bounties),
      ref: input.ref,
      title: input.title,
      amount: input.amount,
      currency: input.currency,
      rail: input.rail,
      status: 'open',
      creator: input.creator,
      claimant: null,
      claimant_wallet: null,
      claim_note: null,
      pr: null,
      settlement: null,
      created: today,
      updated: today,
    }
    bounties.push(item)
    this.save(bounties)
    return item
  }

  claim(idOrRef: string, input: {
    claimant: string
    claimant_wallet?: string | null
    claim_note?: string | null
  }): BountyItem | undefined {
    return this.updateResolved(idOrRef, (bounty) => {
      if (bounty.status !== 'open' && bounty.status !== 'claimed') {
        throw new Error(`Cannot claim bounty with status "${bounty.status}".`)
      }
      bounty.status = 'claimed'
      bounty.claimant = input.claimant
      bounty.claimant_wallet = input.claimant_wallet ?? null
      bounty.claim_note = input.claim_note ?? null
    })
  }

  linkPr(idOrRef: string, pr: number): BountyItem | undefined {
    return this.updateResolved(idOrRef, (bounty) => {
      bounty.pr = pr
    })
  }

  markReady(idOrRef: string): BountyItem | undefined {
    return this.updateResolved(idOrRef, (bounty) => {
      if (bounty.status !== 'claimed' && bounty.status !== 'ready') {
        throw new Error(`Only claimed bounties can be marked ready. Current status: "${bounty.status}".`)
      }
      bounty.status = 'ready'
    })
  }

  settle(idOrRef: string, input: {
    rail: BountyRail
    tx?: string | null
    note?: string | null
  }): BountyItem | undefined {
    return this.updateResolved(idOrRef, (bounty) => {
      if (bounty.status !== 'ready' && bounty.status !== 'settled') {
        throw new Error(`Only ready bounties can be settled. Current status: "${bounty.status}".`)
      }
      bounty.status = 'settled'
      bounty.settlement = {
        rail: input.rail,
        tx: input.tx ?? null,
        note: input.note ?? null,
        settled: todayDate(),
      }
    })
  }

  private updateResolved(idOrRef: string, mutate: (bounty: BountyItem) => void): BountyItem | undefined {
    const bounties = this.list()
    const index = bounties.findIndex(b => b.id === idOrRef || b.ref === idOrRef)
    if (index < 0) return undefined
    const bounty = bounties[index]
    if (!bounty) return undefined
    mutate(bounty)
    bounty.updated = todayDate()
    this.save(bounties)
    return bounty
  }

  private nextId(bounties: BountyItem[]): string {
    let max = 0
    for (const bounty of bounties) {
      const match = /^bounty-(\d+)$/.exec(bounty.id)
      if (!match) continue
      max = Math.max(max, Number.parseInt(match[1]!, 10))
    }
    return `bounty-${max + 1}`
  }

  private save(bounties: BountyItem[]): void {
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    safeWriteFileSync(this.yamlPath, stringify({ bounties }))
  }
}
