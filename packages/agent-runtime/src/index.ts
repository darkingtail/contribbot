export { advisorEnvironment } from './environment.js'
export { executableDigest, inspectProviderBinding } from './binding.js'
export type { ProviderBindingDescriptor, ProviderInspectionInput } from './binding.js'
export { nativeBindings, providerDisclosure, providerRequiredFlags } from './providers.js'
export type { AdvisorRuntime, ProviderBindingInput, ProviderProtocolBinding } from './providers.js'
export { describeProcess, describeProcessAsync, localMachine, observeProcess } from './process.js'
export type { ProcessHandle, ProcessMachine, ProcessObservation } from './process.js'
export { probeCodexReadonly } from './sandbox.js'
export { prepareProviderRun, verifyProviderBinding } from './session.js'
export type { CapabilityEvidence, PreparedProviderRun, ProviderPreparation } from './session.js'
export type { ReadonlyProbeBinding } from './sandbox.js'
export { MAX_OUTPUT_BYTES, pipeTransport } from './transport.js'
export type {
  AgentEvent,
  LaunchPlan,
  RuntimeOutcome,
  RuntimeProtocolBinding,
  SessionTransport,
  TurnControl,
} from './transport.js'

export const PACKAGE_BOUNDARY = Object.freeze({
  package: 'contribbot-agent-runtime',
  scope: 'provider-process-transport' as const,
})
