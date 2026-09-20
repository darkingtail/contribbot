import { zodToJsonSchema } from 'zod-to-json-schema'
import type { AnyZodObject } from 'zod'
import { runRequestSchema, observeRequestSchema } from './checks.js'
import { closureRequestSchema } from './closure.js'
import { closureReconciliationRequestSchema } from './closure-reconciliation.js'
import { delegationRequestSchemas } from './delegation.js'
import { hostActions, hostRequestSchema, localIdentitySchema, workspaceRequestSchemas } from './local.js'
import { checkReconciliationRequestSchema } from './reconciliation.js'
import { reportInputSchema } from './reports.js'
import { cancelCloseRequestSchema, continueRequestSchema, pauseSettlementSchema } from './control.js'

// Only these top-level fields are supplied by the CLI transport, not request.json.
const transportFields = { directory: true, repo: true, data_root: true, action: true } as const
const actionSchemas = {
  context: localIdentitySchema,
  resume: localIdentitySchema,
  apply: hostRequestSchema,
  'settle-pause': pauseSettlementSchema,
  continue: continueRequestSchema,
  'cancel-close': cancelCloseRequestSchema,
  ...workspaceRequestSchemas,
  check: runRequestSchema,
  observe: observeRequestSchema,
  recover: runRequestSchema,
  reconcile: checkReconciliationRequestSchema,
  'reconcile-close': closureReconciliationRequestSchema,
  report: reportInputSchema,
  close: closureRequestSchema,
  ...delegationRequestSchemas,
} as const

type Action = keyof typeof actionSchemas
export const localActions = Object.keys(actionSchemas) as Action[]
const guidance: Record<Action, string> = {
  context: 'Read the task and workflow_revision. This does not inspect current files or activate an execution.',
  resume: 'Repair the derived Todo document from stored state and read recovery instructions; no command is replayed or workflow revision advanced.',
  'settle-pause': 'After stop intent, account for all original work and yield current files. Record safe pause without closing or archiving; unbound design work needs no fake workspace.',
  continue: 'Explicitly withdraw stop intent or resume a settled pause after accounting for original work and inspecting the original local workspace. Keep the execution, advance epoch, and require fresh yield/checks.',
  'cancel-close': 'Withdraw a reversible local closing reservation under the exact current control request and original owner. Does not cancel the Todo, roll back work, or change GitHub; prepared Issue closures and remote receipts remain protected.',
  apply: `Apply a public host transition: ${hostActions.join(', ')}. Propose an exact plan, obtain user confirmation, then confirm its returned digest.`,
  bind: 'Bind the initialized canonical repository to a local Git workspace after plan confirmation. Use an absolute workspace path.',
  relocate: 'Bind a new attempt after reconciling all old writers, using the original owner, current plan digest and explicit user decision.',
  yield: 'Record that the owner stopped writing and accounted for the listed operations, then capture current files. A note alone is not a check.',
  inspect: 'Capture current files and verify their candidate-bound evidence. Explicit remote targets trigger fresh read-only GitHub queries; reports and cached PR progress never satisfy them. Readiness is not product acceptance or permission.',
  check: 'Execute the command of acceptance_id from the confirmed plan; do not put a new command in this request. Unknown operations are not rerun.',
  observe: 'Read original process handles and observations without replaying work or releasing occupancy. A stopped parent does not prove descendants stopped.',
  recover: 'Reconcile the original durable command result using the original check identity and request. Never launch a replacement for an uncertain operation.',
  reconcile: 'Account for the original interrupted check and descendants, review current files and record an explicit user decision. This does not verify the task.',
  'reconcile-close': 'Account for original public requests and writers. During pause or cancellation, require the exact active control_id and decision; unknown effects remain pending. Reads Issue/comment facts without public writes. Withdraws only the old completion intent. Yield again, then settle-pause or close locally with matching stopped intent. Continue never redispatches the original Issue close; a new close requires a new explicit decision.',
  report: 'Import an actual manual/review observation with its original plan_id, attempt_id, epoch, candidate and observed_at. A passed label is not independent verification.',
  close: 'End without archiving; returns todo and archived:boolean. Explicit remote deliveries are queried again at preparation/finalization, outside storage locks. Stopped and already completed replays need no remote readback. Use target.kind=local; linked Issue closure uses the authorized public Issue tool. An explicit user decision and current evidence are required.',
  'delegate-prepare': 'Reserve an exact assignment in a separate linked worktree preserving existing material. This does not launch an agent; invoke the host once with the returned brief.',
  'delegate-attach': 'Attach the actual handle and raw result from that one host launch. A missing handle is not permission to launch again.',
  'delegate-observe': 'Record the original host task and descendant observations, including unresolved liveness. Host reports are not authenticated provider evidence.',
  'delegate-collect': 'After accounting for original writers, capture the real isolated candidate and scope violations. This does not integrate it.',
  'delegate-review': 'The owner reviews the exact returned result digest and target baseline. The owner then integrates only that reviewed delta.',
  'delegate-finish': 'Verify exact integration or rejection under the same reservation. Yield and check the main candidate afresh; child checks do not transfer.',
  'delegate-inspect': 'Read saved delegation records. This does not query the provider, capture current files, or launch an agent.',
}
const limitations = [
  'Structure only: JSON Schema cannot express all refinements, cross-field rules, workflow state, file freshness or authorization. Runtime validation remains authoritative.',
  'Use stable todo_id and execution_id returned by the tools, not display indexes. Context may omit execution_id to select the current/latest execution.',
  'Use the latest returned workflow.revision or context/resume workflow_revision for new requests; never guess increments. A retry must preserve the original request and operation identities and payload.',
  'Commands use a literal executable and argv with no implicit shell. On Windows, choose an explicit interpreter (for example Node plus pnpm.cjs); a .cmd file is not executed as a shell automatically.',
  'Actor names, decision text, status labels and schema validity do not establish user permission or successful delivery.',
]

export function assertLocalAction(action: string): asserts action is Action {
  if (!Object.hasOwn(actionSchemas, action)) throw new Error(`Unknown local action: ${action}.`)
}

export function describeLocalRequest(action: string) {
  assertLocalAction(action)
  const input: AnyZodObject = actionSchemas[action]
  const schema = input.omit(transportFields)
  return {
    ...zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none', effectStrategy: 'input' }),
    title: `contribbot-exec ${action} request.json`,
    'x-contribbot': {
      action, validation: 'structure-only' as const, guidance: guidance[action], limitations,
      transport: { repo: '--repo owner/repo', data_root: '--data-root absolute-path (optional)', request: '--request JSON-file or - for stdin' },
    },
  }
}

export function localHelp(action?: string): string {
  const usage = 'contribbot-exec <action> --repo owner/repo --request request.json [--data-root absolute-path]'
  const discovery = 'contribbot-exec <action> --help | --schema\nDiscovery does not read requests, initialize tasks, or require a repository.'
  if (action === undefined) return [usage, discovery, `Actions: ${localActions.join(', ')}`].join('\n\n')
  const schema = describeLocalRequest(action)
  return [usage.replace('<action>', action), discovery.replace('<action>', action),
    schema['x-contribbot'].guidance, ...limitations, 'Request structure:', JSON.stringify(schema, null, 2)].join('\n\n')
}
