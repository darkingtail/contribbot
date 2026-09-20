import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planDigest } from '../execution/workflow.js'
import type { WorkflowPlanInput } from '../execution/contracts.js'
import { captureCandidate } from '../execution/candidate.js'
import { localMachine } from '../execution/processes.js'
import { TodoStore } from './todo-store.js'

const plan: WorkflowPlanInput = {
  goal: 'Deliver behavior', completion_scope: 'task', remaining_scope: [], non_goals: [], scope: ['src'], risk: 'normal',
  steps: [{ id: 'step', title: 'Implement', scope: ['src'], depends_on: [], acceptance_ids: ['test'] }],
  acceptance: [{
    id: 'test', description: 'Check behavior', kind: 'command', independent: false, required: true,
    command: { executable: 'node', argv: ['test.js'], timeout_ms: 1000, max_output_bytes: 4096 },
  }],
}
const proposal = { request_id: 'propose', expected_revision: 0, command: { action: 'propose_plan' as const, plan_id: 'plan', plan } }

describe('Todo managed workflow persistence', () => {
  let directory: string
  let store: TodoStore
  let todoId: string
  let executionId: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'contribbot-workflow-store-'))
    store = new TodoStore(directory)
    todoId = store.add({ ref: 'feature', title: 'Feature', type: 'feature' }).id!
    executionId = store.activateExecution(0).execution.id
  })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
  const manage = () => store.applyWorkflow(todoId, executionId, proposal)

  it('persists the complete contract and resumes it through a fresh store instance', () => {
    const state = manage()
    expect(state.revision).toBe(1)
    const reread = new TodoStore(directory).resolveItemById(todoId)!.item.executions[0]!.workflow
    expect(reread).toEqual(state)
    expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toContain('workflow:')
    store.update(0, { pr: 12 })
    expect(new TodoStore(directory).get(0)!.executions[0]!.workflow).toEqual(state)
  })

  it('selects by stable identity and cannot update a replacement execution', () => {
    store.add({ ref: 'other', title: 'Other', type: 'feature' })
    store.delete(1)
    expect(manage().revision).toBe(1)
    expect(() => store.applyWorkflow(todoId, 'another-execution', proposal)).toThrow(/execution/i)
    expect(() => store.applyWorkflow('missing', executionId, proposal)).toThrow(/Todo.*found/i)
  })

  it('rejects competing stale updates and preserves unrelated Todo writes', () => {
    manage()
    const second = new TodoStore(directory)
    second.add({ ref: 'other', title: 'Other', type: 'feature' })
    expect(() => second.applyWorkflow(todoId, executionId, { ...proposal, request_id: 'stale' })).toThrow(/revision/i)
    const state = store.applyWorkflow(todoId, executionId, {
      request_id: 'confirm', expected_revision: 1,
      command: { action: 'confirm_plan', plan_id: 'plan', digest: planDigest(plan), confirmation: 'user-turn' },
    })
    expect(state.revision).toBe(2)
    expect(second.findByRef('other')).toBeDefined()
    expect(second.applyWorkflow(todoId, executionId, proposal)).toEqual(state)
  })

  it('refuses legacy closure and phase shortcuts for managed execution', () => {
    manage()
    expect(() => store.closeExecution(0, 'done')).toThrow(/managed/i)
    expect(() => store.archiveAndDelete(0)).toThrow(/open execution/i)
    expect(() => store.update(0, { status: 'done' })).toThrow(/managed/i)
    expect(() => store.cancelTodo(todoId, 0, 'fixture:cancel')).toThrow(/managed/i)
    expect(() => store.progressExecution(0, { phase: 'finish' })).toThrow(/managed/i)
    expect(() => store.delete(0, { force: true })).toThrow(/managed/i)
    expect(store.listArchived()).toEqual([])
    expect(store.get(0)!.executions[0]!.closed_at).toBeNull()
  })

  it('fails closed on unknown schema and tampered plan instead of dropping managed fields', () => {
    manage()
    const path = join(directory, 'todos.yaml')
    const data = parse(readFileSync(path, 'utf8'))
    data.todos[0].executions[0].workflow.version = 99
    writeFileSync(path, stringify(data))
    expect(() => store.list()).toThrow()
    data.todos[0].executions[0].workflow.version = 1
    data.todos[0].executions[0].workflow.plans[0].content.goal = 'Silently changed'
    writeFileSync(path, stringify(data))
    expect(() => store.list()).toThrow(/digest/i)
  })

  it('does not grant two Todos concurrent ownership of the same workspace', () => {
    const root = join(directory, 'workspace')
    mkdirSync(root)
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=nonexistent-hooks',
      '-c', 'commit.gpgSign=false', ...args], { cwd: root, windowsHide: true, stdio: 'pipe' })
    git('init', '--quiet')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'fixture')
    const snapshot = captureCandidate(root)
    const workspace = { repo: 'fixture/repo', root: snapshot.root, git_dir: snapshot.git_dir,
      common_dir: snapshot.common_dir, baseline: snapshot.digest, machine: localMachine() }
    const bind = (id: string, execution: string) => {
      store.applyWorkflow(id, execution, proposal)
      store.applyWorkflow(id, execution, {
        request_id: 'confirm', expected_revision: 1,
        command: { action: 'confirm_plan', plan_id: 'plan', digest: planDigest(plan), confirmation: 'user' },
      })
      return store.applyWorkflow(id, execution, {
        request_id: 'attempt', expected_revision: 2,
        command: { action: 'start_attempt', attempt_id: 'attempt', owner: 'primary', workspace },
      })
    }
    bind(todoId, executionId)
    const other = store.add({ ref: 'other', title: 'Other', type: 'feature' })
    const otherExecution = store.activateExecution(1).execution.id
    bind(other.id!, otherExecution)
    const begin = {
      request_id: 'write', expected_revision: 3,
      command: {
        action: 'begin_operation' as const, operation_id: 'writer', kind: 'write' as const, actor: 'primary',
        delegated: false, step_id: 'step', scope: ['src'], purpose: 'Implement',
      },
    }
    store.applyWorkflow(todoId, executionId, begin)
    expect(() => store.applyWorkflow(other.id!, otherExecution, begin)).toThrow(/workspace|occup/i)
    expect(store.get(1)!.executions[0]!.workflow?.revision).toBe(3)
  })
})
