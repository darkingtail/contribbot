export type TodoLifecycleStatus = 'idea' | 'backlog' | 'active' | 'paused' | 'done' | 'cancelled'

export interface TodoConfirmedPlanReadModel {
  id: string
  digest: string
}

export interface TodoExecutionReadModel {
  id: string
  hasActiveControl: boolean
  confirmedPlan: TodoConfirmedPlanReadModel | null
}

export interface TodoReadModel {
  id: string
  lifecycleRevision: number
  status: TodoLifecycleStatus
  pendingTransition: boolean
  execution: TodoExecutionReadModel | null
}

/** Read-only view used by other domains. Implementations must not mutate Todo state. */
export interface TodoReadPort {
  read(todoId: string): TodoReadModel | null
}
