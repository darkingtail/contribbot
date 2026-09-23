export const PACKAGE_BOUNDARY = Object.freeze({
  package: 'contribbot-core',
  scope: 'domain-contracts' as const,
})

export type {
  TodoConfirmedPlanReadModel,
  TodoExecutionReadModel,
  TodoLifecycleStatus,
  TodoReadModel,
  TodoReadPort,
} from './todo/read-port.js'
export type { SynchronousTransactionPort } from './consult/transaction-port.js'
export type { ProcessHandle as CoreProcessHandle, ProcessMachine, ProcessObservation, ProcessObserverPort } from './consult/process-observer-port.js'
export {
  categorySchema,
  authorizationSchema,
  bindingSchema,
  databaseSchema,
  decisionSchema,
  digest,
  digestSchema,
  discussionSchema,
  grantSchema,
  grantSpecSchema,
  idSchema,
  manifestEntrySchema,
  materialSchema,
  MAX_PACKET_BYTES,
  packetInputSchema,
  packetSchema,
  processSchema,
  purposeSchema,
  reconcileInputSchema,
  reconciliationReportSchema,
  reconciliationSchema,
  releaseObservationSchema,
  resultSchema,
  runtimeInputSchema,
  runtimeSchema,
  scopeSchema,
  synthesisSchema,
  textSchema,
  todoSnapshotSchema,
  turnSchema,
  occupiesLocal,
} from './consult/contracts.js'
export type {
  Authorization,
  Binding,
  Database,
  Decision,
  Discussion,
  Grant,
  GrantSpec,
  Packet,
  PacketInput,
  ReconcileInput,
  RuntimeInput,
  Scope,
  TodoSnapshot,
  Turn,
  TurnResult,
} from './consult/contracts.js'
export { assertNoCredentials, buildPacket, denySensitivePath, normalizedPath, scopeAllows, workspaceFile } from './consult/packet.js'
export type { HistoryItem } from './consult/packet.js'
export { MAX_RECORD_BYTES, consultDirectory, readBounded, writeRecord } from './consult/files.js'
export { ConsultStore } from './consult/store.js'
export type { ConsultStorePorts, ReserveInput } from './consult/store.js'
export { failedResult, recoverConsultTurn } from './consult/receipts.js'
export { createConsultStore } from './consult/composition.js'
export type { CoreConsultStoreDependencies } from './consult/composition.js'
export { withTodoLock } from './todo/lock.js'
export { createFileTodoReadPort, readTodoModel } from './todo/file-read.js'
