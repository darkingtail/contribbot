import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readTodoModel } from 'contribbot-core'
import type { TodoReadModel } from 'contribbot-core'
import { TodoStore, currentTodoExecution } from '../storage/todo-store.js'
import { activeControl, createWorkflow, planDigest, transitionWorkflow } from '../execution/workflow.js'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'contribbot-todo-read-parity-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const at = '2026-09-23T00:00:00.000Z'
const plan = {
  goal: 'Preserve Todo reads', completion_scope: 'task', remaining_scope: [],
  non_goals: [], scope: ['.'], risk: 'normal',
  steps: [{ id: 'step', title: 'Read', scope: ['.'], depends_on: [], acceptance_ids: ['review'] }],
  acceptance: [{ id: 'review', description: 'Read parity', required: true, kind: 'review', independent: false }],
}

function todo() {
  let workflow = transitionWorkflow(createWorkflow(), {
    request_id: 'propose', expected_revision: 0,
    command: { action: 'propose_plan', plan_id: 'plan', plan },
  }, at)
  workflow = transitionWorkflow(workflow, {
    request_id: 'confirm', expected_revision: workflow.revision,
    command: { action: 'confirm_plan', plan_id: 'plan', digest: planDigest(plan), confirmation: 'user' },
  }, at)
  return {
    id: 't-parity', ref: null, title: 'Parity', type: 'chore', status: 'active',
    difficulty: null, pr: null, branch: null, created: '2026-09-23', updated: '2026-09-23',
    executions: [{
      id: 'execution', goal: 'Parity', phase: 'understand', next: 'Continue',
      blocked_on: null, evidence: [], opened_at: at, closed_at: null, outcome: null, outcome_note: '',
      workflow,
    }],
  }
}

// This is the pre-split Consult projection, over the original TodoStore reader.
function originalRead(id: string): TodoReadModel | null {
  const item = new TodoStore(directory).resolveItemFromAll(id)
  if (!item || item.id !== id) return null
  const execution = currentTodoExecution(item)
  const workflow = execution?.workflow
  const confirmed = workflow?.plans.find(entry => entry.id === workflow.plan_id)
  return {
    id: item.id, status: item.status, lifecycleRevision: item.lifecycle_revision ?? 0,
    pendingTransition: item.pending_transition !== undefined,
    execution: execution ? {
      id: execution.id, hasActiveControl: Boolean(workflow && activeControl(workflow)),
      confirmedPlan: confirmed?.confirmation ? { id: confirmed.id, digest: confirmed.digest } : null,
    } : null,
  }
}

function capture(read: () => unknown) {
  try { return { value: read() } }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}

function expectParity(id = 't-parity') {
  const before = readFileSync(join(directory, 'todos.yaml'))
  const expected = capture(() => originalRead(id))
  expect(capture(() => readTodoModel(directory, id))).toEqual(expected)
  expect(readFileSync(join(directory, 'todos.yaml'))).toEqual(before)
  return expected
}

it.each(['', 'null\n', '{}\n', 'todos: []\n'])('preserves empty Todo document behavior: %j', content => {
  writeFileSync(join(directory, 'todos.yaml'), content)
  expect(expectParity()).toEqual({ value: null })
})

it('preserves confirmed plan projection and permissive record fields', () => {
  const item = { ...todo(), extra: { preserved: true } }
  item.executions[0]!.opened_at = '2026-09-23'
  writeFileSync(join(directory, 'todos.yaml'), stringify({ todos: [item] }))
  expectParity()
  expect(new TodoStore(directory).list()[0]).toMatchObject({ extra: { preserved: true } })
  expect(planDigest(plan)).toBe('510655da428fd3afa4f0016c22e0e1ae852c2f799b6ab3bba61c9f54241b4a39')
})

it.each([
  ['duplicate todo', (item: ReturnType<typeof todo>) => [item, item]],
  ['duplicate execution', (item: ReturnType<typeof todo>) => [item, { ...item, id: 't-other' }]],
  ['multiple open executions', (item: ReturnType<typeof todo>) => [{
    ...item, executions: [...item.executions, { ...item.executions[0], id: 'other-execution' }],
  }]],
  ['invalid timestamp', (item: ReturnType<typeof todo>) => [{
    ...item, executions: [{ ...item.executions[0], opened_at: 'not-a-date' }],
  }]],
  ['unsafe revision', (item: ReturnType<typeof todo>) => [{ ...item, lifecycle_revision: Number.MAX_SAFE_INTEGER + 1 }]],
  ['invalid plan digest', (item: ReturnType<typeof todo>) => {
    item.executions[0]!.workflow.plans[0]!.digest = 'a'.repeat(64)
    return [item]
  }],
  ['invalid control history', (item: ReturnType<typeof todo>) => {
    item.executions[0]!.workflow.control = { active_id: 'missing', requests: [], events: [] }
    return [item]
  }],
] as const)('rejects %s with the original error', (_label, mutate) => {
  writeFileSync(join(directory, 'todos.yaml'), stringify({ todos: mutate(todo()) }))
  expect(expectParity()).toHaveProperty('error')
})

it('uses legacy archive only when the canonical archive is absent', () => {
  writeFileSync(join(directory, 'todos.yaml'), 'todos: []\n')
  writeFileSync(join(directory, 'archive.yaml'), stringify({ todos: [{ ...todo(), status: 'done', executions: [] }] }))
  expect(expectParity()).toHaveProperty('value.status', 'done')
  writeFileSync(join(directory, 'todos.archive.yaml'), 'todos: []\n')
  expect(expectParity()).toEqual({ value: null })
})
