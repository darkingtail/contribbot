export const PACKAGE_BOUNDARY = Object.freeze({
  package: 'contribbot-runner',
  scope: 'wiring-only' as const,
})

export { defaultConsultRunnerDependencies, recoverConsultTurn, runConsultTurn } from './consult.js'
export { nativeConsultRuntime } from './runtime.js'
export { launchConsultWorker } from './supervisor.js'
export type {
  ConsultPreparation, ConsultRunnerDependencies, ConsultRuntimeHooks, ConsultTurnRuntime, PreparedConsultInvocation,
} from './orchestration.js'
