import type { TodoItem } from './todo-store.js'
import { repositoryDisplay } from '../utils/repository-ref.js'

export const WORKFLOW_START = '<!-- contribbot:workflow:start -->'
export const WORKFLOW_END = '<!-- contribbot:workflow:end -->'

export interface DocumentProjection {
  status: 'not_applicable' | 'current' | 'outdated' | 'blocked'
  path: string | null
  note: string
}

// Values are display data, never Markdown structure or managed-region delimiters.
function text(value: unknown): string {
  return String(value ?? '-').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;').replace(/`/g, '&#96;').replace(/\r\n|\r|\n/g, '<br>')
}

export function renderTodoWorkflow(todo: TodoItem): string {
  const lines = [
    WORKFLOW_START, '## Managed Task Record', '',
    'Stored observations only. This document does not verify current files or grant permission.',
    'YAML is authoritative; edits inside this region are replaced on synchronization.', '',
    `- Todo: ${text(todo.id)}`,
    `- Status: ${text(todo.status)}`,
    `- Pending transition: ${text(todo.pending_transition)}`,
  ]
  if (Number.isSafeInteger(todo.pr) && todo.pr! > 0) {
    lines.push(`- Legacy scalar PR: #${todo.pr} (repository not embedded; may mirror an explicit row, not an additional PR or acceptance result).`)
  }
  if (todo.pull_requests?.length) {
    lines.push('', '### Linked PRs', '', '| Repository | PR | Note |', '| --- | --- | --- |')
    for (const pull of todo.pull_requests) {
      lines.push(`| ${text(repositoryDisplay(pull.repo))} | #${pull.number} | Association only; not an acceptance result or required-delivery declaration |`)
    }
  }
  for (const execution of todo.executions) {
    lines.push('', `### Execution ${text(execution.id)}`, '',
      `- Goal: ${text(execution.goal)}`,
      `- Phase: ${text(execution.phase)}`,
      `- Next: ${text(execution.next)}`,
      `- Blocked on: ${text(execution.blocked_on)}`,
      `- Opened / closed: ${text(execution.opened_at)} / ${text(execution.closed_at)}`,
      `- Outcome: ${text(execution.outcome)}; ${text(execution.outcome_note)}`)
    const workflow = execution.workflow
    if (!workflow) {
      lines.push('- Legacy execution: no managed verification recorded.')
      continue
    }
    lines.push(`- Workflow revision / epoch: ${workflow.revision} / ${workflow.epoch}`,
      `- Current plan / attempt: ${text(workflow.plan_id)} / ${text(workflow.attempt_id)}`)
    if (workflow.control) {
      lines.push(`- Active control request: ${text(workflow.control.active_id)}`, '',
        '| Request | Kind | Decision | Revision | Note |', '| --- | --- | --- | --- | --- |')
      for (const request of workflow.control.requests) {
        lines.push(`| ${text(request.id)} | ${request.kind} | ${text(request.decision)} | ${request.at_revision} | ${text(request.note)} |`)
      }
      lines.push('', '| Request | Control event | Revision | Receipt | Note |', '| --- | --- | --- | --- | --- |')
      for (const event of workflow.control.events) {
        lines.push(`| ${text(event.control_id)} | ${event.kind} | ${event.at_revision} | ${text(event.verification)} | ${text(event.decision)}; ${text(event.at)} |`)
      }
    }
    for (const plan of workflow.plans) {
      lines.push('', `#### Plan ${text(plan.id)}`, '',
        `- Digest: ${plan.digest}`, `- Goal: ${text(plan.content.goal)}`,
        `- Completion scope: ${text(plan.content.completion_scope ?? 'legacy')}`,
        `- Remaining scope: ${text(plan.content.remaining_scope?.join('; '))}`,
        `- Non-goals: ${text(plan.content.non_goals.join('; '))}`,
        `- Scope: ${text(plan.content.scope.join(', '))}`,
        `- Risk: ${text(plan.content.risk)}`,
        `- Confirmation: ${text(plan.confirmation?.locator)}; observed ${text(plan.confirmation?.at)}`,
        '', '| Step | Scope | Dependencies | Acceptance | Note |', '| --- | --- | --- | --- | --- |')
      for (const step of plan.content.steps) {
        lines.push(`| ${text(step.id)} | ${text(step.scope.join(', '))} | ${text(step.depends_on.join(', '))} | ${text(step.acceptance_ids.join(', '))} | ${text(step.title)} |`)
      }
      lines.push('', '| Acceptance | Kind | Required / independent | Note |', '| --- | --- | --- | --- |')
      for (const criterion of plan.content.acceptance) {
        lines.push(`| ${text(criterion.id)} | ${criterion.kind} | ${criterion.required} / ${criterion.independent} | ${text(criterion.description)} |`)
      }
      for (const criterion of plan.content.acceptance) {
        if (criterion.command) lines.push('', `Command ${text(criterion.id)}: ${text(JSON.stringify(criterion.command))}`, '')
      }
      lines.push('', '##### Delivery requirements', '',
        'Declarations only; current files and acceptance have not been verified by this document.')
      if (plan.content.deliverables === undefined) lines.push('Delivery requirements not declared (legacy-compatible plan).')
      else if (plan.content.deliverables.length === 0) lines.push('No explicit delivery items declared.')
      else {
        lines.push('', '| Delivery | Target | Required | Acceptance | Note |', '| --- | --- | --- | --- | --- |')
        for (const delivery of plan.content.deliverables) {
          const target = delivery.target.kind === 'file' ? `file: ${delivery.target.path}`
            : delivery.target.kind === 'commit' ? `commit: ${delivery.target.scope.join(', ')}`
              : delivery.target.kind === 'remote_ref' ? `${repositoryDisplay(delivery.target.repo)} ${delivery.target.ref} (${delivery.target.scope.join(', ')})`
                : delivery.target.kind === 'remote_pull'
                  ? `${repositoryDisplay(delivery.target.repo)}#${delivery.target.number} ${delivery.target.endpoint} -> ${delivery.target.base} (${delivery.target.scope.join(', ')}; draft=${delivery.target.allow_draft})`
                  : 'workspace'
          lines.push(`| ${text(delivery.id)} | ${text(target)} | ${delivery.required} | ${text(delivery.acceptance_ids.join(', '))} | ${text(delivery.description)} |`)
        }
      }
    }
    lines.push('', '#### Operations', '', '| Operation | Plan / attempt / epoch | Actor | Status | Receipt | Note |',
      '| --- | --- | --- | --- | --- | --- |')
    for (const operation of workflow.operations) {
      lines.push(`| ${text(operation.id)} | ${text(operation.plan_id)} / ${text(operation.attempt_id)} / ${operation.epoch} | ${text(operation.actor)} | ${operation.status} | ${text(operation.receipt)} | ${text(operation.note || operation.purpose)} |`)
    }
    lines.push('', '#### Recorded Checks', '',
      '| Acceptance | Plan / attempt / epoch | Candidate | Outcome | Source / actor | Receipt | Note |',
      '| --- | --- | --- | --- | --- | --- | --- |')
    for (const check of workflow.checks) {
      lines.push(`| ${text(check.acceptance_id)} | ${text(check.plan_id)} / ${text(check.attempt_id)} / ${check.epoch} | ${check.candidate.digest} | ${check.outcome} | ${check.source} / ${text(check.actor)} | ${text(check.receipt)} | ${text(check.recorded_at)}; ${text(check.summary)} |`)
    }
    lines.push('', `- Yielded candidate: ${text(workflow.yield?.candidate.digest)}`,
      `- Pending closure: ${text(workflow.closing_id)}`)
    if (workflow.closure) {
      lines.push(`- Recorded closure: ${workflow.closure.mode}; ${text(workflow.closure.at)}`,
        `- Closure candidate: ${text(workflow.closure.candidate?.digest)}`,
        `- Decision: ${text(workflow.closure.decision)}`,
        `- Gaps: ${text(workflow.closure.gaps.join('; '))}`,
        `- Note: ${text(workflow.closure.note)}`)
    }
  }
  lines.push(WORKFLOW_END)
  return lines.join('\n')
}

export function replaceWorkflowRegion(content: string, rendered: string): string {
  const starts = content.split(WORKFLOW_START).length - 1
  const ends = content.split(WORKFLOW_END).length - 1
  if (!starts && !ends) return `${content}${content.endsWith('\n') ? '' : '\n'}\n${rendered}\n`
  const start = content.indexOf(WORKFLOW_START)
  const end = content.indexOf(WORKFLOW_END)
  const standalone = (offset: number, marker: string) =>
    (offset === 0 || content[offset - 1] === '\n')
    && (offset + marker.length === content.length || /^\r?\n/.test(content.slice(offset + marker.length)))
  if (starts !== 1 || ends !== 1 || end < start || !standalone(start, WORKFLOW_START) || !standalone(end, WORKFLOW_END)) {
    throw new Error('Ambiguous workflow document markers. Repair the delimiters without deleting user prose, then resume.')
  }
  return content.slice(0, start) + rendered + content.slice(end + WORKFLOW_END.length)
}
