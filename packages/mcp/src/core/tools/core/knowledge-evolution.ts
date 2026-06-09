import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getContribDir, validatePathSegment } from '../../utils/config.js'
import { safeWriteFileSync } from '../../utils/fs.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { markdownTable, todayDate, truncate } from '../../utils/format.js'
import {
  KNOWLEDGE_PROPOSAL_ACTIONS,
  KNOWLEDGE_PROPOSAL_STATUSES,
  KNOWLEDGE_SOURCE_TYPES,
  validateEnum,
  type KnowledgeProposalAction,
  type KnowledgeProposalStatus,
  type KnowledgeSourceType,
} from '../../enums.js'
import { KnowledgeProposalStore, type KnowledgeProposal } from '../../storage/knowledge-proposal-store.js'
import { getKnowledgePath, knowledgeExists } from './knowledge.js'

const PROVENANCE_MARKER = '<!-- contribbot:provenance -->'

function storeFor(owner: string, name: string): KnowledgeProposalStore {
  return new KnowledgeProposalStore(getContribDir(owner, name))
}

function sourceLabel(p: KnowledgeProposal): string {
  if (!p.source_ref) return p.source_type
  return `${p.source_type}#${p.source_ref.replace(/^#/, '')}`
}

/**
 * Append (or refresh) the provenance footer on canonical knowledge content.
 * Any existing footer (from a prior apply) is stripped first so repeated
 * revises don't stack footers.
 */
function applyProvenanceFooter(content: string, proposal: KnowledgeProposal, appliedAt: string): string {
  const markerIdx = content.indexOf(PROVENANCE_MARKER)
  const body = (markerIdx >= 0 ? content.slice(0, markerIdx) : content).replace(/\s+$/, '')
  const footer = `${PROVENANCE_MARKER}\n---\n_via ${proposal.id} · ${sourceLabel(proposal)} · ${appliedAt}_\n`
  return `${body}\n\n${footer}`
}

function writeKnowledge(path: string, content: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  safeWriteFileSync(path, content)
}

export async function knowledgeProposeUpdate(args: {
  repo?: string
  target: string
  action: string
  source_type: string
  source_ref?: string
  title: string
  rationale: string
  proposed_content: string
}): Promise<string> {
  const { owner, name } = await resolveRepo(args.repo)
  const target = validatePathSegment(args.target)
  const action = validateEnum<KnowledgeProposalAction>(KNOWLEDGE_PROPOSAL_ACTIONS, args.action, 'action')
  const sourceType = validateEnum<KnowledgeSourceType>(KNOWLEDGE_SOURCE_TYPES, args.source_type, 'source_type')

  if (!args.title?.trim()) throw new Error('title is required.')
  if (!args.proposed_content?.trim()) throw new Error('proposed_content is required.')

  const store = storeFor(owner, name)
  const proposal = store.add({
    repo: `${owner}/${name}`,
    target,
    action,
    source_type: sourceType,
    source_ref: args.source_ref ?? null,
    title: args.title.trim(),
    rationale: args.rationale?.trim() ?? '',
    proposed_content: args.proposed_content,
  })

  return [
    `## Knowledge proposal created — \`${proposal.id}\``,
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| Repo | ${proposal.repo} |`,
    `| Target | \`${proposal.target}\` |`,
    `| Action | ${proposal.action} |`,
    `| Source | ${sourceLabel(proposal)} |`,
    `| Title | ${proposal.title} |`,
    `| Status | pending |`,
    '',
    proposal.rationale ? `**Rationale**: ${proposal.rationale}` : '_No rationale provided._',
    '',
    `> This is a **proposal**, not knowledge yet. Review with \`knowledge_proposals\`, then`,
    `> \`knowledge_apply_update\` (apply \`${proposal.id}\`) or \`knowledge_reject_update\` to discard.`,
  ].join('\n')
}

export async function knowledgeProposals(repo?: string, status?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const statusFilter = status
    ? validateEnum<KnowledgeProposalStatus>(KNOWLEDGE_PROPOSAL_STATUSES, status, 'status')
    : undefined

  const store = storeFor(owner, name)
  const proposals = store.listByStatus(statusFilter)

  const heading = `## Knowledge proposals — ${owner}/${name}${statusFilter ? ` (${statusFilter})` : ''}`
  if (proposals.length === 0) {
    return `${heading}\n\n_No proposals${statusFilter ? ` with status ${statusFilter}` : ''}. Use \`knowledge_propose_update\` to create one._`
  }

  const statusEmoji = (s: KnowledgeProposalStatus) =>
    s === 'pending' ? '🟡 pending' : s === 'applied' ? '🟢 applied' : '🔴 rejected'

  const note = (p: KnowledgeProposal): string => {
    if (p.status === 'applied') return `applied ${p.applied_at}`
    if (p.status === 'rejected') return p.rejected_reason ? `rejected: ${truncate(p.rejected_reason, 40)}` : `rejected ${p.rejected_at}`
    return `created ${p.created_at}`
  }

  const rows = proposals.map(p => [
    p.id,
    statusEmoji(p.status),
    p.action,
    `\`${p.target}\``,
    sourceLabel(p),
    truncate(p.title, 50),
    note(p),
  ])

  return [
    `${heading} (${proposals.length})`,
    '',
    markdownTable(['ID', 'Status', 'Action', 'Target', 'Source', 'Title', 'Note'], rows),
    '',
    `> Apply a pending proposal: \`knowledge_apply_update\` with its ID. Discard: \`knowledge_reject_update\`.`,
  ].join('\n')
}

export async function knowledgeApplyUpdate(repo: string | undefined, proposalId: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const store = storeFor(owner, name)
  const proposal = store.get(proposalId)
  if (!proposal) throw new Error(`Proposal "${proposalId}" not found. Use \`knowledge_proposals\` to list them.`)
  if (proposal.status !== 'pending') {
    throw new Error(`Proposal "${proposalId}" is already ${proposal.status}, cannot apply.`)
  }

  const path = getKnowledgePath(owner, name, proposal.target)
  const exists = knowledgeExists(owner, name, proposal.target)
  const appliedAt = todayDate()

  let finalContent: string
  switch (proposal.action) {
    case 'create':
      if (exists) {
        throw new Error(`Knowledge "${proposal.target}" already exists. Use action "revise" or "append" instead of "create".`)
      }
      finalContent = applyProvenanceFooter(proposal.proposed_content, proposal, appliedAt)
      break
    case 'append': {
      if (!exists) {
        throw new Error(`Knowledge "${proposal.target}" does not exist. Use action "create" first.`)
      }
      const existing = readFileSync(path, 'utf-8')
      const markerIdx = existing.indexOf(PROVENANCE_MARKER)
      const base = (markerIdx >= 0 ? existing.slice(0, markerIdx) : existing).replace(/\s+$/, '')
      finalContent = applyProvenanceFooter(`${base}\n\n${proposal.proposed_content}`, proposal, appliedAt)
      break
    }
    case 'revise':
      if (!exists) {
        throw new Error(`Knowledge "${proposal.target}" does not exist. Use action "create" first.`)
      }
      finalContent = applyProvenanceFooter(proposal.proposed_content, proposal, appliedAt)
      break
    default:
      throw new Error(`Unknown action: ${proposal.action}`)
  }

  writeKnowledge(path, finalContent)
  store.markApplied(proposalId)

  return [
    `## Knowledge proposal applied — \`${proposal.id}\``,
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| Action | ${proposal.action} |`,
    `| Target | \`${proposal.target}\` |`,
    `| Path | \`~/.contribbot/${owner}/${name}/knowledge/${proposal.target}/README.md\` |`,
    `| Resource | \`knowledge://${owner}/${name}/${proposal.target}\` |`,
    `| Applied | ${appliedAt} |`,
    '',
    `Provenance footer recorded in the knowledge entry.`,
  ].join('\n')
}

export async function knowledgeRejectUpdate(repo: string | undefined, proposalId: string, reason?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const store = storeFor(owner, name)
  const proposal = store.get(proposalId)
  if (!proposal) throw new Error(`Proposal "${proposalId}" not found. Use \`knowledge_proposals\` to list them.`)
  if (proposal.status !== 'pending') {
    throw new Error(`Proposal "${proposalId}" is already ${proposal.status}, cannot reject.`)
  }

  store.markRejected(proposalId, reason)

  return [
    `## Knowledge proposal rejected — \`${proposal.id}\``,
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| Target | \`${proposal.target}\` |`,
    `| Title | ${proposal.title} |`,
    reason ? `| Reason | ${reason} |` : `| Reason | _none_ |`,
    '',
    `Canonical knowledge was **not** modified.`,
  ].join('\n')
}

/**
 * Count pending knowledge proposals for a repo. Used by project_dashboard.
 */
export function countPendingProposals(owner: string, name: string): number {
  try {
    return storeFor(owner, name).countPending()
  } catch {
    return 0
  }
}
