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
