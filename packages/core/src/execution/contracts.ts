import { z } from 'zod'
import type { ProcessHandle as PlatformProcessHandle } from 'contribbot-platform/types'
import { repositoryRefSchema } from '../repository/ref.js'

const text = z.string().trim().min(1).max(16_384)
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1)
const timestamp = z.string().datetime()
const branchName = z.string().min(1).max(1024).refine(value =>
  !/[\x00-\x20\x7f~^:?*[\]\\]/.test(value) && !value.includes('..') && !value.includes('@{')
  && value.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')),
'Expected a literal Git branch name.')

export const processHandleSchema = z.object({
  pid: z.number().int().positive().max(2 ** 31 - 1),
  machine: z.object({ hostname: text, platform: text }).strict(),
  started_at: z.number().int().nonnegative().nullable(),
  observed_at: timestamp,
}).strict()
// The schema is owned by Core because it validates persisted domain data;
// the platform owns the shared structural type, not persisted validation rules.
export type ProcessHandle = PlatformProcessHandle

// Scopes are literal workspace-relative paths, never globs or shell expressions.
export const scopePathSchema = z.string().min(1).max(4096).refine(value =>
  value === '.' || (!value.includes('\\') && !value.includes('\0') && !/[:*?[\]]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')),
'Scope must be a literal relative path without traversal.')

export const checkCommandSchema = z.object({
  executable: text,
  argv: z.array(z.string().max(16_384)).max(512),
  timeout_ms: z.number().int().min(1).max(3_600_000),
  max_output_bytes: z.number().int().min(1).max(16 * 1024 * 1024),
  dependency_inputs: z.array(scopePathSchema.refine(path => path !== '.', 'Dependency inputs must name files.'))
    .max(256).refine(paths => new Set(paths).size === paths.length, 'Dependency inputs must be unique.').optional(),
}).strict()

const criterionSchema = z.object({
  id,
  description: text.describe('The actual outcome to verify. For manual acceptance, specify what the user needs to inspect and judge.'),
  required: z.boolean(),
  kind: z.enum(['command', 'review', 'manual'])
    .describe('command captures a real command result; review records an actual review; manual requires explicit user feedback. Manual is not a mandatory final gate for every task.'),
  independent: z.boolean(),
  command: checkCommandSchema.optional(),
}).strict().superRefine((criterion, ctx) => {
  if ((criterion.kind === 'command') !== (criterion.command !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Only command acceptance requires an executable command.' })
  }
  if (criterion.independent && criterion.kind !== 'review') {
    ctx.addIssue({ code: 'custom', message: 'Independent acceptance must be a review.' })
  }
})

const deliverableSchema = z.object({
  id,
  description: text,
  required: z.boolean(),
  acceptance_ids: z.array(id).min(1).max(1000),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('workspace') }).strict(),
    z.object({
      kind: z.literal('file'),
      path: scopePathSchema.refine(path => path !== '.', 'File delivery must name a file.'),
    }).strict(),
    z.object({
      kind: z.literal('commit'),
      scope: z.array(scopePathSchema).min(1).max(1000),
    }).strict(),
    z.object({
      kind: z.literal('remote_ref'), repo: repositoryRefSchema,
      ref: branchName.refine(value => value.startsWith('refs/heads/'), 'Remote ref delivery requires refs/heads/<branch>.'),
      scope: z.array(scopePathSchema).min(1).max(1000),
    }).strict(),
    z.object({
      kind: z.literal('remote_pull'), repo: repositoryRefSchema, number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      base: branchName, endpoint: z.enum(['submitted', 'merged']), allow_draft: z.boolean(),
      scope: z.array(scopePathSchema).min(1).max(1000),
    }).strict(),
  ]).describe('Explicit local or GitHub delivery targets. Remote scope must match the committed candidate; reports and PR associations are not delivery evidence.'),
}).strict()

export const workflowPlanInputSchema = z.object({
  goal: text,
  // Optional for persisted plans created before stage/task coverage was introduced.
  completion_scope: z.enum(['task', 'stage']).optional()
    .describe('Required for new proposals: task covers the entire Todo; stage cannot complete the Todo. Omitted only in stored legacy plans.'),
  remaining_scope: z.array(text).max(100).optional()
    .describe('Required for new proposals: stage lists unfinished task goals; task supplies an empty array.'),
  non_goals: z.array(text).max(100),
  scope: z.array(scopePathSchema).min(1).max(1000),
  risk: z.enum(['normal', 'high']),
  steps: z.array(z.object({
    id, title: text, scope: z.array(scopePathSchema).min(1).max(1000),
    depends_on: z.array(id).max(1000),
    acceptance_ids: z.array(id).min(1).max(1000),
  }).strict()).min(1).max(1000),
  acceptance: z.array(criterionSchema).min(1).max(1000),
  deliverables: z.array(deliverableSchema).max(1000).optional()
    .describe('Explicit delivery requirements, included in the confirmed digest. Omission preserves legacy plans; PR links never imply a requirement.'),
}).strict()

export const candidateReferenceSchema = z.object({
  digest, root: text, git_dir: text, common_dir: text,
}).strict()

export const workspaceBindingSchema = z.object({
  repo: repositoryRefSchema,
  root: text, git_dir: text, common_dir: text, baseline: digest,
  machine: processHandleSchema.shape.machine.optional(),
}).strict()

const relocationSchema = z.object({ from_attempt: id, decision: text, plan_digest: digest, receipt: digest }).strict()
export const relocationRecordSchema = z.object({
  version: z.literal(1), todo_id: id, execution_id: id, plan_id: id,
  from_attempt: id, attempt_id: id, owner: text, decision: text, plan_digest: digest,
  from_workspace: workspaceBindingSchema, workspace: workspaceBindingSchema, manifest: digest,
  request: z.record(z.unknown()),
}).strict()

export const hostTaskHandleSchema = z.object({ provider: text, task_id: text }).strict()

const delegationSchema = z.object({
  token: id, workspace: workspaceBindingSchema, launch: digest,
  host: hostTaskHandleSchema.nullable(),
  attachment: digest.nullable(),
  observation: z.object({
    status: z.enum(['running', 'terminal', 'unknown']), quiescent: z.boolean(),
    receipt: digest, observed_at: timestamp.nullable().default(null),
  }).strict().nullable(),
  uncertain_at: timestamp.nullable().default(null),
  result: z.object({ candidate: candidateReferenceSchema, receipt: digest }).strict().nullable(),
  review: z.object({ target: candidateReferenceSchema, receipt: digest }).strict().nullable(),
  integration: z.object({ candidate: candidateReferenceSchema, receipt: digest }).strict().nullable(),
}).strict()

const planSchema = z.object({
  id, digest, content: workflowPlanInputSchema,
  confirmation: z.object({ locator: text, at: timestamp }).strict().nullable(),
}).strict()

export const operationSchema = z.object({
  id, plan_id: id, attempt_id: id, epoch: revision,
  kind: z.enum(['write', 'read', 'check']),
  actor: text, delegated: z.boolean(),
  step_id: id.nullable(), acceptance_id: id.nullable(),
  scope: z.array(scopePathSchema), purpose: text,
  status: z.enum(['running', 'unknown', 'returned', 'accepted', 'rejected', 'completed', 'reconciled']),
  started_at: timestamp, ended_at: timestamp.nullable(),
  receipt: text.nullable(), note: z.string().max(16_384),
  decision_actor: text.nullable(),
  candidate: candidateReferenceSchema.nullable(),
  runner: processHandleSchema.nullable().default(null),
  supervisor: processHandleSchema.nullable().default(null),
  dispatch: z.enum(['pending', 'claimed']).nullable().default(null),
  delegation: delegationSchema.nullable().default(null),
  uncertain_at: timestamp.nullable().default(null),
  reconciliation: z.object({
    receipt: digest, actor: text, decision: text, candidate: candidateReferenceSchema,
  }).strict().nullable().default(null),
}).strict()

const checkSchema = z.object({
  operation_id: id, plan_id: id, attempt_id: id, epoch: revision,
  acceptance_id: id, candidate: candidateReferenceSchema,
  after: candidateReferenceSchema.nullable(), actor: text,
  outcome: z.enum(['passed', 'failed', 'blocked', 'stale']),
  source: z.enum(['local_runner', 'host_report', 'user']),
  receipt: text, summary: text, recorded_at: timestamp,
}).strict()

export const closureIntentSchema = z.object({
  id, mode: z.enum(['verified', 'with_gaps', 'stopped']),
  decision: text, note: text, acknowledged_gaps: z.array(text).max(2000),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local') }).strict(),
    z.object({
      kind: z.literal('issue'), repo: repositoryRefSchema, issue_number: z.number().int().positive(), comment_digest: digest.optional(),
    }).strict(),
  ]),
}).strict()

export const closingSchema = z.object({
  intent: closureIntentSchema,
  plan_id: id.nullable(), attempt_id: id.nullable(), epoch: revision,
  candidate: candidateReferenceSchema.nullable(),
  state: z.enum(['reserved', 'prepared', 'cancelled', 'completed', 'reconciled']),
  gaps: z.array(text), verification: digest.nullable(),
  remote_receipt: text.nullable(),
  issue_dispatch: z.literal('journal-v1').optional(),
  reconciliation: z.object({
    receipt: digest, actor: text, decision: text, candidate: candidateReferenceSchema,
    control_id: id.optional(),
  }).strict().nullable().default(null),
  at: timestamp, note: z.string(),
}).strict()

const closureSchema = z.object({
  id, mode: z.enum(['verified', 'with_gaps', 'stopped']),
  candidate: candidateReferenceSchema.nullable(),
  gaps: z.array(text), verification: digest,
  decision: text, note: text, at: timestamp,
}).strict()

export const controlRequestCommandSchema = z.object({
  action: z.literal('request_control'), control_id: id, kind: z.enum(['pause', 'cancel']),
  decision: text, note: text,
}).strict()

const controlSchema = z.object({
  active_id: id.nullable(),
  requests: z.array(z.object({
    id, kind: z.enum(['pause', 'cancel']), decision: text, note: text,
    at_revision: revision, at: timestamp,
  }).strict()),
  events: z.array(z.object({
    control_id: id, kind: z.enum(['paused', 'resumed', 'cancelled', 'superseded']),
    at_revision: revision, at: timestamp, actor: text, decision: text,
    candidate: candidateReferenceSchema.nullable(), verification: digest.nullable(),
  }).strict()),
}).strict()

export const workflowSchema = z.object({
  version: z.literal(1),
  revision, epoch: revision,
  plans: z.array(planSchema),
  plan_id: id.nullable(),
  attempts: z.array(z.object({
    id, plan_id: id, owner: text, workspace: workspaceBindingSchema, started_at: timestamp,
    relocation: relocationSchema.optional(),
  }).strict()),
  attempt_id: id.nullable(),
  operations: z.array(operationSchema),
  checks: z.array(checkSchema),
  yield: z.object({
    plan_id: id, attempt_id: id, epoch: revision, actor: text,
    candidate: candidateReferenceSchema,
    observed_operations: z.array(id), note: text, at: timestamp,
  }).strict().nullable(),
  requests: z.array(z.object({ id, digest, revision }).strict()),
  closings: z.array(closingSchema),
  closing_id: id.nullable(),
  closure: closureSchema.nullable(),
  control: controlSchema.optional(),
}).strict()

export const workflowCommandSchema = z.discriminatedUnion('action', [
  controlRequestCommandSchema,
  z.object({
    action: z.literal('settle_pause'), control_id: id, actor: text,
    candidate: candidateReferenceSchema.nullable(), verification: digest,
  }).strict(),
  z.object({
    action: z.literal('resume_control'), control_id: id, actor: text, decision: text,
    candidate: candidateReferenceSchema.nullable(), verification: digest,
  }).strict(),
  z.object({ action: z.literal('propose_plan'), plan_id: id, plan: workflowPlanInputSchema }).strict(),
  z.object({ action: z.literal('confirm_plan'), plan_id: id, digest, confirmation: text }).strict(),
  z.object({
    action: z.literal('start_attempt'), attempt_id: id, owner: text, workspace: workspaceBindingSchema,
  }).strict(),
  z.object({
    action: z.literal('relocate_attempt'), attempt_id: id, owner: text, workspace: workspaceBindingSchema,
    relocation: relocationSchema,
  }).strict(),
  z.object({
    action: z.literal('begin_operation'), operation_id: id, kind: z.enum(['write', 'read']),
    actor: text, delegated: z.boolean(), step_id: id, scope: z.array(scopePathSchema).min(1),
    purpose: text,
  }).strict(),
  z.object({
    action: z.literal('begin_delegation'), operation_id: id, actor: text, step_id: id,
    scope: z.array(scopePathSchema).min(1), purpose: text,
    token: id, workspace: workspaceBindingSchema, launch: digest,
  }).strict(),
  z.object({
    action: z.literal('attach_delegation'), operation_id: id, actor: text,
    handle: hostTaskHandleSchema, receipt: digest,
  }).strict(),
  z.object({
    action: z.literal('observe_delegation'), operation_id: id, actor: text,
    handle: hostTaskHandleSchema, status: z.enum(['running', 'terminal', 'unknown']),
    quiescent: z.boolean(), receipt: digest, observed_at: timestamp,
  }).strict(),
  z.object({
    action: z.literal('return_delegation'), operation_id: id, actor: text,
    candidate: candidateReferenceSchema, receipt: digest,
  }).strict(),
  z.object({
    action: z.literal('review_delegation'), operation_id: id, actor: text,
    result: digest, target: candidateReferenceSchema, receipt: digest,
  }).strict(),
  z.object({
    action: z.literal('finish_delegation'), operation_id: id, actor: text,
    decision: z.enum(['accepted', 'rejected']), candidate: candidateReferenceSchema, receipt: digest,
  }).strict(),
  z.object({
    action: z.literal('mark_unknown'), operation_id: id, reason: text,
  }).strict(),
  z.object({
    action: z.literal('return_operation'), operation_id: id, receipt: text, note: text,
    process_stopped: z.literal(true),
  }).strict(),
  z.object({
    action: z.literal('adopt_operation'), operation_id: id, actor: text,
    decision: z.enum(['accepted', 'rejected']), note: text,
  }).strict(),
  z.object({
    action: z.literal('yield'), actor: text, candidate: candidateReferenceSchema,
    observed_operations: z.array(id), note: text,
  }).strict(),
  z.object({
    action: z.literal('begin_check'), operation_id: id, acceptance_id: id,
    actor: text, candidate: candidateReferenceSchema,
    runner: processHandleSchema.optional(),
    dispatch: z.literal('pending').optional(),
  }).strict(),
  z.object({
    action: z.literal('claim_supervisor'), operation_id: id, supervisor: processHandleSchema,
  }).strict(),
  z.object({
    action: z.literal('complete_check'), operation_id: id, after: candidateReferenceSchema.nullable(),
    outcome: z.enum(['passed', 'failed', 'blocked']),
    source: z.enum(['local_runner', 'host_report', 'user']),
    receipt: text, summary: text, process_stopped: z.boolean(),
  }).strict(),
  z.object({
    action: z.literal('reconcile_check'), operation_id: id, actor: text, decision: text,
    receipt: digest, candidate: candidateReferenceSchema,
  }).strict(),
  z.object({ action: z.literal('reserve_closure'), intent: closureIntentSchema }).strict(),
  z.object({
    action: z.literal('prepare_closure'), closure_id: id, candidate: candidateReferenceSchema.nullable(),
    verification: digest, gaps: z.array(text),
  }).strict(),
  z.object({
    action: z.literal('cancel_closure'), closure_id: id, note: text,
    control_id: id.optional(), actor: text.optional(),
  }).strict(),
  z.object({
    action: z.literal('reconcile_closure'), closure_id: id, actor: text, decision: text,
    candidate: candidateReferenceSchema, receipt: digest, remote_receipt: digest.nullable(),
    control_id: id.optional(),
  }).strict(),
  z.object({ action: z.literal('closure_remote_receipt'), closure_id: id, receipt: text }).strict(),
  z.object({
    action: z.literal('finish_closure'), closure_id: id, candidate: candidateReferenceSchema.nullable(),
    verification: digest, gaps: z.array(text),
  }).strict(),
])

export const workflowRequestSchema = z.object({
  request_id: id, expected_revision: revision, command: workflowCommandSchema,
}).strict()

export type WorkflowCommand = z.infer<typeof workflowCommandSchema>
export type WorkflowRequest = z.infer<typeof workflowRequestSchema>
export type WorkflowPlanInput = z.infer<typeof workflowPlanInputSchema>
export type WorkflowState = z.infer<typeof workflowSchema>
export type WorkspaceBinding = z.infer<typeof workspaceBindingSchema>
export type CandidateReference = z.infer<typeof candidateReferenceSchema>
export type WorkflowOperation = WorkflowState['operations'][number]
export type ClosureIntent = z.infer<typeof closureIntentSchema>
