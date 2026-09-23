import { describeProcessAsync } from 'contribbot-agent-runtime'
import { recoverConsultTurn } from 'contribbot-core'
import type { ConsultStore } from 'contribbot-core'
import { runConsultTurn as runOrchestratedTurn } from './orchestration.js'
import type { ConsultRunnerDependencies } from './orchestration.js'
import { nativeConsultRuntime } from './runtime.js'

export const defaultConsultRunnerDependencies: ConsultRunnerDependencies = {
  describeSupervisor: describeProcessAsync,
  runtime: nativeConsultRuntime,
}

export function runConsultTurn(
  store: ConsultStore,
  discussionId: string,
  turnId: string,
  dependencies: ConsultRunnerDependencies = defaultConsultRunnerDependencies,
) {
  return runOrchestratedTurn(store, discussionId, turnId, dependencies)
}

export { recoverConsultTurn }
