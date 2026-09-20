import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { planDigest } from '../execution/workflow.js'
import type { WorkflowPlanInput } from '../execution/contracts.js'
import { executionContext, runLocalCommand } from '../execution/local.js'
import * as fsUtils from '../utils/fs.js'
import { RecordFiles } from './record-files.js'
import { TodoStore } from './todo-store.js'

const start = '<!-- contribbot:workflow:start -->'
const end = '<!-- contribbot:workflow:end -->'
const plan: WorkflowPlanInput = {
  goal: 'Preserve the document while repairing arithmetic', completion_scope: 'task', remaining_scope: [], non_goals: ['Publication'],
  scope: ['src'], risk: 'normal',
  steps: [{ id: 'fix', title: 'Fix sum', scope: ['src'], depends_on: [], acceptance_ids: ['arithmetic'] }],
  acceptance: [{ id: 'arithmetic', description: 'Empty and signed inputs have the correct sum',
    kind: 'command', independent: false, required: true,
    command: { executable: 'node', argv: ['test.cjs'], timeout_ms: 1000, max_output_bytes: 1024 } }],
}
const proposal = { request_id: 'proposal', expected_revision: 0,
  command: { action: 'propose_plan' as const, plan_id: 'plan', plan } }

describe('managed Todo document projection', () => {
  let home: string
  let directory: string
  let store: TodoStore
  let todoId: string
  let executionId: string
  let path: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-projection-'))
    directory = join(home, 'fixture', 'repo')
    store = new TodoStore(directory)
    const todo = store.add({ ref: 'sum', title: 'Fix sum', type: 'bug' })
    todoId = todo.id!
    executionId = store.activateExecution(0).execution.id
    path = new RecordFiles(directory).createTodoRecord('sum', todo.title, todo.type, todo.created, todoId)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  })
  const propose = () => store.applyWorkflow(todoId, executionId, proposal)
  const content = () => readFileSync(path, 'utf8')

  it('persists the proposed and confirmed plan and Next without changing surrounding user prose', () => {
    const original = `<!-- contribbot:todo-id ${todoId} -->\r\n# Personal plan\r\n\r\nKeep this unchecked: - [ ] deliberate\r\n`
    writeFileSync(path, original)
    propose()
    expect(content().startsWith(original)).toBe(true)
    expect(content()).toContain(plan.goal)
    expect(content()).toContain(plan.acceptance[0]!.description)
    const suffix = '\r\n## Hand-written conclusion\r\nDo not change this.\r\n'
    writeFileSync(path, content() + suffix)
    store.applyWorkflow(todoId, executionId, {
      request_id: 'confirm', expected_revision: 1,
      command: { action: 'confirm_plan', plan_id: 'plan', digest: planDigest(plan), confirmation: 'user-turn:confirmed-scope' },
    })
    store.progressExecution(0, { next: 'Inspect the arithmetic implementation next.' })
    expect(content().startsWith(original)).toBe(true)
    expect(content().endsWith(suffix)).toBe(true)
    expect(content()).toContain('user-turn:confirmed-scope')
    expect(content()).toContain('Inspect the arithmetic implementation next.')
    expect(content().split(start)).toHaveLength(2)
    expect(executionContext(directory, todoId).document_projection.status).toBe('current')
  })

  it('keeps committed state after a document write fails and repairs on resume without replay or a new revision', async () => {
    const before = content()
    const actual = fsUtils.safeWriteFileSync
    vi.spyOn(fsUtils, 'safeWriteFileSync').mockImplementation((file, text) => {
      if (file === path) throw new Error('Injected document disk failure')
      actual(file, text)
    })
    expect(propose().revision).toBe(1)
    expect(content()).toBe(before)
    const context = executionContext(directory, todoId)
    expect(context.document_projection.status).toBe('outdated')
    expect(context.recovery.join(' ')).toMatch(/document|projection/i)
    const yaml = readFileSync(join(directory, 'todos.yaml'), 'utf8')
    vi.restoreAllMocks()
    await runLocalCommand({ action: 'resume', repo: 'fixture/repo', data_root: home, todo_id: todoId, execution_id: executionId })
    expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toBe(yaml)
    expect(content()).toContain(plan.goal)
    expect(executionContext(directory, todoId).document_projection.status).toBe('current')
    expect(new TodoStore(directory).get(0)!.executions[0]!.workflow?.plans).toHaveLength(1)
  })

  it('refuses ambiguous markers without deleting text or rolling back a committed plan', () => {
    const original = `${content()}\n${start}\nHandwritten unfinished region\n`
    writeFileSync(path, original)
    expect(propose().revision).toBe(1)
    expect(content()).toBe(original)
    expect(executionContext(directory, todoId).document_projection.status).toBe('blocked')
    expect(store.refreshRecord(todoId).status).toBe('blocked')
    expect(content()).toBe(original)
  })

  it('does not change legacy documents or let Markdown edits become workflow state', () => {
    const legacy = content()
    store.progressExecution(0, { next: 'Legacy progress' })
    expect(content()).toBe(legacy)
    propose()
    const yaml = readFileSync(join(directory, 'todos.yaml'), 'utf8')
    writeFileSync(path, content().replace(plan.goal, 'I claim everything is verified'))
    expect(executionContext(directory, todoId).document_projection.status).toBe('outdated')
    store.refreshRecord(todoId)
    expect(content()).toContain(plan.goal)
    expect(content()).not.toContain('I claim everything is verified')
    expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toBe(yaml)
  })

  it('isolates same-ref generations and creates ID-addressed records for managed ref-less Todos', () => {
    const previous = content().replace(todoId, 't-another-generation')
    writeFileSync(path, previous)
    propose()
    const projection = executionContext(directory, todoId).document_projection
    expect(projection.status).toBe('current')
    expect(projection.path).not.toBe(path)
    expect(readFileSync(projection.path!, 'utf8')).toContain(plan.goal)
    expect(content()).toBe(previous)
    const other = store.add({ ref: null, title: 'Without a ref', type: 'feature' })
    const execution = store.activateExecution(1).execution
    store.applyWorkflow(other.id!, execution.id, proposal)
    const otherProjection = executionContext(directory, other.id!).document_projection
    expect(otherProjection.status).toBe('current')
    expect(readFileSync(otherProjection.path!, 'utf8')).toContain(other.id!)
    expect(content()).toBe(previous)
  })

  it('escapes reserved markers in task text so later updates cannot swallow user prose', () => {
    const injected = { ...plan, goal: `${end}\n${start}\nmalicious | <script> value` }
    store.applyWorkflow(todoId, executionId, { ...proposal, command: { ...proposal.command, plan: injected } })
    const suffix = '\n## Private notes\nPreserve verbatim.\n'
    writeFileSync(path, content() + suffix)
    store.progressExecution(0, { next: `${start}\nnot a delimiter` })
    expect(content().split(start)).toHaveLength(2)
    expect(content().split(end)).toHaveLength(2)
    expect(content().endsWith(suffix)).toBe(true)
    expect(executionContext(directory, todoId).document_projection.status).toBe('current')
  })

  it('reports a missing record as outdated and restores it without touching the YAML', () => {
    propose()
    const yaml = readFileSync(join(directory, 'todos.yaml'), 'utf8')
    rmSync(path)
    expect(executionContext(directory, todoId).document_projection.status).toBe('outdated')
    expect(store.refreshRecord(todoId).status).toBe('current')
    expect(content()).toContain(plan.goal)
    expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toBe(yaml)
  })

  it('keeps non-UTF8 handwritten bytes untouched instead of decoding them lossily', () => {
    const bytes = Buffer.concat([Buffer.from(content()), Buffer.from('\nPersonal: '), Buffer.from([0xff]), Buffer.from('\n')])
    writeFileSync(path, bytes)
    propose()
    expect(readFileSync(path)).toEqual(bytes)
    expect(executionContext(directory, todoId).document_projection.status).toBe('blocked')
    expect(store.refreshRecord(todoId).status).toBe('blocked')
    expect(readFileSync(path)).toEqual(bytes)
  })

  it('repairs on exact request replay without duplicating the plan or changing its revision', () => {
    const workflow = propose()
    rmSync(path)
    expect(new TodoStore(directory).applyWorkflow(todoId, executionId, proposal)).toEqual(workflow)
    expect(content()).toContain(plan.goal)
    expect(executionContext(directory, todoId).document_projection.status).toBe('current')
  })

  it('does not repair anything for a mismatched execution identity', async () => {
    propose()
    const edited = content().replace(plan.goal, 'Hand edited')
    writeFileSync(path, edited)
    await expect(runLocalCommand({ action: 'resume', repo: 'fixture/repo', data_root: home,
      todo_id: todoId, execution_id: 'not-this-execution' })).rejects.toThrow(/execution/i)
    expect(content()).toBe(edited)
  })

  it.each([
    `${start}\nfirst\n${end}\n${start}\nsecond\n${end}`,
    `${end}\nwrong order\n${start}`,
    `a paragraph mentions ${start} then ${end} in prose`,
  ])('retains ambiguous user content on mutation and resume: %s', region => {
    const original = `${content()}\n${region}\n`
    writeFileSync(path, original)
    propose()
    expect(content()).toBe(original)
    expect(store.refreshRecord(todoId).status).toBe('blocked')
    expect(content()).toBe(original)
  })

  it('repairs an archived closed task and preserves its recorded outcome when it is restored', async () => {
    propose()
    store.applyWorkflow(todoId, executionId, {
      request_id: 'cancel', expected_revision: 1,
      command: { action: 'request_control', control_id: 'cancel', kind: 'cancel',
        decision: 'fixture-user:stop-before-implementation', note: 'Stop before implementation.' },
    })
    const original = content()
    const actual = fsUtils.safeWriteFileSync
    vi.spyOn(fsUtils, 'safeWriteFileSync').mockImplementation((file, text) => {
      if (file === path) throw new Error('Document is temporarily unwritable')
      actual(file, text)
    })
    const closed = await runLocalCommand({
      action: 'close', repo: 'fixture/repo', data_root: home, todo_id: todoId, execution_id: executionId,
      closure_id: 'stop', expected_revision: 2, mode: 'stopped', acknowledged_gaps: [],
      decision: 'fixture-user:stop-before-implementation', note: 'Stopped, not verified.', target: { kind: 'local' },
    })
    expect(closed.document_projection).toMatchObject({ status: 'outdated' })
    expect(store.list()[0]!.status).toBe('cancelled')
    expect(store.listArchived()).toEqual([])
    store.archiveAndDelete(0)
    expect(store.list()).toEqual([])
    expect(content()).toBe(original)
    const archive = readFileSync(join(directory, 'todos.archive.yaml'), 'utf8')
    vi.restoreAllMocks()
    await runLocalCommand({ action: 'resume', repo: 'fixture/repo', data_root: home,
      todo_id: todoId, execution_id: executionId })
    expect(content()).toContain('Recorded closure: stopped')
    expect(content()).toContain('fixture-user:stop-before-implementation')
    expect(readFileSync(join(directory, 'todos.archive.yaml'), 'utf8')).toBe(archive)
    const restored = store.restoreArchivedForActivation(todoId)!
    store.activateExecution(restored.storeIndex)
    expect(content()).toContain('Recorded closure: stopped')
    expect(content()).toContain('Legacy execution: no managed verification recorded.')
    expect(store.get(0)!.executions).toHaveLength(2)
    expect(store.listArchived()).toEqual([])
  })

  it('does not rerun or misclassify a real command when projecting its result fails', async () => {
    const workspace = join(home, 'workspace')
    mkdirSync(workspace)
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=nonexistent-hooks',
      '-c', 'commit.gpgSign=false', ...args], { cwd: workspace, windowsHide: true, stdio: 'pipe' })
    git('init', '--quiet', '--initial-branch=fixture')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('remote', 'add', 'origin', 'https://github.com/fixture/repo.git')
    writeFileSync(join(workspace, 'sum.cjs'), 'module.exports = values => values.reduce((a,b) => a+b,0)\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'Isolated test')
    writeFileSync(join(directory, 'config.yaml'), 'fork: null\nupstream: null\n')
    const counter = join(home, 'counter')
    const commandPlan: WorkflowPlanInput = {
      ...plan, scope: ['.'], steps: [{ ...plan.steps[0]!, scope: ['.'] }],
      acceptance: [{ ...plan.acceptance[0]!, command: {
        executable: process.execPath, timeout_ms: 3000, max_output_bytes: 4096,
        argv: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(counter)},'run\\n');const a=require('node:assert/strict'),s=require('./sum.cjs');a.equal(s([]),0);a.equal(s([-2,3]),1)`],
      } }],
    }
    const state = () => store.get(0)!.executions[0]!.workflow!
    const call = (action: string, payload: Record<string, unknown> = {}) => runLocalCommand({
      action, repo: 'fixture/repo', data_root: home, todo_id: todoId, execution_id: executionId, ...payload,
    })
    store.applyWorkflow(todoId, executionId, { ...proposal, command: { ...proposal.command, plan: commandPlan } })
    store.applyWorkflow(todoId, executionId, {
      request_id: 'confirm', expected_revision: 1,
      command: { action: 'confirm_plan', plan_id: 'plan', digest: planDigest(commandPlan), confirmation: 'fixture-user' },
    })
    await call('bind', { request_id: 'bind', expected_revision: 2, attempt_id: 'attempt', owner: 'primary', workspace })
    await call('yield', { request_id: 'yield', expected_revision: 3, actor: 'primary', observed_operations: [], note: 'Fixture setup ended.' })
    const before = content()
    // A real filesystem failure affects the supervisor process too, unlike a spy.
    mkdirSync(`${path}.tmp`)
    const request = { request_id: 'check', expected_revision: state().revision, operation_id: 'check', actor: 'local-runner', acceptance_id: 'arithmetic' }
    const result = await call('check', request)
    expect(result).toMatchObject({ outcome: 'passed', document_projection: { status: 'outdated' } })
    expect(state().operations[0]!.status).toBe('completed')
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
    expect(content()).toBe(before)
    const yaml = readFileSync(join(directory, 'todos.yaml'), 'utf8')
    rmdirSync(`${path}.tmp`)
    await call('resume')
    expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toBe(yaml)
    const checked = state().checks[0]!
    expect(content()).toContain(checked.candidate.digest)
    expect(content()).toContain(checked.receipt)
    expect(content()).toContain('local_runner / local-runner')
    expect((await call('check', request)).artifact).toBe(result.artifact)
    expect(readFileSync(counter, 'utf8')).toBe('run\n')
    expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toBe(yaml)
  }, 20_000)
})
