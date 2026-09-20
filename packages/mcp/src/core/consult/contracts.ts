import { createHash } from 'node:crypto'
import { z } from 'zod'

export const digest = (value: unknown): string =>
  createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const purposeSchema = z.enum(['design', 'research', 'review', 'challenge'])
export const runtimeSchema = z.enum(['claude', 'codex'])
export const categorySchema = z.enum(['question', 'context', 'history', 'tracked', 'untracked', 'ignored', 'diff'])
export const MAX_PACKET_BYTES = 128 * 1024
export const MAX_OUTPUT_BYTES = 1024 * 1024
export const textSchema = z.string().trim().min(1).max(MAX_PACKET_BYTES)
export const decisionSchema = z.object({ source: textSchema, statement: textSchema }).strict()
export const scopeSchema = z.object({
  categories: z.array(categorySchema).min(1).max(7),
  paths: z.array(z.string().min(1).max(1024)).max(128),
}).strict()
export const runtimeInputSchema = z.object({
  runtime: runtimeSchema,
  executable: z.string().min(1).max(4096),
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/).optional(),
}).strict()
export const materialSchema = z.object({
  path: z.string().min(1).max(1024),
  category: z.enum(['tracked', 'untracked', 'ignored', 'diff']),
}).strict()
export const packetInputSchema = z.object({
  workspace: z.string().min(1).max(4096),
  question: textSchema,
  context: z.array(z.object({ text: textSchema, source: textSchema }).strict()).max(32).default([]),
  files: z.array(materialSchema).max(128).default([]),
}).strict()

export const manifestEntrySchema = z.object({
  category: categorySchema, path: z.string().nullable(), source: z.string(),
  sha256: digestSchema, bytes: z.number().int().nonnegative(),
  notes: z.array(z.string()),
}).strict()
export const packetSchema = z.object({
  workspace: z.string(), head: z.string().nullable(),
  manifest: z.array(manifestEntrySchema), body: z.string(),
  digest: digestSchema, omitted: z.array(z.string()),
}).strict()
export const bindingSchema = z.object({
  runtime: runtimeSchema, executable: z.string(), executable_digest: digestSchema,
  runtime_version: z.string(), binding_version: z.literal('1'),
  model: z.string().nullable(),
  protocol: z.literal('native-oneshot'), transport: z.literal('pipe'),
  execution_location: z.literal('local'), model_location: z.literal('unknown'),
  write_boundary: z.enum(['tool_free', 'sandbox_read_only']),
  read_boundary: z.enum(['tools_disabled', 'not_confined']),
  disclosure: z.string(), disclosure_digest: digestSchema,
}).strict()
export const todoSnapshotSchema = z.object({
  id: idSchema, lifecycle_revision: z.number().int().nonnegative(),
  execution_id: z.string().nullable(), plan_id: z.string().nullable(),
  plan_digest: digestSchema.nullable(),
}).strict()
export const grantSpecSchema = z.object({
  source: z.enum(['todo_grant', 'policy_acknowledged']),
  todo_id: idSchema.optional(),
  workspace: z.string(),
  runtimes: z.array(z.object({
    runtime: runtimeSchema, disclosure_digest: digestSchema,
  }).strict()).min(1).max(2),
  purposes: z.array(purposeSchema).min(1).max(4),
  scope: scopeSchema,
  max_turns: z.number().int().positive().max(100),
  policy: z.object({ path: z.string(), digest: digestSchema }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.source === 'todo_grant' && !value.todo_id) {
    context.addIssue({ code: 'custom', message: 'Todo grant requires an exact Todo id.' })
  }
  if ((value.source === 'policy_acknowledged') !== Boolean(value.policy)) {
    context.addIssue({ code: 'custom', message: 'Policy acknowledgement requires an exact policy path and digest.' })
  }
})
export const grantSchema = z.object({
  id: idSchema, spec: grantSpecSchema, digest: digestSchema,
  decision: decisionSchema, todo_generation: z.number().nullable(),
  events: z.array(z.object({
    kind: z.enum(['granted', 'reserved', 'consumed', 'revoked', 'expired', 'exhausted']),
    at: z.string(), turn_id: z.string().optional(), note: z.string(),
  }).strict()),
}).strict()
export const authorizationSchema = z.object({
  explicit_once: decisionSchema.optional(),
  grant_id: idSchema.optional(),
  denied: z.boolean().default(false),
  additional_advisor: decisionSchema.optional(),
}).strict()
export const processSchema = z.object({
  pid: z.number().int().positive().max(2 ** 31 - 1),
  machine: z.object({ hostname: z.string(), platform: z.string() }).strict(),
  started_at: z.number().nullable(), observed_at: z.string(),
}).strict()
export const reconciliationReportSchema = z.object({
  source: z.enum(['user', 'host_report']), actor: textSchema, locator: textSchema,
  machine: processSchema.shape.machine,
  observed_at: z.string().datetime({ offset: true }), method: textSchema, scope: textSchema,
  handles_covered: z.array(processSchema).max(2),
  all_descendants_stopped: z.literal(true), unresolved: z.array(textSchema).max(0),
}).strict()
export const reconcileInputSchema = z.object({
  id: idSchema, expected_revision: z.number().int().nonnegative(),
  observation_id: idSchema,
  decision: decisionSchema, accept_remote_uncertainty: z.literal(true),
  report: reconciliationReportSchema,
}).strict()
const stoppedHandleSchema = z.object({
  handle: processSchema,
  observation: z.object({
    state: z.enum(['stopped', 'replaced']), observed_at: z.string(), reason: z.string(),
  }).strict(),
}).strict()
export const releaseObservationSchema = z.object({
  id: idSchema, at: z.string(), revision: z.number().int().nonnegative(),
  machine: processSchema.shape.machine,
  local_handles: z.array(stoppedHandleSchema).min(1).max(2),
}).strict()
export const reconciliationSchema = z.object({
  id: idSchema, at: z.string(), request_digest: digestSchema,
  expected_revision: z.number().int().nonnegative(), decision: decisionSchema,
  observation_id: idSchema,
  operator_attestation: reconciliationReportSchema,
  local_handles: z.array(stoppedHandleSchema),
  released: z.literal('local_occupancy_only'),
  remote_generation: z.literal('unknown'), remote_consumption: z.literal('unknown'),
}).strict()
export const resultSchema = z.object({
  outcome: z.enum(['returned', 'failed', 'cancelled']),
  text: z.string().nullable(), stdout: z.string(), stderr: z.string(),
  exit_code: z.number().nullable(), signal: z.string().nullable(),
  integrity: z.enum(['ok', 'truncated']),
  reason: z.string().nullable(),
  unresolved: z.array(z.string()),
}).strict()
export const turnSchema = z.object({
  id: idSchema, request_id: idSchema, request_digest: digestSchema,
  start_digest: digestSchema.nullable(),
  question_digest: digestSchema, packet_digest: digestSchema,
  manifest: z.array(manifestEntrySchema), omitted: z.array(z.string()),
  binding: bindingSchema, todo: todoSnapshotSchema.nullable(),
  mode: z.enum(['fresh', 'rehydrate']),
  authorization: z.object({
    source: z.enum(['explicit_once', 'todo_grant', 'policy_acknowledged']),
    decision: decisionSchema, grant_id: idSchema.nullable(),
  }).strict(),
  created_at: z.string(), claimed_at: z.string().nullable(),
  dispatch_started_at: z.string().nullable(), scratch_directory: z.string().nullable(),
  sandbox_probe: z.object({ verified: z.boolean(), reason: z.string(), digest: digestSchema }).strict().nullable(),
  supervisor: processSchema.nullable(), advisor: processSchema.nullable(),
  lifecycle: z.enum(['reserved', 'running', 'settled', 'reconciling', 'reconciled_by_attestation']),
  outcome: z.enum(['returned', 'failed', 'cancelled']).nullable(),
  output_digest: digestSchema.nullable(), integrity: z.enum(['ok', 'truncated']),
  unresolved: z.array(z.string()),
  controls: z.array(z.object({
    action: z.enum(['stop_wait', 'terminate_advisor', 'abandon']),
    decision: decisionSchema, at: z.string(),
  }).strict()),
  late: z.boolean(), raw_purged: z.boolean(),
  reconciliations: z.array(reconciliationSchema).default([]),
  release_observations: z.array(releaseObservationSchema).default([]),
}).strict()
export const synthesisSchema = z.object({
  id: idSchema, at: z.string(), author: z.string(), text: textSchema,
  sources: z.array(z.object({ turn_id: idSchema, digest: digestSchema }).strict()).min(1),
}).strict()
export const discussionSchema = z.object({
  id: idSchema, kind: z.literal('consultation'), purpose: purposeSchema,
  todo_id: idSchema.nullable(), workspace: z.string(),
  revision: z.number().int().nonnegative(), created_at: z.string(),
  status: z.enum(['open', 'closed']),
  turns: z.array(turnSchema), syntheses: z.array(synthesisSchema),
  decisions: z.array(z.object({
    id: idSchema, at: z.string(), decision: decisionSchema,
    synthesis_id: idSchema.nullable(),
    outcome: z.enum(['adopt', 'reject', 'defer', 'associate', 'close', 'purge_raw']),
    note: z.string(),
    purge_manifest: z.object({
      turn_ids: z.array(idSchema),
      files: z.array(z.object({
        name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.(?:packet|result)\.json(?:\.[a-f0-9-]{36}\.pending)?$/),
        digest: digestSchema,
      }).strict()),
    }).strict().optional(),
  }).strict()),
}).strict()
export const databaseSchema = z.object({
  version: z.literal(1), discussions: z.array(discussionSchema), grants: z.array(grantSchema),
}).strict()

export type Packet = z.infer<typeof packetSchema>
export type PacketInput = z.input<typeof packetInputSchema>
export type Binding = z.infer<typeof bindingSchema>
export type RuntimeInput = z.infer<typeof runtimeInputSchema>
export type Decision = z.infer<typeof decisionSchema>
export type GrantSpec = z.infer<typeof grantSpecSchema>
export type Grant = z.infer<typeof grantSchema>
export type Authorization = z.input<typeof authorizationSchema>
export type TodoSnapshot = z.infer<typeof todoSnapshotSchema>
export type Turn = z.infer<typeof turnSchema>
export type Discussion = z.infer<typeof discussionSchema>
export type Database = z.infer<typeof databaseSchema>
export type TurnResult = z.infer<typeof resultSchema>
export type Scope = z.infer<typeof scopeSchema>
export type ReconcileInput = z.input<typeof reconcileInputSchema>

export const occupiesLocal = (turn: Turn): boolean =>
  turn.lifecycle !== 'settled' && turn.lifecycle !== 'reconciled_by_attestation'
