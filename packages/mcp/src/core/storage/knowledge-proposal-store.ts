import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import { repositoryRefSchema, sameRepository, type RepositoryRef } from '../utils/repository-ref.js'
import { todayDate } from '../utils/format.js'
import { assertNoSymlinks, safeWriteFileSync } from '../utils/fs.js'
import { KNOWLEDGE_PROPOSAL_ACTIONS, KNOWLEDGE_PROPOSAL_STATUSES, KNOWLEDGE_SOURCE_TYPES } from '../enums.js'

export type { KnowledgeProposalStatus, KnowledgeProposalAction, KnowledgeSourceType } from '../enums.js'
import type { KnowledgeProposalStatus, KnowledgeProposalAction, KnowledgeSourceType } from '../enums.js'

export interface KnowledgeProposal {
  id: string
  repo: RepositoryRef
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
  previous_content?: string | null
  previous_existed?: boolean
  rolled_back_at?: string | null
  evidence_count?: number
  source_refs?: string[]
  last_observed_at?: string
}

interface ProposalsFile {
  proposals: KnowledgeProposal[]
}

const proposalSchema = z.object({
  id: z.string().min(1),
  repo: repositoryRefSchema,
  target: z.string().min(1),
  action: z.enum(KNOWLEDGE_PROPOSAL_ACTIONS),
  status: z.enum(KNOWLEDGE_PROPOSAL_STATUSES),
  source_type: z.enum(KNOWLEDGE_SOURCE_TYPES),
  source_ref: z.string().nullable(),
  title: z.string(),
  rationale: z.string(),
  proposed_content: z.string(),
  created_at: z.string().min(1),
  applied_at: z.string().nullable(),
  rejected_at: z.string().nullable(),
  rejected_reason: z.string().nullable(),
  previous_content: z.string().nullable().optional(),
  previous_existed: z.boolean().optional(),
  rolled_back_at: z.string().nullable().optional(),
  evidence_count: z.number().int().positive().optional(),
  source_refs: z.array(z.string()).optional(),
  last_observed_at: z.string().optional(),
}).strict()
const proposalsFileSchema = z.object({ proposals: z.array(proposalSchema) }).strict()

export interface ProposalInput {
  repo: RepositoryRef
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
  private baseDir: string
  private yamlPath: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.yamlPath = join(baseDir, 'knowledge.proposals.yaml')
  }

  list(): KnowledgeProposal[] {
    assertNoSymlinks(this.yamlPath)
    if (!existsSync(this.yamlPath)) return []
    const content = readFileSync(this.yamlPath, 'utf-8')
    let data: z.infer<typeof proposalsFileSchema>
    try { data = proposalsFileSchema.parse(parse(content)) }
    catch (error) { throw new Error(`Invalid knowledge proposals at ${this.yamlPath}: ${String(error)}`) }
    return data.proposals.map(p => ({
      ...p,
      evidence_count: p.evidence_count ?? 1,
      source_refs: p.source_refs ?? (p.source_ref ? [p.source_ref] : []),
      last_observed_at: p.last_observed_at ?? p.created_at,
      previous_content: p.previous_content ?? null,
      previous_existed: p.previous_existed ?? false,
      rolled_back_at: p.rolled_back_at ?? null,
    }))
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
      evidence_count: 1,
      source_refs: input.source_ref ? [input.source_ref] : [],
      last_observed_at: todayDate(),
      previous_content: null,
      previous_existed: false,
      rolled_back_at: null,
    }
    proposals.push(proposal)
    this.save(proposals)
    return proposal
  }

  addOrRefresh(input: ProposalInput): { proposal: KnowledgeProposal; created: boolean } {
    const proposals = this.list()
    const existing = proposals.find(p =>
      p.status === 'pending'
      && sameRepository(p.repo, input.repo)
      && p.target === input.target
      && p.action === input.action
      && p.title === input.title
      && p.proposed_content === input.proposed_content,
    )
    if (!existing) return { proposal: this.add(input), created: true }

    existing.evidence_count = (existing.evidence_count ?? 1) + 1
    existing.last_observed_at = todayDate()
    if (input.source_ref && !(existing.source_refs ?? []).includes(input.source_ref)) {
      existing.source_refs = [...(existing.source_refs ?? []), input.source_ref]
    }
    if (input.rationale && input.rationale !== existing.rationale) {
      existing.rationale = `${existing.rationale}\n\nAdditional evidence: ${input.rationale}`.trim()
    }
    this.save(proposals)
    return { proposal: existing, created: false }
  }

  /**
   * Mark a pending proposal as applied. Throws if not found or not pending.
   */
  markApplied(id: string, previous?: { existed: boolean; content: string | null }): KnowledgeProposal {
    return this.transition(id, (p) => {
      p.status = 'applied'
      p.applied_at = todayDate()
      p.previous_existed = previous?.existed ?? false
      p.previous_content = previous?.content ?? null
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

  markRolledBack(id: string): KnowledgeProposal {
    const proposals = this.list()
    const proposal = proposals.find(p => p.id === id)
    if (!proposal) throw new Error(`Proposal "${id}" not found.`)
    if (proposal.status !== 'applied') {
      throw new Error(`Proposal "${id}" is ${proposal.status}, only applied proposals can be rolled back.`)
    }
    proposal.status = 'rolled_back'
    proposal.rolled_back_at = todayDate()
    this.save(proposals)
    return proposal
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
    assertNoSymlinks(this.yamlPath)
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    assertNoSymlinks(this.yamlPath)
    assertNoSymlinks(`${this.yamlPath}.tmp`)
    const data: ProposalsFile = { proposals }
    safeWriteFileSync(this.yamlPath, stringify(proposalsFileSchema.parse(data)))
  }
}
