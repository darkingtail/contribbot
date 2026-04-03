export const TodoStatus = { Idea: 'idea', Backlog: 'backlog', Active: 'active', PrSubmitted: 'pr_submitted', Done: 'done', NotPlanned: 'not_planned' } as const
export type TodoStatus = typeof TodoStatus[keyof typeof TodoStatus]
export const TODO_STATUSES = Object.values(TodoStatus) as [TodoStatus, ...TodoStatus[]]

export const TodoType = { Bug: 'bug', Feature: 'feature', Docs: 'docs', Chore: 'chore' } as const
export type TodoType = typeof TodoType[keyof typeof TodoType]
export const TODO_TYPES = Object.values(TodoType) as [TodoType, ...TodoType[]]

export const TodoDifficulty = { Easy: 'easy', Medium: 'medium', Hard: 'hard' } as const
export type TodoDifficulty = typeof TodoDifficulty[keyof typeof TodoDifficulty]
export const TODO_DIFFICULTIES = Object.values(TodoDifficulty) as [TodoDifficulty, ...TodoDifficulty[]]

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

export function validateEnum<T extends string>(values: readonly T[], value: string, label: string): T {
  if (!(values as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${label}: "${value}". Expected one of: ${values.join(', ')}`)
  }
  return value as T
}
