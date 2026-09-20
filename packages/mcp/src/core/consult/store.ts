import { existsSync, readdirSync, realpathSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { z } from 'zod'
import { withTodoLock } from '../storage/todo-lock.js'
import { TodoStore, currentTodoExecution } from '../storage/todo-store.js'
import { activeControl } from '../execution/workflow.js'
import { localMachine, observeProcess } from '../execution/processes.js'
import { consultDirectory, readBounded, writeRecord } from './files.js'
import {
  authorizationSchema, bindingSchema, databaseSchema, decisionSchema, digest, grantSpecSchema, idSchema,
  occupiesLocal, packetSchema, purposeSchema, reconcileInputSchema, resultSchema, synthesisSchema, todoSnapshotSchema,
} from './contracts.js'
import type {
  Database, Decision, Discussion, Grant, GrantSpec, Packet, ReconcileInput, TodoSnapshot, Turn, TurnResult,
} from './contracts.js'
import { assertNoCredentials, normalizedPath, scopeAllows, workspaceFile } from './packet.js'
import type { HistoryItem } from './packet.js'

const reserveSchema = z.object({
  request_id: idSchema, discussion_id: idSchema, purpose: purposeSchema,
  mode: z.enum(['fresh', 'rehydrate']), todo_id: idSchema.nullable(),
  expected_todo: todoSnapshotSchema.nullable(),
  packet: packetSchema, binding: bindingSchema, authorization: authorizationSchema,
  start_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
export type ReserveInput = z.input<typeof reserveSchema>
const now = () => new Date().toISOString()
const stoppedGrant = (grant: Grant) => grant.events.some(event => ['revoked', 'expired'].includes(event.kind))
const reservations = (grant: Grant) => grant.events.filter(event => event.kind === 'reserved').length

export class ConsultStore {
  readonly directory: string
  constructor(directory: string) { this.directory = directory }

  private root(create = false) { return consultDirectory(this.directory, create) }
  private path() { return join(this.root(), 'discussions.yaml') }
  private rawPath(turnId: string, kind: 'packet' | 'result') {
    return join(this.root(), `${idSchema.parse(turnId)}.${kind}.json`)
  }
  private rawFiles(turnId: string): string[] {
    idSchema.parse(turnId)
    const pattern = new RegExp(`^${turnId}\\.(?:packet|result)\\.json(?:\\.[a-f0-9-]{36}\\.pending)?$`)
    return readdirSync(this.root()).filter(name => pattern.test(name)).sort()
  }

  read(): Database {
    if (!existsSync(this.path())) return { version: 1, discussions: [], grants: [] }
    return databaseSchema.parse(parse(readBounded(this.path()).toString('utf8')))
  }
  get(id: string): Discussion {
    const value = this.read().discussions.find(item => item.id === idSchema.parse(id))
    if (!value) throw new Error('Consult discussion not found.')
    return value
  }
  list(todoId?: string) {
    return this.read().discussions.filter(item => !todoId || item.todo_id === todoId).map(item => ({
      id: item.id, kind: item.kind, todo_id: item.todo_id, purpose: item.purpose,
      status: item.status, revision: item.revision, turn_count: item.turns.length,
      notes: 'Advisory only; not acceptance or permission.',
    }))
  }
  private save(data: Database) {
    const content = stringify(databaseSchema.parse(data))
    this.root(true)
    writeRecord(this.path(), content)
  }
  private transaction<T>(fn: (data: Database) => T): T {
    this.root(true)
    return withTodoLock(this.directory, () => {
      const data = this.read()
      // Expiration is an observed fact, including when the requested action is rejected.
      if (this.expireGrants(data)) this.save(data)
      const result = fn(data)
      this.save(data)
      return result
    })
  }
  private discussion(data: Database, id: string): Discussion {
    const result = data.discussions.find(item => item.id === id)
    if (!result) throw new Error('Consult discussion not found.')
    return result
  }
  private turn(data: Database, discussionId: string, turnId: string): { discussion: Discussion; turn: Turn } {
    const discussion = this.discussion(data, discussionId)
    const turn = discussion.turns.find(item => item.id === turnId)
    if (!turn) throw new Error('Consult turn not found.')
    return { discussion, turn }
  }
  private checkRevision(discussion: Discussion, revision: number) {
    if (discussion.revision !== revision) throw new Error('Consult revision changed. Read the current discussion before writing.')
  }

  todoSnapshot(id: string | null, requireActive = true): TodoSnapshot | null {
    if (!id) return null
    const todo = new TodoStore(this.directory).resolveItemFromAll(id)
    if (!todo || todo.id !== id) throw new Error('Exact stable Todo id required.')
    const execution = currentTodoExecution(todo)
    if (requireActive && (todo.pending_transition || ['paused', 'done', 'cancelled'].includes(todo.status)
      || (execution?.workflow && activeControl(execution.workflow)))) {
      throw new Error('Todo is paused, stopped, ended or transitioning; no new consultation can start.')
    }
    const workflow = execution?.workflow
    const plan = workflow?.plans.find(item => item.id === workflow.plan_id)
    return {
      id, lifecycle_revision: todo.lifecycle_revision ?? 0, execution_id: execution?.id ?? null,
      plan_id: plan?.confirmation ? plan.id : null, plan_digest: plan?.confirmation ? plan.digest : null,
    }
  }

  private validPolicy(spec: GrantSpec) {
    if (!spec.policy) return
    const file = workspaceFile(spec.workspace, spec.policy.path)
    if (digest(readBounded(file).toString('utf8')) !== spec.policy.digest) throw new Error('Acknowledged policy digest changed.')
  }

  private expireGrants(data: Database): boolean {
    let changed = false
    for (const grant of data.grants.filter(item => !stoppedGrant(item))) {
      let reason: string | undefined
      try {
        const snapshot = this.todoSnapshot(grant.spec.todo_id ?? null, false)
        if (snapshot?.lifecycle_revision !== (grant.todo_generation ?? undefined)) reason = 'Todo generation changed.'
        if (grant.spec.todo_id) {
          const todo = new TodoStore(this.directory).resolveItemFromAll(grant.spec.todo_id)
          if (todo && ['done', 'cancelled'].includes(todo.status)) reason = 'Todo ended.'
        }
        this.validPolicy(grant.spec)
      }
      catch { reason = 'Acknowledged policy or Todo identity can no longer be verified.' }
      if (reason) {
        grant.events.push({ kind: 'expired', at: now(), note: reason })
        changed = true
      }
    }
    return changed
  }

  grant(input: { id: string; spec: GrantSpec; decision: Decision; confirmed_digest: string }): Grant {
    const spec = grantSpecSchema.parse(input.spec)
    decisionSchema.parse(input.decision)
    idSchema.parse(input.id)
    if (realpathSync(spec.workspace) !== spec.workspace) throw new Error('Grant workspace must use the canonical path from the preview.')
    for (const path of spec.scope.paths) if (path !== '.') normalizedPath(path)
    if (digest(spec) !== input.confirmed_digest) throw new Error('Grant confirmation digest does not match.')
    this.validPolicy(spec)
    return this.transaction(data => {
      const previous = data.grants.find(item => item.id === input.id)
      if (previous) {
        if (previous.digest !== input.confirmed_digest || digest(previous.decision) !== digest(input.decision)) {
          throw new Error('Grant id already records a different decision.')
        }
        return previous
      }
      const todo = this.todoSnapshot(spec.todo_id ?? null)
      const grant: Grant = {
        id: input.id, spec, digest: input.confirmed_digest, decision: input.decision,
        todo_generation: todo?.lifecycle_revision ?? null,
        events: [{ kind: 'granted', at: now(), note: input.decision.source }],
      }
      data.grants.push(grant)
      return grant
    })
  }
  revoke(grantId: string, decision: Decision): Grant {
    decisionSchema.parse(decision)
    return this.transaction(data => {
      const grant = data.grants.find(item => item.id === grantId)
      if (!grant) throw new Error('Consult grant not found.')
      if (!stoppedGrant(grant)) grant.events.push({ kind: 'revoked', at: now(), note: JSON.stringify(decision) })
      return grant
    })
  }

  reserve(raw: ReserveInput): { discussion_id: string; turn: Turn; replayed: boolean } {
    const input = reserveSchema.parse(raw)
    if (input.authorization.denied) throw new Error('Consultation denied by the current user decision.')
    if (digest(input.packet.body) !== input.packet.digest) throw new Error('Packet digest mismatch.')
    assertNoCredentials(input.packet.body)
    const requestDigest = digest(input)
    return this.transaction(data => {
      const duplicate = data.discussions.flatMap(discussion =>
        discussion.turns.map(turn => ({ discussion, turn }))).find(item => item.turn.request_id === input.request_id)
      if (duplicate) {
        if (duplicate.turn.request_digest !== requestDigest) throw new Error('Request id already has different content.')
        return { discussion_id: duplicate.discussion.id, turn: duplicate.turn, replayed: true }
      }
      const todo = this.todoSnapshot(input.todo_id)
      if (digest(todo) !== digest(input.expected_todo)) throw new Error('Todo snapshot changed after preview; confirm the current context.')
      let discussion = data.discussions.find(item => item.id === input.discussion_id)
      if (discussion && (discussion.status !== 'open' || discussion.todo_id !== input.todo_id
        || discussion.purpose !== input.purpose || discussion.workspace !== input.packet.workspace)) {
        throw new Error('Discussion scope changed or it is closed.')
      }
      // The concurrency bound is local only; explicit reconciliation can retain remote uncertainty.
      if (data.discussions.some(item => (item.id === input.discussion_id || (input.todo_id && item.todo_id === input.todo_id))
        && item.turns.some(occupiesLocal))) {
        throw new Error('A consultation is still running or unresolved. Observe the original turn; do not replay it.')
      }
      if (discussion?.turns.some(turn => turn.binding.runtime !== input.binding.runtime)
        && !input.authorization.additional_advisor) throw new Error('Adding another advisor requires an explicit user decision.')
      let grant: Grant | undefined
      if (!input.authorization.explicit_once) {
        grant = data.grants.find(item => item.id === input.authorization.grant_id)
        if (!grant) throw new Error('No matching consultation authorization.')
        this.validPolicy(grant.spec)
        if (stoppedGrant(grant) || reservations(grant) >= grant.spec.max_turns) throw new Error('Consult grant is revoked, expired or exhausted.')
        if ((grant.spec.todo_id ?? null) !== input.todo_id || grant.todo_generation !== (todo?.lifecycle_revision ?? null)) {
          throw new Error('Consult grant Todo generation changed; reopening does not revive a grant.')
        }
        if (grant.spec.workspace !== input.packet.workspace || !grant.spec.purposes.includes(input.purpose)
          || !grant.spec.runtimes.some(runtime => runtime.runtime === input.binding.runtime
            && runtime.disclosure_digest === input.binding.disclosure_digest)
          || !scopeAllows(grant.spec.scope, input.packet)) throw new Error('Consult grant scope or disclosure mismatch.')
      }
      if (!discussion) {
        discussion = {
          id: input.discussion_id, kind: 'consultation', purpose: input.purpose, todo_id: input.todo_id,
          workspace: input.packet.workspace, revision: 0, created_at: now(), status: 'open',
          turns: [], syntheses: [], decisions: [],
        }
        data.discussions.push(discussion)
      }
      const turnId = `turn-${digest(input.request_id).slice(0, 32)}`
      const turn: Turn = {
        id: turnId, request_id: input.request_id, request_digest: requestDigest,
        start_digest: input.start_digest ?? null,
        question_digest: input.packet.manifest.find(item => item.category === 'question')?.sha256 ?? digest(''),
        packet_digest: input.packet.digest, manifest: input.packet.manifest, omitted: input.packet.omitted,
        binding: input.binding, todo, mode: input.mode,
        authorization: {
          source: grant?.spec.source ?? 'explicit_once',
          decision: input.authorization.explicit_once ?? grant!.decision, grant_id: grant?.id ?? null,
        },
        created_at: now(), claimed_at: null, supervisor: null, advisor: null,
        dispatch_started_at: null, scratch_directory: null, sandbox_probe: null,
        lifecycle: 'reserved', outcome: null, output_digest: null, integrity: 'ok',
        unresolved: [], controls: [], late: false, raw_purged: false, reconciliations: [], release_observations: [],
      }
      this.root(true)
      writeRecord(this.rawPath(turnId, 'packet'), JSON.stringify(input.packet), true)
      discussion.turns.push(turn)
      discussion.revision++
      if (grant) {
        grant.events.push({ kind: 'reserved', at: now(), turn_id: turnId, note: 'Counts against allowance even if the result is lost.' })
        if (reservations(grant) === grant.spec.max_turns) grant.events.push({ kind: 'exhausted', at: now(), note: 'All turns reserved.' })
      }
      return { discussion_id: discussion.id, turn, replayed: false }
    })
  }

  private dispatchable(data: Database, discussion: Discussion, turn: Turn) {
    if (discussion.status !== 'open') throw new Error('Discussion is closed.')
    const snapshot = this.todoSnapshot(discussion.todo_id)
    if (digest(snapshot) !== digest(turn.todo)) throw new Error('Todo context changed before dispatch; obtain a new preview.')
    if (turn.controls.some(item => item.action !== 'stop_wait')) throw new Error('Consult turn was stopped before dispatch.')
    if (turn.authorization.grant_id) {
      const grant = data.grants.find(item => item.id === turn.authorization.grant_id)
      if (!grant || stoppedGrant(grant)) throw new Error('Grant revoked or expired before dispatch.')
      this.validPolicy(grant.spec)
      if (grant.todo_generation !== (snapshot?.lifecycle_revision ?? null)
        || grant.spec.workspace !== discussion.workspace
        || !grant.spec.purposes.includes(discussion.purpose)
        || !grant.spec.runtimes.some(item => item.runtime === turn.binding.runtime
          && item.disclosure_digest === turn.binding.disclosure_digest)
        || !scopeAllows(grant.spec.scope, { manifest: turn.manifest })) throw new Error('Grant scope changed before dispatch.')
    }
  }

  claim(discussionId: string, turnId: string, supervisor: Turn['supervisor']): boolean {
    return this.transaction(data => {
      const { discussion, turn } = this.turn(data, discussionId, turnId)
      if (turn.claimed_at || turn.lifecycle !== 'reserved') return false
      this.dispatchable(data, discussion, turn)
      turn.claimed_at = now()
      turn.supervisor = supervisor
      turn.lifecycle = 'running'
      discussion.revision++
      return true
    })
  }
  /** The synchronous spawn is inside the same lock as revocation and Todo control. */
  dispatch<T>(discussionId: string, turnId: string, start: () => T): T {
    return withTodoLock(this.directory, () => {
      const data = this.read()
      if (this.expireGrants(data)) this.save(data)
      const { discussion, turn } = this.turn(data, discussionId, turnId)
      if (turn.lifecycle !== 'running' || turn.dispatch_started_at) throw new Error('Consult dispatch already started or is not running.')
      this.dispatchable(data, discussion, turn)
      turn.dispatch_started_at = now()
      discussion.revision++
      this.save(data)
      return start()
    })
  }
  prepared(discussionId: string, turnId: string, scratch: string | null, probe: Turn['sandbox_probe']): void {
    this.transaction(data => {
      const { discussion, turn } = this.turn(data, discussionId, turnId)
      if (turn.dispatch_started_at || turn.lifecycle !== 'running') throw new Error('Cannot change dispatched preparation.')
      turn.scratch_directory = scratch
      turn.sandbox_probe = probe ? { verified: probe.verified, reason: probe.reason, digest: probe.digest } : null
      discussion.revision++
    })
  }
  attach(discussionId: string, turnId: string, handle: NonNullable<Turn['advisor']>): void {
    this.transaction(data => {
      const { discussion, turn } = this.turn(data, discussionId, turnId)
      if (turn.lifecycle !== 'running' || turn.advisor) throw new Error('Consult process cannot be rebound.')
      turn.advisor = handle
      discussion.revision++
    })
  }
  readPacket(turn: Turn): Packet {
    if (turn.raw_purged) throw new Error('Raw consultation data was purged.')
    const packet = packetSchema.parse(JSON.parse(readBounded(this.rawPath(turn.id, 'packet')).toString('utf8')))
    if (packet.digest !== turn.packet_digest || digest(packet.body) !== packet.digest) throw new Error('Stored packet digest mismatch.')
    return packet
  }
  readResult(turn: Turn): TurnResult | null {
    if (turn.raw_purged) return null
    if (!existsSync(this.rawPath(turn.id, 'result'))) return null
    const bytes = readBounded(this.rawPath(turn.id, 'result'))
    if (turn.output_digest && digest(bytes.toString('utf8')) !== turn.output_digest) throw new Error('Advisory output digest mismatch.')
    return resultSchema.parse(JSON.parse(bytes.toString('utf8')))
  }
  settle(discussionId: string, turnId: string, raw: TurnResult): Turn {
    const result = resultSchema.parse(raw)
    const content = JSON.stringify(result)
    return this.transaction(data => {
      const { discussion, turn } = this.turn(data, discussionId, turnId)
      if (turn.raw_purged) throw new Error('Cannot restore purged raw data.')
      if (turn.output_digest) {
        if (turn.output_digest !== digest(content)) throw new Error('Terminal advisor result is immutable.')
        return turn
      }
      writeRecord(this.rawPath(turn.id, 'result'), content, true)
      turn.output_digest = digest(content)
      turn.outcome = result.outcome
      turn.integrity = result.integrity
      turn.unresolved = result.unresolved
      turn.lifecycle = turn.reconciliations.length ? 'reconciled_by_attestation'
        : result.unresolved.length ? 'reconciling' : 'settled'
      let contextChanged = false
      try {
        const snapshot = this.todoSnapshot(discussion.todo_id)
        contextChanged = digest(snapshot) !== digest(turn.todo)
      }
      catch { contextChanged = true }
      const grant = data.grants.find(item => item.id === turn.authorization.grant_id)
      turn.late = Boolean(turn.reconciliations.length) || contextChanged || turn.controls.some(control => control.action === 'abandon')
        || Boolean(grant && stoppedGrant(grant))
      if (grant) grant.events.push({ kind: 'consumed', at: now(), turn_id: turn.id, note: result.outcome })
      discussion.revision++
      return turn
    })
  }
  control(discussionId: string, turnId: string, action: Turn['controls'][number]['action'], decision: Decision): Turn {
    decisionSchema.parse(decision)
    return this.transaction(data => {
      const { discussion, turn } = this.turn(data, discussionId, turnId)
      if (!['stop_wait', 'terminate_advisor', 'abandon'].includes(action)) throw new Error('Unsupported consult control.')
      if (!turn.controls.some(item => item.action === action && digest(item.decision) === digest(decision))) {
        turn.controls.push({ action, decision, at: now() })
        if (action === 'abandon') turn.late = true
        discussion.revision++
      }
      return turn
    })
  }
  private observeStoppedRoots(turn: Turn) {
    if (!turn.supervisor) throw new Error('Original supervisor identity is missing; no stopped-root observation can be established. Local occupancy is retained.')
    const machine = localMachine()
    const handles = [...new Map([turn.supervisor, turn.advisor]
      .filter(handle => handle !== null).map(handle => [digest(handle), handle])).values()]
    return handles.map(handle => {
      if (handle.machine.hostname !== machine.hostname || handle.machine.platform !== machine.platform) {
        throw new Error('Original process belongs to another machine; observe it there.')
      }
      const observation = observeProcess(handle)
      if (observation.state !== 'stopped' && observation.state !== 'replaced') {
        throw new Error(`Original process is ${observation.state}; local occupancy is retained.`)
      }
      if (observation.state === 'replaced' && handle.started_at === null) {
        throw new Error('Original process start time is unknown; PID reuse cannot establish termination.')
      }
      return { handle, observation: { ...observation, state: observation.state } }
    })
  }
  observeRelease(discussionId: string, turnId: string, revision: number): Turn['release_observations'][number] {
    return this.transaction(data => {
      const { discussion, turn } = this.turn(data, discussionId, turnId)
      const previous = turn.release_observations.find(item => item.revision === discussion.revision)
      // An exact prepare retry can still name the revision from before this observation was appended.
      if (previous && revision === previous.revision - 1) return previous
      this.checkRevision(discussion, revision)
      if (!occupiesLocal(turn)) throw new Error('Consult local occupancy is already released.')
      if (previous) return previous
      const localHandles = this.observeStoppedRoots(turn)
      const observation: Turn['release_observations'][number] = {
        id: `observation-${randomUUID()}`, at: now(), revision: ++discussion.revision,
        machine: localMachine(), local_handles: localHandles,
      }
      turn.release_observations.push(observation)
      return observation
    })
  }
  reconcile(discussionId: string, turnId: string, raw: ReconcileInput): Turn {
    const input = reconcileInputSchema.parse(raw)
    const requestDigest = digest({ discussion_id: discussionId, turn_id: turnId, ...input })
    assertNoCredentials(JSON.stringify(input.report))
    return this.transaction(data => {
      const { discussion, turn } = this.turn(data, discussionId, turnId)
      const previous = discussion.turns.flatMap(item => item.reconciliations).find(item => item.id === input.id)
      if (previous) {
        if (previous.request_digest !== requestDigest) throw new Error('Reconciliation id conflict; the original report, revision and decision are immutable.')
        return turn
      }
      this.checkRevision(discussion, input.expected_revision)
      if (!occupiesLocal(turn)) throw new Error('Consult local occupancy is already released.')
      const barrier = turn.release_observations.find(item => item.id === input.observation_id)
      if (!barrier || barrier.revision !== discussion.revision) {
        throw new Error('Stopped-root observation is missing or stale; prepare again and inspect descendants afterwards.')
      }
      const machine = localMachine()
      const isLocal = (identity: { hostname: string; platform: string }) =>
        identity.hostname === machine.hostname && identity.platform === machine.platform
      if (!isLocal(input.report.machine)) throw new Error('Reconciliation report belongs to another machine.')
      if (!isLocal(barrier.machine)) throw new Error('Stopped-root observation belongs to another machine.')
      const observations = this.observeStoppedRoots(turn)
      const handles = observations.map(item => item.handle)
      const recorded = handles.map(digest).sort()
      const covered = input.report.handles_covered.map(digest).sort()
      if (digest(recorded) !== digest(covered)
        || digest(recorded) !== digest(barrier.local_handles.map(item => digest(item.handle)).sort())) {
        throw new Error('Operator report and stopped-root observation must cover the exact recorded process handle set.')
      }
      const reportedAt = Date.parse(input.report.observed_at)
      const activity = [turn.created_at, turn.claimed_at, turn.dispatch_started_at,
        ...handles.map(handle => handle.observed_at), ...turn.controls.map(control => control.at)]
        .filter(at => at !== null).map(at => Date.parse(at))
      if (activity.some(at => !Number.isFinite(at)) || !Number.isFinite(Date.parse(barrier.at))
        || reportedAt <= Date.parse(barrier.at) || reportedAt < Math.max(...activity) || reportedAt > Date.now()) {
        throw new Error('Operator report must follow the stopped-root observation and latest local activity, and cannot be in the future.')
      }
      // The durable observation precedes descendant inspection; neither substitutes for the other.
      turn.reconciliations.push({
        id: input.id, at: now(), request_digest: requestDigest, expected_revision: input.expected_revision,
        observation_id: barrier.id,
        decision: input.decision, operator_attestation: input.report, local_handles: observations,
        released: 'local_occupancy_only', remote_generation: 'unknown', remote_consumption: 'unknown',
      })
      turn.lifecycle = 'reconciled_by_attestation'
      turn.late = true
      discussion.revision++
      return turn
    })
  }
  synthesize(discussionId: string, revision: number, input: Omit<z.infer<typeof synthesisSchema>, 'at'>) {
    const synthesis = synthesisSchema.parse({ ...input, at: now() })
    assertNoCredentials(synthesis.text)
    return this.transaction(data => {
      const discussion = this.discussion(data, discussionId)
      const prior = discussion.syntheses.find(item => item.id === synthesis.id)
      if (prior) {
        if (digest({ ...prior, at: '' }) !== digest({ ...synthesis, at: '' })) throw new Error('Synthesis id conflict.')
        return prior
      }
      this.checkRevision(discussion, revision)
      this.todoSnapshot(discussion.todo_id)
      if (discussion.status !== 'open') throw new Error('Discussion is closed.')
      for (const source of synthesis.sources) {
        const turn = discussion.turns.find(item => item.id === source.turn_id)
        if (!turn || turn.output_digest !== source.digest || turn.outcome !== 'returned' || turn.late
          || turn.lifecycle !== 'settled' || turn.raw_purged || turn.integrity !== 'ok') {
          throw new Error('Synthesis requires complete, current advisory sources, not late or purged results.')
        }
        this.readResult(turn)
        const current = this.todoSnapshot(discussion.todo_id)
        if (digest(current) !== digest(turn.todo)) throw new Error('Todo plan or execution changed; advice is historical.')
      }
      discussion.syntheses.push(synthesis)
      discussion.revision++
      return synthesis
    })
  }
  decide(discussionId: string, revision: number, input: {
    id: string; decision: Decision; outcome: 'adopt' | 'reject' | 'defer' | 'associate' | 'close';
    synthesis_id?: string; todo_id?: string; note: string;
  }): Discussion {
    idSchema.parse(input.id)
    decisionSchema.parse(input.decision)
    assertNoCredentials(input.note)
    return this.transaction(data => {
      const discussion = this.discussion(data, discussionId)
      const event: Discussion['decisions'][number] = {
        id: input.id, at: now(), decision: input.decision, outcome: input.outcome,
        synthesis_id: input.synthesis_id ?? null,
        note: input.outcome === 'associate' ? `${input.todo_id}: ${input.note}` : input.note,
      }
      const prior = discussion.decisions.find(item => item.id === input.id)
      if (prior) {
        if (digest({ ...prior, at: '' }) !== digest({ ...event, at: '' })) throw new Error('Decision id conflict.')
        return discussion
      }
      this.checkRevision(discussion, revision)
      if (input.synthesis_id && !discussion.syntheses.some(item => item.id === input.synthesis_id)) throw new Error('Synthesis not found.')
      if (input.outcome === 'associate' || input.outcome === 'close') {
        if (discussion.turns.some(occupiesLocal)) throw new Error('Wait for original turns to settle or explicitly reconcile local occupancy first.')
        if (input.outcome === 'associate') {
          if (discussion.todo_id || !input.todo_id) throw new Error('Only an unlinked discussion can be explicitly associated.')
          this.todoSnapshot(input.todo_id)
          discussion.todo_id = input.todo_id
        }
        else discussion.status = 'closed'
      }
      discussion.decisions.push(event)
      discussion.revision++
      return discussion
    })
  }

  history(discussionId: string, runtime: Turn['binding']['runtime']): HistoryItem[] {
    const discussion = this.get(discussionId)
    const current = this.todoSnapshot(discussion.todo_id, false)
    const items: HistoryItem[] = discussion.decisions.filter(item => ['adopt', 'reject', 'defer'].includes(item.outcome))
      .map(item => ({
        source: `decision:${item.id}:${digest(item)}`,
        text: JSON.stringify(item), priority: 0,
      }))
    // Advisors do not automatically receive another advisor's raw response or synthesis.
    for (const turn of discussion.turns.filter(item => item.binding.runtime === runtime && !item.late
      && item.outcome === 'returned' && item.lifecycle === 'settled' && !item.raw_purged
      && digest(item.todo) === digest(current)).slice(-2).reverse()) {
      const result = this.readResult(turn)
      if (result?.text) items.push({ source: `advice:${turn.id}:${turn.output_digest}`, text: result.text, priority: 3 })
    }
    return items
  }
  purgePreview(discussionId: string) {
    const discussion = this.get(discussionId)
    const turns = discussion.turns.map(item => ({
      id: item.id, packet_digest: item.packet_digest, output_digest: item.output_digest,
      raw_purged: item.raw_purged,
      files: this.rawFiles(item.id).map(name => ({ name, digest: digest(readBounded(join(this.root(), name))) })),
    })).filter(item => !item.raw_purged || item.files.length > 0)
    return {
      discussion_id: discussion.id, revision: discussion.revision, turns,
      digest: digest({ discussion_id: discussion.id, revision: discussion.revision, turns }),
      notes: 'Deletes local packet, raw output and attributable interrupted-publication copies. Keeps manifest, decisions, synthesis, digests and audit metadata. Provider logs/backups are not erased.',
    }
  }
  purgeRaw(discussionId: string, confirmation: string, decision: Decision) {
    decisionSchema.parse(decision)
    return withTodoLock(this.directory, () => {
      const data = this.read()
      const discussion = this.discussion(data, discussionId)
      const previous = discussion.decisions.find(item => item.outcome === 'purge_raw' && item.note === confirmation)
      if (previous && digest(previous.decision) !== digest(decision)) throw new Error('Purge confirmation already records a different decision.')
      let manifest = previous?.purge_manifest
      if (!previous) {
        const preview = this.purgePreview(discussionId)
        if (preview.digest !== confirmation) throw new Error('Raw purge preview changed; confirm the exact current digest.')
        if (discussion.turns.some(occupiesLocal)) throw new Error('Cannot purge live or unresolved local consultation turns.')
        manifest = { turn_ids: preview.turns.map(turn => turn.id), files: preview.turns.flatMap(turn => turn.files) }
        for (const turn of discussion.turns.filter(turn => manifest!.turn_ids.includes(turn.id))) turn.raw_purged = true
        discussion.decisions.push({
          id: `purge-${confirmation.slice(0, 32)}`, at: now(), decision,
          outcome: 'purge_raw', synthesis_id: null, note: confirmation, purge_manifest: manifest,
        })
        discussion.revision++
        // The tombstone precedes deletion; a failed unlink can be retried, never repopulated.
        this.save(data)
      }
      if (!manifest) throw new Error('Purge confirmation has no stored manifest; request a new preview.')
      const approved = new Map(manifest.files.map(file => [file.name, file.digest]))
      const remaining = manifest.turn_ids.flatMap(id => this.rawFiles(id))
      // Missing files are a valid partial retry; newly appeared or edited files require fresh consent.
      for (const name of remaining) {
        if (approved.get(name) !== digest(readBounded(join(this.root(), name)))) {
          throw new Error('Raw files changed after purge confirmation; request and confirm a new preview.')
        }
      }
      for (const name of remaining) {
        const path = join(this.root(), name)
        if (approved.get(name) !== digest(readBounded(path))) throw new Error('Raw file changed during purge; confirm a new preview.')
        unlinkSync(path)
      }
      if (manifest.turn_ids.some(id => this.rawFiles(id).length)) throw new Error('New raw files appeared during purge; confirm a new preview.')
      return { discussion_id: discussionId, purged: true, notes: 'Audit metadata and decisions retained; no Todo state changed.' }
    })
  }
}
