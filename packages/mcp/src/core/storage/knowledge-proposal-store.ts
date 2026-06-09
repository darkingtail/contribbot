import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { todayDate } from '../utils/format.js'
import { safeWriteFileSync } from '../utils/fs.js'

export type { KnowledgeProposalStatus, KnowledgeProposalAction, KnowledgeSourceType } from '../enums.js'
import type { KnowledgeProposalStatus, KnowledgeProposalAction, KnowledgeSourceType } from '../enums.js'

export interface KnowledgeProposal {
  id: string
  repo: string
  target: string
  action: KnowledgeProposalAction
  status: KnowledgeProposalStatus
  source_type: KnowledgeSourceType
  source_ref: string | null
  title: string
  rationale: string
  proposed_content: string
  created_at: string
  applied_at: string | null
  rejected_at: string | null
  rejected_reason: string | null
}

interface ProposalsFile {
  proposals: KnowledgeProposal[]
}

export interface ProposalInput {
  repo: string
  target: string
  action: KnowledgeProposalAction
  source_type: KnowledgeSourceType
  source_ref?: string | null
  title: string
  rationale: string
  proposed_content: string
}

/**
 * Parse the numeric suffix of a `kp-N` id. Returns 0 if it doesn't match.
 */
function idNumber(id: string): number {
  const m = id.match(/^kp-(\d+)$/)
  return m ? Number.parseInt(m[1]!, 10) : 0
}

export class KnowledgeProposalStore {
  private yamlPath: string

  constructor(private baseDir: string) {
    this.yamlPath = join(baseDir, 'knowledge.proposals.yaml')
  }

  list(): KnowledgeProposal[] {
    if (!existsSync(this.yamlPath)) return []
    const content = readFileSync(this.yamlPath, 'utf-8')
    const data = parse(content) as ProposalsFile | null
    return data?.proposals ?? []
  }

  get(id: string): KnowledgeProposal | undefined {
    return this.list().find(p => p.id === id)
  }

  listByStatus(status?: KnowledgeProposalStatus): KnowledgeProposal[] {
    const all = this.list()
    return status ? all.filter(p => p.status === status) : all
  }

  countPending(): number {
    return this.list().filter(p => p.status === 'pending').length
  }

  add(input: ProposalInput): KnowledgeProposal {
    const proposals = this.list()
    const nextNum = proposals.reduce((max, p) => Math.max(max, idNumber(p.id)), 0) + 1
    const proposal: KnowledgeProposal = {
      id: `kp-${nextNum}`,
      repo: input.repo,
      target: input.target,
      action: input.action,
      status: 'pending',
      source_type: input.source_type,
      source_ref: input.source_ref ?? null,
      title: input.title,
      rationale: input.rationale,
      proposed_content: input.proposed_content,
      created_at: todayDate(),
      applied_at: null,
      rejected_at: null,
      rejected_reason: null,
    }
    proposals.push(proposal)
    this.save(proposals)
    return proposal
  }

  /**
   * Mark a pending proposal as applied. Throws if not found or not pending.
   */
  markApplied(id: string): KnowledgeProposal {
    return this.transition(id, (p) => {
      p.status = 'applied'
      p.applied_at = todayDate()
    })
  }

  /**
   * Mark a pending proposal as rejected. Throws if not found or not pending.
   */
  markRejected(id: string, reason?: string): KnowledgeProposal {
    return this.transition(id, (p) => {
      p.status = 'rejected'
      p.rejected_at = todayDate()
      p.rejected_reason = reason ?? null
    })
  }

  private transition(id: string, mutate: (p: KnowledgeProposal) => void): KnowledgeProposal {
    const proposals = this.list()
    const proposal = proposals.find(p => p.id === id)
    if (!proposal) throw new Error(`Proposal "${id}" not found.`)
    if (proposal.status !== 'pending') {
      throw new Error(`Proposal "${id}" is already ${proposal.status}, cannot transition.`)
    }
    mutate(proposal)
    this.save(proposals)
    return proposal
  }

  private save(proposals: KnowledgeProposal[]): void {
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    const data: ProposalsFile = { proposals }
    safeWriteFileSync(this.yamlPath, stringify(data))
  }
}
