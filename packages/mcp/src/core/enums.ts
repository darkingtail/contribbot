export const ProjectStatus = { Active: 'active', Archived: 'archived' } as const
export type ProjectStatus = typeof ProjectStatus[keyof typeof ProjectStatus]
export const PROJECT_STATUSES = Object.values(ProjectStatus) as [ProjectStatus, ...ProjectStatus[]]

export const TodoStatus = { Idea: 'idea', Backlog: 'backlog', Active: 'active', Paused: 'paused', Cancelled: 'cancelled', Done: 'done' } as const
export type TodoStatus = typeof TodoStatus[keyof typeof TodoStatus]
export const TODO_STATUSES = Object.values(TodoStatus) as [TodoStatus, ...TodoStatus[]]
export const TODO_UPDATABLE_STATUSES = [
  TodoStatus.Idea,
  TodoStatus.Backlog,
  TodoStatus.Active,
] as const

export const TodoType = { Bug: 'bug', Feature: 'feature', Docs: 'docs', Chore: 'chore' } as const
export type TodoType = typeof TodoType[keyof typeof TodoType]
export const TODO_TYPES = Object.values(TodoType) as [TodoType, ...TodoType[]]

export const TodoDifficulty = { Easy: 'easy', Medium: 'medium', Hard: 'hard' } as const
export type TodoDifficulty = typeof TodoDifficulty[keyof typeof TodoDifficulty]
export const TODO_DIFFICULTIES = Object.values(TodoDifficulty) as [TodoDifficulty, ...TodoDifficulty[]]

export const TodoExecutionPhase = { Understand: 'understand', Execute: 'execute', Check: 'check', Finish: 'finish' } as const
export type TodoExecutionPhase = typeof TodoExecutionPhase[keyof typeof TodoExecutionPhase]
export const TODO_EXECUTION_PHASES = Object.values(TodoExecutionPhase) as [TodoExecutionPhase, ...TodoExecutionPhase[]]

export const TodoExecutionOutcome = { Done: 'done', Abandoned: 'abandoned' } as const
export type TodoExecutionOutcome = typeof TodoExecutionOutcome[keyof typeof TodoExecutionOutcome]
export const TODO_EXECUTION_OUTCOMES = Object.values(TodoExecutionOutcome) as [TodoExecutionOutcome, ...TodoExecutionOutcome[]]

export const TodoEvidenceSource = {
  Issue: 'issue',
  Pr: 'pr',
  Review: 'review',
  PatrolRun: 'patrol_run',
  Action: 'action',
  Revision: 'revision',
  Test: 'test',
  Worktree: 'worktree',
  Human: 'human',
} as const
export type TodoEvidenceSource = typeof TodoEvidenceSource[keyof typeof TodoEvidenceSource]
export const TODO_EVIDENCE_SOURCES = Object.values(TodoEvidenceSource) as [TodoEvidenceSource, ...TodoEvidenceSource[]]

export const UpstreamItemStatus = { Active: 'active', PrSubmitted: 'pr_submitted', Done: 'done' } as const
export type UpstreamItemStatus = typeof UpstreamItemStatus[keyof typeof UpstreamItemStatus]
export const UPSTREAM_ITEM_STATUSES = Object.values(UpstreamItemStatus) as [UpstreamItemStatus, ...UpstreamItemStatus[]]

export const UpstreamVersionStatus = { Active: 'active', Done: 'done' } as const
export type UpstreamVersionStatus = typeof UpstreamVersionStatus[keyof typeof UpstreamVersionStatus]

export const DailyCommitAction = { Skip: 'skip', Todo: 'todo', Issue: 'issue', Pr: 'pr', Synced: 'synced' } as const
export type DailyCommitAction = typeof DailyCommitAction[keyof typeof DailyCommitAction]
export const DAILY_COMMIT_ACTIONS = Object.values(DailyCommitAction) as [DailyCommitAction, ...DailyCommitAction[]]

export const RepoRole = { Admin: 'admin', Maintain: 'maintain', Write: 'write', Triage: 'triage', Read: 'read' } as const
export type RepoRole = typeof RepoRole[keyof typeof RepoRole]

export const PRType = { Feat: 'feat', Fix: 'fix', Other: 'other' } as const
export type PRType = typeof PRType[keyof typeof PRType]

export const KnowledgeProposalStatus = { Pending: 'pending', Applied: 'applied', Rejected: 'rejected', RolledBack: 'rolled_back' } as const
export type KnowledgeProposalStatus = typeof KnowledgeProposalStatus[keyof typeof KnowledgeProposalStatus]
export const KNOWLEDGE_PROPOSAL_STATUSES = Object.values(KnowledgeProposalStatus) as [KnowledgeProposalStatus, ...KnowledgeProposalStatus[]]

export const KnowledgeProposalAction = { Create: 'create', Append: 'append', Revise: 'revise' } as const
export type KnowledgeProposalAction = typeof KnowledgeProposalAction[keyof typeof KnowledgeProposalAction]
export const KNOWLEDGE_PROPOSAL_ACTIONS = Object.values(KnowledgeProposalAction) as [KnowledgeProposalAction, ...KnowledgeProposalAction[]]

export const KnowledgeSourceType = { Todo: 'todo', Issue: 'issue', Pr: 'pr', Review: 'review', Debug: 'debug', DailySync: 'daily-sync', Patrol: 'patrol', Manual: 'manual' } as const
export type KnowledgeSourceType = typeof KnowledgeSourceType[keyof typeof KnowledgeSourceType]
export const KNOWLEDGE_SOURCE_TYPES = Object.values(KnowledgeSourceType) as [KnowledgeSourceType, ...KnowledgeSourceType[]]

export function validateEnum<T extends string>(values: readonly T[], value: string, label: string): T {
  if (!(values as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${label}: "${value}". Expected one of: ${values.join(', ')}`)
  }
  return value as T
}
