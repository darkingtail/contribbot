import { BOUNTY_RAILS, BOUNTY_STATUSES, BountyStore } from '../../storage/bounty-store.js'
import type { BountyItem, BountyRail, BountyStatus } from '../../storage/bounty-store.js'
import { getContribDir } from '../../utils/config.js'
import { markdownTable } from '../../utils/format.js'
import { resolveRepo } from '../../utils/resolve-repo.js'

export interface BountyCreateInput {
  ref?: string | null
  title: string
  amount: string
  currency?: string
  rail: BountyRail
  creator?: string | null
}

export interface BountyClaimInput {
  claimant: string
  claimant_wallet?: string | null
  claim_note?: string | null
}

export interface BountySettleInput {
  rail: BountyRail
  tx?: string | null
  note?: string | null
}

function assertRail(rail: string): asserts rail is BountyRail {
  if (!BOUNTY_RAILS.includes(rail as BountyRail)) {
    throw new Error(`Invalid bounty rail "${rail}". Expected one of: ${BOUNTY_RAILS.join(', ')}`)
  }
}

function assertStatus(status: string): asserts status is BountyStatus {
  if (!BOUNTY_STATUSES.includes(status as BountyStatus)) {
    throw new Error(`Invalid bounty status "${status}". Expected one of: ${BOUNTY_STATUSES.join(', ')}`)
  }
}

function repoParts(repo: string): { owner: string, name: string } {
  const [owner, name] = repo.split('/')
  if (!owner || !name || repo.split('/').length !== 2) {
    throw new Error('repo is required. Pass owner/name.')
  }
  return { owner, name }
}

async function getStore(repo: string, baseDir?: string): Promise<{ owner: string, name: string, store: BountyStore }> {
  if (baseDir) {
    const { owner, name } = repoParts(repo)
    return { owner, name, store: new BountyStore(baseDir) }
  }
  const { owner, name } = await resolveRepo(repo)
  return { owner, name, store: new BountyStore(getContribDir(owner, name)) }
}

function getStoreSync(repo: string, baseDir: string): { owner: string, name: string, store: BountyStore } {
  const { owner, name } = repoParts(repo)
  return { owner, name, store: new BountyStore(baseDir) }
}

function refLink(ref: string | null, owner: string, name: string): string {
  if (!ref) return '-'
  if (ref.startsWith('#')) {
    return `[${ref}](https://github.com/${owner}/${name}/issues/${ref.slice(1)})`
  }
  return ref
}

function prLink(pr: number | null, owner: string, name: string): string {
  if (!pr) return '-'
  return `[#${pr}](https://github.com/${owner}/${name}/pull/${pr})`
}

function requireBounty(store: BountyStore, idOrRef: string): BountyItem {
  const bounty = store.resolve(idOrRef)
  if (!bounty) throw new Error(`Bounty not found: "${idOrRef}". Use bounty_list to see available bounties.`)
  return bounty
}

function settlementInstruction(bounty: BountyItem, input: BountySettleInput): string {
  if (input.rail === 'arc-usdc') {
    const wallet = bounty.claimant_wallet ?? '<claimant-wallet>'
    return [
      '### Arc USDC settlement',
      '',
      `Send **${bounty.amount} ${bounty.currency}** to \`${wallet}\` on Arc.`,
      input.tx ? `Transaction: \`${input.tx}\`` : 'Transaction: not recorded yet',
    ].join('\n')
  }
  if (input.rail === 'github-sponsors') {
    return [
      '### GitHub Sponsors settlement',
      '',
      `Pay **${bounty.amount} ${bounty.currency}** through GitHub Sponsors or record the sponsor payment confirmation.`,
    ].join('\n')
  }
  return [
    '### Manual settlement',
    '',
    `Record external payment confirmation for **${bounty.amount} ${bounty.currency}**.`,
  ].join('\n')
}

export function bountyCreate(input: BountyCreateInput, repo: string, baseDir: string): string
export async function bountyCreate(input: BountyCreateInput, repo: string, baseDir?: undefined): Promise<string>
export function bountyCreate(input: BountyCreateInput, repo: string, baseDir?: string): string | Promise<string> {
  assertRail(input.rail)
  const run = ({ owner, name, store }: { owner: string, name: string, store: BountyStore }) => {
    const bounty = store.add({
      ref: input.ref ?? null,
      title: input.title,
      amount: input.amount,
      currency: input.currency ?? 'USDC',
      rail: input.rail,
      creator: input.creator ?? null,
    })
    return [
      `Created bounty **${bounty.id}** for ${owner}/${name}.`,
      '',
      `- Ref: ${refLink(bounty.ref, owner, name)}`,
      `- Title: ${bounty.title}`,
      `- Amount: ${bounty.amount} ${bounty.currency}`,
      `- Rail: ${bounty.rail}`,
      `- Status: ${bounty.status}`,
    ].join('\n')
  }
  if (baseDir) return run(getStoreSync(repo, baseDir))
  return getStore(repo).then(run)
}

export function bountyList(repo: string, status: string | undefined, baseDir: string): string
export async function bountyList(repo: string, status?: string, baseDir?: undefined): Promise<string>
export function bountyList(repo: string, status?: string, baseDir?: string): string | Promise<string> {
  if (status) assertStatus(status)
  const run = ({ owner, name, store }: { owner: string, name: string, store: BountyStore }) => {
    const all = store.list()
    const bounties = status ? all.filter(b => b.status === status) : all
    if (bounties.length === 0) {
      return `## Bounties — ${owner}/${name}\n\n_No bounties found._`
    }
    const rows = bounties.map(b => [
      b.id,
      refLink(b.ref, owner, name),
      b.title,
      `${b.amount} ${b.currency}`,
      b.rail,
      b.status,
      b.claimant ?? '-',
      prLink(b.pr, owner, name),
    ])
    return [
      `## Bounties — ${owner}/${name}`,
      '',
      `> ${bounties.length} shown · ${all.length} total`,
      '',
      markdownTable(['ID', 'Ref', 'Title', 'Amount', 'Rail', 'Status', 'Claimant', 'PR'], rows),
    ].join('\n')
  }
  if (baseDir) return run(getStoreSync(repo, baseDir))
  return getStore(repo).then(run)
}

export function bountyDetail(idOrRef: string, repo: string, baseDir: string): string
export async function bountyDetail(idOrRef: string, repo: string, baseDir?: undefined): Promise<string>
export function bountyDetail(idOrRef: string, repo: string, baseDir?: string): string | Promise<string> {
  const run = ({ owner, name, store }: { owner: string, name: string, store: BountyStore }) => {
    const bounty = requireBounty(store, idOrRef)
    return [
      `## Bounty ${bounty.id}`,
      '',
      `| Field | Value |`,
      `| --- | --- |`,
      `| Ref | ${refLink(bounty.ref, owner, name)} |`,
      `| Title | ${bounty.title} |`,
      `| Amount | ${bounty.amount} ${bounty.currency} |`,
      `| Rail | ${bounty.rail} |`,
      `| Status | ${bounty.status} |`,
      `| Creator | ${bounty.creator ?? '-'} |`,
      `| Claimant | ${bounty.claimant ?? '-'} |`,
      `| Claimant wallet | ${bounty.claimant_wallet ? `\`${bounty.claimant_wallet}\`` : '-'} |`,
      `| Claim note | ${bounty.claim_note ?? '-'} |`,
      `| PR | ${prLink(bounty.pr, owner, name)} |`,
      `| Settlement | ${bounty.settlement ? `${bounty.settlement.rail} · ${bounty.settlement.tx ?? 'no tx'} · ${bounty.settlement.note ?? 'no note'}` : '-'} |`,
    ].join('\n')
  }
  if (baseDir) return run(getStoreSync(repo, baseDir))
  return getStore(repo).then(run)
}

export function bountyClaim(idOrRef: string, input: BountyClaimInput, repo: string, baseDir: string): string
export async function bountyClaim(idOrRef: string, input: BountyClaimInput, repo: string, baseDir?: undefined): Promise<string>
export function bountyClaim(idOrRef: string, input: BountyClaimInput, repo: string, baseDir?: string): string | Promise<string> {
  const run = ({ owner, name, store }: { owner: string, name: string, store: BountyStore }) => {
    const bounty = store.claim(idOrRef, input)
    if (!bounty) throw new Error(`Bounty not found: "${idOrRef}". Use bounty_list to see available bounties.`)
    return [
      `Claimed bounty **${bounty.id}** on ${owner}/${name}.`,
      '',
      `- Claimant: ${bounty.claimant}`,
      `- Wallet: ${bounty.claimant_wallet ? `\`${bounty.claimant_wallet}\`` : '-'}`,
      `- Note: ${bounty.claim_note ?? '-'}`,
      '',
      '<!-- contribbot:bounty-claim -->',
    ].join('\n')
  }
  if (baseDir) return run(getStoreSync(repo, baseDir))
  return getStore(repo).then(run)
}

export function bountyLinkPr(idOrRef: string, pr: number, repo: string, baseDir: string): string
export async function bountyLinkPr(idOrRef: string, pr: number, repo: string, baseDir?: undefined): Promise<string>
export function bountyLinkPr(idOrRef: string, pr: number, repo: string, baseDir?: string): string | Promise<string> {
  const run = ({ owner, name, store }: { owner: string, name: string, store: BountyStore }) => {
    const bounty = store.linkPr(idOrRef, pr)
    if (!bounty) throw new Error(`Bounty not found: "${idOrRef}". Use bounty_list to see available bounties.`)
    return `Linked bounty **${bounty.id}** to PR ${prLink(pr, owner, name)}.`
  }
  if (baseDir) return run(getStoreSync(repo, baseDir))
  return getStore(repo).then(run)
}

export function bountyMarkReady(idOrRef: string, repo: string, baseDir: string): string
export async function bountyMarkReady(idOrRef: string, repo: string, baseDir?: undefined): Promise<string>
export function bountyMarkReady(idOrRef: string, repo: string, baseDir?: string): string | Promise<string> {
  const run = ({ store }: { owner: string, name: string, store: BountyStore }) => {
    const bounty = store.markReady(idOrRef)
    if (!bounty) throw new Error(`Bounty not found: "${idOrRef}". Use bounty_list to see available bounties.`)
    return `Bounty **${bounty.id}** marked ready for settlement.`
  }
  if (baseDir) return run(getStoreSync(repo, baseDir))
  return getStore(repo).then(run)
}

export function bountySettle(idOrRef: string, input: BountySettleInput, repo: string, baseDir: string): string
export async function bountySettle(idOrRef: string, input: BountySettleInput, repo: string, baseDir?: undefined): Promise<string>
export function bountySettle(idOrRef: string, input: BountySettleInput, repo: string, baseDir?: string): string | Promise<string> {
  assertRail(input.rail)
  const run = ({ store }: { owner: string, name: string, store: BountyStore }) => {
    const bountyBefore = requireBounty(store, idOrRef)
    const bounty = store.settle(idOrRef, input)
    if (!bounty) throw new Error(`Bounty not found: "${idOrRef}". Use bounty_list to see available bounties.`)
    return [
      `Settled bounty **${bounty.id}**.`,
      '',
      settlementInstruction(bountyBefore, input),
      '',
      `Status: ${bounty.status}`,
    ].join('\n')
  }
  if (baseDir) return run(getStoreSync(repo, baseDir))
  return getStore(repo).then(run)
}
