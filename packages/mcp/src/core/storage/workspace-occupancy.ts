import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { WorkflowCommand, WorkflowState, WorkspaceBinding } from '../execution/contracts.js'
import { inspectWorkspaceIdentity } from '../execution/candidate.js'
import { assertLocalWorkspace } from '../execution/processes.js'
import { unresolvedOperations } from '../execution/workflow.js'
import { withTodoLock } from './todo-lock.js'
import type { TodoItem } from './todo-store.js'

const registryName = 'contribbot-workspaces'
const markerName = '.contribbot-workspaces.json'
const identityName = '.execution-store.json'
const metadataLimit = 16 * 1024 * 1024
const markerSchema = z.object({ version: z.literal(1), id: z.string().uuid() }).strict()
const pathSchema = z.string().min(1).max(32768).refine(isAbsolute)
const referenceSchema = z.object({ directory: pathSchema, id: z.string().uuid() }).strict()
const storeSchema = z.object({
  version: z.literal(1), id: z.string().uuid(),
  registries: z.array(referenceSchema).max(256),
}).strict()
const registrySchema = z.object({
  version: z.literal(1), id: z.string().uuid(),
  participants: z.array(referenceSchema).max(4096),
}).strict()
type Registry = z.infer<typeof registrySchema>

function canonical(directory: string): string {
  const path = realpathSync(directory)
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function regular(path: string, directory = false): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error('Workspace occupancy metadata must be regular files and directories, not links.')
  }
  if (!directory && stat.size > metadataLimit) throw new Error('Workspace occupancy metadata size limit exceeded.')
}

function readJson(path: string): unknown {
  regular(path)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function serialize(value: unknown): string {
  const content = JSON.stringify(value)
  if (Buffer.byteLength(content) > metadataLimit) throw new Error('Workspace occupancy metadata size limit exceeded.')
  return content
}

function publish(path: string, content: string): void {
  if (existsSync(path)) regular(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  }
  finally { rmSync(temporary, { force: true }) }
}

function readRegistry(directory: string): Registry {
  regular(directory, true)
  regular(join(directory, '.locks'), true)
  const result = registrySchema.parse(readJson(join(directory, 'participants.json')))
  if (new Set(result.participants.map(item => item.directory)).size !== result.participants.length) {
    throw new Error('Duplicate workspace occupancy participant.')
  }
  return result
}

function registry(common: string, expectedId?: string): string {
  const directory = join(common, registryName)
  const markerPath = join(common, markerName)
  let initialized = false
  if (!existsSync(markerPath)) {
    if (expectedId || existsSync(directory)) throw new Error('Workspace registry initialization marker is missing; restore the original metadata.')
    try {
      writeFileSync(markerPath, JSON.stringify({ version: 1, id: randomUUID() }), { flag: 'wx', mode: 0o600 })
      initialized = true
    }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
    }
  }
  const marker = markerSchema.parse(readJson(markerPath))
  if (expectedId && marker.id !== expectedId) throw new Error('Workspace registry initialization marker was replaced.')
  if (initialized) {
    // Publish a complete directory; a crash cannot expose an empty partial manifest.
    const temporary = join(common, `${registryName}.init-${randomUUID()}`)
    mkdirSync(temporary)
    try {
      mkdirSync(join(temporary, '.locks'))
      writeFileSync(join(temporary, 'participants.json'), JSON.stringify({
        version: 1, id: marker.id, participants: [],
      }), { flag: 'wx', mode: 0o600 })
      try { renameSync(temporary, directory) }
      catch (error) { if (!existsSync(directory)) throw error }
    }
    finally {
      // Only remove this invocation's staging directory under the verified common dir.
      if (existsSync(temporary) && canonical(temporary) === temporary) rmSync(temporary, { recursive: true })
    }
  }
  if (!existsSync(directory)) {
    throw new Error('Initialized workspace registry is missing or initialization was interrupted; do not recreate empty occupancy.')
  }
  const value = readRegistry(directory)
  if (value.id !== marker.id) throw new Error('Workspace occupancy registry was replaced; restore its original records.')
  return directory
}

interface Occupancy {
  workspace: WorkspaceBinding
  shared: boolean
}

function occupied(state: WorkflowState): Occupancy[] {
  const result: Occupancy[] = []
  for (const operation of unresolvedOperations(state)) {
    const workspace = state.attempts.find(attempt => attempt.id === operation.attempt_id)!.workspace
    const shared = operation.kind === 'read' && operation.status === 'running'
    result.push({ workspace, shared })
    if (operation.delegation) result.push({ workspace: operation.delegation.workspace, shared: false })
  }
  if (state.closing_id && state.attempt_id) {
    result.push({ workspace: state.attempts.find(attempt => attempt.id === state.attempt_id)!.workspace, shared: false })
  }
  return result
}

function todoOccupancy(todos: TodoItem[]): Array<Occupancy & { todoId: string | undefined }> {
  return todos.flatMap(todo => {
    const state = todo.executions.find(execution => execution.closed_at === null)?.workflow
    return state ? occupied(state).map(item => ({ ...item, todoId: todo.id })) : []
  })
}

function sameWorkspace(a: WorkspaceBinding, b: WorkspaceBinding): boolean {
  return a.root === b.root || a.git_dir === b.git_dir
}

export interface WorkspaceTransition {
  directory: string
  todoId: string
  before: WorkflowState
  next: WorkflowState
  command: WorkflowCommand
  readStore: (directory: string) => TodoItem[]
}

/**
 * Caller already holds its project mutex. Foreign stores are only read, never
 * locked. Register before saving, prune after saving; YAML owns operation state.
 */
export function withWorkspaceTransition<T>(input: WorkspaceTransition, save: () => T): T {
  const { before, next, command } = input
  // A durable intent changes no operation, binding or occupancy. It must be
  // recordable even when the original machine/workspace cannot be reached.
  if (command.action === 'request_control') return save()
  const acquiring = before.revision !== next.revision
    && ['begin_operation', 'begin_delegation', 'begin_check', 'reserve_closure'].includes(command.action)
  const requested: Occupancy[] = []
  if (acquiring && next.attempt_id) {
    requested.push({
      workspace: next.attempts.find(attempt => attempt.id === next.attempt_id)!.workspace,
      shared: command.action === 'begin_operation' && command.kind === 'read',
    })
    if (command.action === 'begin_delegation') requested.push({ workspace: command.workspace, shared: false })
  }
  const affected = [...occupied(before), ...occupied(next), ...requested]
  if (affected.length === 0) return save()
  const workspaces = [...new Map(affected.map(item => [item.workspace.git_dir, item.workspace])).values()]
  for (const workspace of workspaces) {
    assertLocalWorkspace(workspace)
    const actual = inspectWorkspaceIdentity(workspace.root)
    if (actual.root !== workspace.root || actual.git_dir !== workspace.git_dir || actual.common_dir !== workspace.common_dir) {
      throw new Error('Bound workspace physical identity changed; reconcile the original workspace before continuing.')
    }
  }
  const common = workspaces[0]!.common_dir
  if (workspaces.some(workspace => workspace.common_dir !== common)) throw new Error('Operation spans unrelated Git repositories.')
  const ownDirectory = canonical(input.directory)
  const identityPath = join(ownDirectory, identityName)
  const identity = existsSync(identityPath) ? storeSchema.parse(readJson(identityPath)) : {
    version: 1 as const, id: randomUUID(), registries: [],
  }
  const registryDirectory = join(common, registryName)
  const expected = identity.registries.find(item => item.directory === registryDirectory)
  const sharedDirectory = registry(common, expected?.id)
  return withTodoLock(sharedDirectory, () => {
    const registered = readRegistry(sharedDirectory)
    if (expected && registered.id !== expected.id) throw new Error('Workspace occupancy registry changed.')
    const ownReference = registered.participants.find(item => item.directory === ownDirectory)
    if (ownReference && ownReference.id !== identity.id) {
      throw new Error('Registered Todo store identity is missing or replaced; restore the original store.')
    }
    const retained: Registry['participants'] = []
    for (const participant of registered.participants) {
      if (participant.directory === ownDirectory) continue
      if (!acquiring) { retained.push(participant); continue }
      let items: TodoItem[]
      try {
        regular(participant.directory, true)
        if (canonical(participant.directory) !== participant.directory) throw new Error('Store moved.')
        const foreign = storeSchema.parse(readJson(join(participant.directory, identityName)))
        if (foreign.id !== participant.id || !foreign.registries.some(item =>
          item.directory === sharedDirectory && item.id === registered.id)) throw new Error('Store replaced.')
        regular(join(participant.directory, 'todos.yaml'))
        items = input.readStore(participant.directory)
      }
      catch {
        throw new Error('Registered Todo store is unavailable, damaged or replaced; occupancy is unknown. Restore its original records.')
      }
      const held = todoOccupancy(items).filter(item => item.workspace.common_dir === common)
      if (held.some(item => requested.some(wanted => sameWorkspace(item.workspace, wanted.workspace) && !(item.shared && wanted.shared)))) {
        throw new Error('Workspace is occupied by another Todo store; reconcile its operation before acquiring it.')
      }
      if (held.length) retained.push(participant)
    }
    if (acquiring) {
      const held = todoOccupancy(input.readStore(ownDirectory)).filter(item => item.todoId !== input.todoId)
      if (held.some(item => requested.some(wanted => sameWorkspace(item.workspace, wanted.workspace) && !(item.shared && wanted.shared)))) {
        throw new Error('Workspace is occupied by another Todo; reconcile its operation before acquiring it.')
      }
    }
    if (!expected) identity.registries.push({ directory: sharedDirectory, id: registered.id })
    registered.participants = [...retained, { directory: ownDirectory, id: identity.id }]
    // Validate both prospective records before publishing either side of the reference.
    const identityContent = serialize(storeSchema.parse(identity))
    const registeredContent = serialize(registrySchema.parse(registered))
    publish(identityPath, identityContent)
    publish(join(sharedDirectory, 'participants.json'), registeredContent)
    const result = save()
    // If a crash interrupts cleanup, the next acquisition reads the committed
    // settled snapshot and removes the now-empty reference, never a live owner.
    if (!todoOccupancy(input.readStore(ownDirectory)).some(item => item.workspace.common_dir === common)) {
      registered.participants = retained
      publish(join(sharedDirectory, 'participants.json'), serialize(registrySchema.parse(registered)))
    }
    return result
  })
}
