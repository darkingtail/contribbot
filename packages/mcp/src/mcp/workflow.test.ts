import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TodoStore } from '../core/storage/todo-store.js'
import { ExecutionArtifacts } from '../core/execution/artifacts.js'
import type { WorkflowPlanInput } from '../core/execution/contracts.js'
import { runLocalCommand } from '../core/execution/local.js'
import { fixtureProjectDirectory, saveFixtureProjectConfig } from '../core/execution/__fixtures__/repository.js'

describe('managed workflow over actual MCP stdio', () => {
  const repo = 'workflow-fixture/repo'
  const repoRef = { platform: 'github', instance: 'https://github.com', path: repo } as const
  let home: string
  let client: Client
  let transport: StdioClientTransport
  let store: TodoStore
  let todoId: string
  let executionId: string
  const directory = () => fixtureProjectDirectory(join(home, '.contribbot'), repo)

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-managed-stdio-'))
    saveFixtureProjectConfig(directory(), repo)
    store = new TodoStore(directory())
    todoId = store.add({ ref: 'task', title: 'Workflow task', type: 'feature' }).id!
    executionId = store.activateExecution(0).execution.id
    client = new Client({ name: 'workflow-fixture', version: '1' })
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)), fileURLToPath(new URL('./index.ts', import.meta.url))],
      cwd: home, env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        HOME: home, USERPROFILE: home, GH_CONFIG_DIR: join(home, 'gh'),
        GITHUB_TOKEN: 'isolated-fixture-no-network', GH_TOKEN: 'isolated-fixture-no-network',
      },
      stderr: 'pipe',
    })
    await client.connect(transport)
  }, 15_000)
  afterEach(async () => {
    await client?.close()
    await transport?.close()
    rmSync(home, { recursive: true, force: true })
  })
  const args = () => ({ repo: repoRef, todo_id: todoId, execution_id: executionId })
  const state = () => store.get(0)!.executions[0]!.workflow!
  const local = (action: string, payload: Record<string, unknown> = {}) => runLocalCommand({
    ...args(), data_root: join(home, '.contribbot'), action, ...payload,
  })
  async function boundFixture(
    checked = true,
    coverage: 'task' | 'stage' = 'task',
    manual: 'none' | 'source' | 'source-and-docs' = 'none',
  ) {
    const workspace = join(home, 'workspace')
    mkdirSync(workspace)
    const git = (...args: string[]) => execFileSync('git', [
      '-c', 'core.hooksPath=nonexistent-hooks', '-c', 'commit.gpgSign=false', ...args,
    ], { cwd: workspace, windowsHide: true, stdio: 'pipe' })
    git('init', '--quiet', '--initial-branch=fixture')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('remote', 'add', 'origin', 'https://github.com/workflow-fixture/repo.git')
    writeFileSync(join(workspace, 'sum.cjs'), 'module.exports = values => values.reduce((sum, value) => sum + value, 0)\n')
    if (manual === 'source-and-docs') {
      writeFileSync(join(workspace, 'README.md'), '# Arithmetic\n\nsum(values) returns the sum, or zero for an empty array.\n')
    }
    git('add', '.')
    git('commit', '--quiet', '-m', 'Isolated fixture')
    const plan: WorkflowPlanInput = {
      goal: 'Working arithmetic', completion_scope: coverage,
      remaining_scope: coverage === 'stage' ? ['Build the arithmetic UI'] : [], scope: ['.'], risk: 'normal', non_goals: [],
      steps: [{ id: 's', title: 'Implement', scope: ['.'], depends_on: [], acceptance_ids: ['arithmetic'] }],
      acceptance: [{
        id: 'arithmetic', description: 'Invoke the function with nonempty and empty inputs', kind: 'command', independent: false, required: true,
        command: { executable: process.execPath, argv: ['-e', "const a=require('node:assert/strict'),s=require('./sum.cjs');a.equal(s([2,3]),5);a.equal(s([]),0)"],
          timeout_ms: 2000, max_output_bytes: 4096 },
      }],
    }
    if (manual !== 'none') {
      plan.steps[0]!.acceptance_ids.push('user-result')
      plan.acceptance.push({
        id: 'user-result', description: 'The user accepts the current function interface and delivered source',
        kind: 'manual', independent: false, required: true,
      })
    }
    if (manual === 'source-and-docs') {
      plan.steps[0]!.acceptance_ids.push('user-docs')
      plan.acceptance.push({
        id: 'user-docs', description: 'The user accepts the wording of the delivered README',
        kind: 'manual', independent: false, required: true,
      })
    }
    await local('apply', { request_id: 'p', expected_revision: 0, command: { action: 'propose_plan', plan_id: 'p', plan } })
    await local('apply', { request_id: 'c', expected_revision: state().revision,
      command: { action: 'confirm_plan', plan_id: 'p', digest: state().plans[0]!.digest, confirmation: 'fixture:user-plan' } })
    await local('bind', { request_id: 'b', expected_revision: state().revision, attempt_id: 'a', owner: 'primary', workspace })
    await local('yield', { request_id: 'y', expected_revision: state().revision, actor: 'primary', observed_operations: [], note: 'Fixture writes stopped.' })
    if (checked) await local('check', { request_id: 'check', expected_revision: state().revision, actor: 'local-runner', operation_id: 'check', acceptance_id: 'arithmetic' })
    return workspace
  }
  const userReport = (locator: string, acceptanceId: 'user-result' | 'user-docs' = 'user-result') => ({
    request_id: acceptanceId, expected_revision: state().revision, operation_id: acceptanceId,
    acceptance_id: acceptanceId, actor: 'user', source: 'user', outcome: 'passed',
    plan_id: state().plan_id, attempt_id: state().attempt_id, epoch: state().epoch,
    candidate: state().yield!.candidate, observed_at: new Date().toISOString(),
    locator, summary: acceptanceId === 'user-docs'
      ? 'The fixture user reviewed and accepts the current README wording.'
      : 'The fixture user reviewed and accepts the current function interface and source.',
  })
  const completion = (closureId = 'finish', mode = 'verified', gaps: string[] = []) => ({
    execution_id: executionId, closure_id: closureId, expected_revision: state().revision,
    mode, acknowledged_gaps: gaps, decision: 'fixture:explicit-user-finish', note: 'Requested outcome',
  })

  it('requests pause through MCP, settles locally, and does not resume through the context repair tool', async () => {
    const result = await client.callTool({ name: 'todo_control', arguments: {
      ...args(), request_id: 'pause', expected_revision: 0,
      command: { action: 'request_control', control_id: 'pause', kind: 'pause',
        decision: 'fixture:user-pause', note: 'Pause design work.' },
    } })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(state().control?.active_id).toBe('pause')
    expect(store.get(0)?.status).toBe('active')
    const forged = await client.callTool({ name: 'todo_control', arguments: {
      ...args(), request_id: 'forged', expected_revision: state().revision,
      command: { action: 'settle_pause', control_id: 'pause', actor: 'primary',
        candidate: null, verification: 'a'.repeat(64) },
    } })
    expect(forged.isError).toBe(true)
    await local('settle-pause', { request_id: 'settle', expected_revision: state().revision, control_id: 'pause', actor: 'primary' })
    const context = await client.callTool({ name: 'todo_resume', arguments: args() })
    expect(context.structuredContent).toMatchObject({ todo: { status: 'paused' }, control: { settled: true, dispatch_allowed: false } })
    const list = await client.callTool({ name: 'todo_list', arguments: { repo: repoRef, status: 'paused' } })
    expect(JSON.stringify(list.content)).toContain('### Paused')
    await local('continue', { request_id: 'continue', expected_revision: state().revision, control_id: 'pause',
      actor: 'primary', decision: 'fixture:user-continue' })
    expect(store.get(0)?.status).toBe('active')
    expect(state().attempt_id).toBeNull()
  }, 20_000)

  it('returns versioned structured state and persists plan operations without text parsing', async () => {
    const listing = await client.listTools()
    for (const name of ['todo_context', 'todo_plan', 'todo_operation', 'todo_check', 'todo_resume']) {
      expect(listing.tools.find(tool => tool.name === name)?.inputSchema.required).toContain('repo')
    }
    const context = await client.callTool({ name: 'todo_context', arguments: args() })
    expect(context.isError).not.toBe(true)
    expect(context.structuredContent).toMatchObject({
      schema_version: 1, workflow_revision: 0, todo: { id: todoId }, execution: { id: executionId },
    })
    const beforePlan = await client.callTool({ name: 'todo_resume', arguments: args() })
    expect(beforePlan.structuredContent).toMatchObject({ workflow_revision: 0 })
    const beforePlanState = beforePlan.structuredContent as { workflow_revision: number }
    expect(store.get(0)!.executions[0]!.workflow).toBeUndefined()
    const proposed = await client.callTool({
      name: 'todo_plan', arguments: {
        ...args(), request_id: 'plan', expected_revision: beforePlanState.workflow_revision,
        command: {
          action: 'propose_plan', plan_id: 'plan',
          plan: {
            goal: 'An inspectable user outcome', completion_scope: 'task', remaining_scope: [], scope: ['.'], risk: 'normal', non_goals: [],
            steps: [{ id: 'step', title: 'Implement', scope: ['.'], depends_on: [], acceptance_ids: ['manual'] }],
            acceptance: [{ id: 'manual', description: 'User accepts output', kind: 'manual', independent: false, required: true }],
          },
        },
      },
    })
    expect(proposed.isError, JSON.stringify(proposed)).not.toBe(true)
    expect(proposed.structuredContent).toMatchObject({ workflow: { revision: 1, plan_id: 'plan' } })
    expect(store.get(0)!.executions[0]!.workflow!.plans[0]!.content.goal).toBe('An inspectable user outcome')
    const resumed = await client.callTool({ name: 'todo_resume', arguments: args() })
    expect(resumed.structuredContent).toMatchObject({
      workflow_revision: 1, execution: { id: executionId, workflow: { revision: 1 } }, workspace_observation: 'not_observed',
    })
    const projection = (proposed.structuredContent as { document_projection: { path: string; status: string } }).document_projection
    expect(projection.status).toBe('current')
    const original = readFileSync(projection.path, 'utf8')
    const yaml = readFileSync(join(directory(), 'todos.yaml'), 'utf8')
    const changed = original.replace('An inspectable user outcome', 'Unverified hand-edit')
    writeFileSync(projection.path, changed)
    const observed = await client.callTool({ name: 'todo_context', arguments: args() })
    expect(observed.structuredContent).toMatchObject({ document_projection: { status: 'outdated' } })
    expect(readFileSync(projection.path, 'utf8')).toBe(changed)
    const repaired = await client.callTool({ name: 'todo_resume', arguments: args() })
    expect(repaired.structuredContent).toMatchObject({ workflow_revision: 1, document_projection: { status: 'current' } })
    expect(readFileSync(projection.path, 'utf8')).toBe(original)
    expect(readFileSync(join(directory(), 'todos.yaml'), 'utf8')).toBe(yaml)
  })

  it('does not expose shell execution, fabricated local results or unconfirmed closure via generic operations', async () => {
    const result = await client.callTool({
      name: 'todo_operation', arguments: {
        ...args(), request_id: 'fake', expected_revision: 0,
        command: { action: 'complete_check', operation_id: 'fake', source: 'local_runner', outcome: 'passed' },
      },
    })
    expect(result.isError).toBe(true)
    expect(store.get(0)!.executions[0]!.workflow).toBeUndefined()
    const supervisor = await client.callTool({
      name: 'todo_operation', arguments: {
        ...args(), request_id: 'fake-supervisor', expected_revision: 0,
        command: { action: 'claim_supervisor', operation_id: 'fake', supervisor: {} },
      },
    })
    expect(supervisor.isError).toBe(true)
    expect(store.get(0)!.executions[0]!.workflow).toBeUndefined()
    const reconciliation = await client.callTool({
      name: 'todo_operation', arguments: {
        ...args(), request_id: 'fake-reconciliation', expected_revision: 0,
        command: { action: 'reconcile_check', operation_id: 'fake', actor: 'primary' },
      },
    })
    expect(reconciliation.isError).toBe(true)
    const closureReconciliation = await client.callTool({
      name: 'todo_operation', arguments: {
        ...args(), request_id: 'fake-closure-reconciliation', expected_revision: 0,
        command: { action: 'reconcile_closure', closure_id: 'fake', actor: 'primary' },
      },
    })
    expect(closureReconciliation.isError).toBe(true)
    expect(store.get(0)!.executions[0]!.workflow).toBeUndefined()
    const missing = await client.callTool({ name: 'todo_context', arguments: { ...args(), execution_id: 'wrong' } })
    expect(missing.isError).toBe(true)
    expect(missing.structuredContent).toMatchObject({ schema_version: 1, error: { code: 'workflow_error' } })
  })

  it('returns reusable repository identity for a bound operation without changing operation or archive rules', async () => {
    await boundFixture(false)
    const config = readFileSync(join(directory(), 'config.yaml'))
    const expectedRevision = state().revision
    const command = {
      action: 'begin_operation', operation_id: 'identity-read', kind: 'read', actor: 'primary',
      delegated: false, step_id: 's', scope: ['.'], purpose: 'Read the synthetic workspace',
    }
    const result = await client.callTool({ name: 'todo_operation', arguments: {
      ...args(), request_id: 'identity-operation', expected_revision: expectedRevision, command,
    } })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect.soft(result.structuredContent).toMatchObject({
      schema_version: 1, repo: repoRef, todo_id: todoId, execution_id: executionId,
      workflow: { operations: [expect.objectContaining({ id: 'identity-read', status: 'running' })] },
    })
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(result.structuredContent)
    const echoed = await client.callTool({ name: 'todo_context', arguments: {
      ...args(), repo: (result.structuredContent as Record<string, unknown>).repo,
    } })
    expect.soft(echoed.isError).not.toBe(true)
    expect.soft(echoed.structuredContent).toMatchObject({ repo: repoRef, todo: { id: todoId } })
    const beforeStale = readFileSync(join(directory(), 'todos.yaml'))
    expect((await client.callTool({ name: 'todo_operation', arguments: {
      ...args(), request_id: 'stale-operation', expected_revision: expectedRevision,
      command: { ...command, operation_id: 'stale-read' },
    } })).isError).toBe(true)
    expect(readFileSync(join(directory(), 'todos.yaml'))).toEqual(beforeStale)
    const returned = await client.callTool({ name: 'todo_operation', arguments: {
      ...args(), request_id: 'return-identity', expected_revision: state().revision,
      command: { action: 'return_operation', operation_id: 'identity-read',
        receipt: 'fixture:read-result', process_stopped: true, note: 'Synthetic read returned.' },
    } })
    expect(returned.isError).not.toBe(true)
    expect.soft(returned.structuredContent).toMatchObject({ repo: repoRef })
    expect(state().operations[0]!.status).toBe('returned')
    expect(store.get(0)!.status).toBe('active')
    expect(store.listArchived()).toEqual([])
    expect(readFileSync(join(directory(), 'config.yaml'))).toEqual(config)
  }, 25_000)

  it('closes a checked candidate through public todo_done and safely replays the exact outcome', async () => {
    await boundFixture()
    expect(state().plans[0]!.content.acceptance.map(item => item.kind)).toEqual(['command'])
    expect((await local('inspect')).readiness).toMatchObject({ ready: true, missing: [] })
    expect(store.get(0)!.status).toBe('active')
    expect(state().closure).toBeNull()
    const input = { repo: repoRef, item: todoId, completion: completion() }
    const result = await client.callTool({ name: 'todo_done', arguments: input })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      schema_version: 1, todo_id: todoId, execution_id: executionId, closure: { id: 'finish', mode: 'verified' },
    })
    expect(store.list()[0]!.status).toBe('done')
    expect(store.listArchived()).toHaveLength(0)
    expect((await client.callTool({ name: 'todo_done', arguments: input })).isError).not.toBe(true)
    expect(store.listArchived()).toHaveLength(0)
    const preview = await client.callTool({ name: 'todo_archive', arguments: { repo: repoRef } })
    const text = (preview.content as { text: string }[])[0]!.text
    const selections = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)![1]!)
    const archived = await client.callTool({ name: 'todo_archive', arguments: { repo: repoRef, selections } })
    expect(JSON.stringify(archived)).toContain('success')
    expect(store.list()).toEqual([])
    expect((await client.callTool({ name: 'todo_done', arguments: input })).isError).not.toBe(true)
    expect(store.listArchived()).toHaveLength(1)
  }, 25_000)

  it('uses one user statement as current manual evidence and a public completion decision', async () => {
    await boundFixture(true, 'task', 'source')
    expect((await local('inspect')).readiness).toMatchObject({ ready: false, missing: ['user-result'] })
    const userStatement = 'fixture:user-turn-accept-whole-task-and-finish'
    const report = userReport(userStatement)
    await local('report', report)
    expect((await local('inspect')).readiness).toMatchObject({ ready: true, missing: [] })
    expect(store.get(0)!.status).toBe('active')

    const input = {
      repo: repoRef, item: todoId,
      completion: { ...completion(), decision: userStatement },
    }
    const result = await client.callTool({ name: 'todo_done', arguments: input })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ closure: { mode: 'verified' } })
    expect(store.get(0)!.status).toBe('done')
    expect(store.listArchived()).toEqual([])
    expect(state().checks).toHaveLength(2)
    expect(state().closings).toHaveLength(1)
    expect(state().closings[0]!.intent.decision).toBe(userStatement)
    const evidence = new ExecutionArtifacts(
      directory(), executionId,
    ).getReceipt(report.operation_id)
    expect(evidence?.value).toMatchObject({
      locator: userStatement, source: 'user', observed_at: report.observed_at,
      candidate: report.candidate, outcome: 'passed',
    })
    expect((await client.callTool({ name: 'todo_done', arguments: input })).isError).not.toBe(true)
    expect(state().checks).toHaveLength(2)
    expect(state().closings).toHaveLength(1)
    expect(store.listArchived()).toEqual([])
  }, 25_000)

  it('preserves current source acceptance when a separate command check runs later without auto-finishing', async () => {
    await boundFixture(false, 'task', 'source')
    const report = userReport('fixture:user-accepts-current-source-only')
    await local('report', report)
    const manualCheck = state().checks[0]
    expect((await local('inspect')).readiness).toMatchObject({ ready: false, missing: ['arithmetic'] })
    await local('check', {
      request_id: 'later-check', expected_revision: state().revision,
      actor: 'local-runner', operation_id: 'later-check', acceptance_id: 'arithmetic',
    })
    expect((await local('inspect')).readiness).toMatchObject({ ready: true, missing: [] })
    expect(state().checks[0]).toEqual(manualCheck)
    expect(state().checks).toHaveLength(2)
    expect(state().closings).toEqual([])
    expect(state().closure).toBeNull()
    expect(store.get(0)!.status).toBe('active')
    expect(store.listArchived()).toEqual([])
  }, 25_000)

  it('does not let a finish request substitute for a missing current user report', async () => {
    await boundFixture(true, 'task', 'source')
    const result = await client.callTool({ name: 'todo_done', arguments: {
      repo: repoRef, item: todoId, completion: completion('no-user-observation'),
    } })
    expect(result.isError).toBe(true)
    expect(state().checks.map(item => item.source)).toEqual(['local_runner'])
    expect(state().closure).toBeNull()
    expect(store.get(0)!.status).toBe('active')
    expect(store.listArchived()).toEqual([])
    expect((await local('inspect')).readiness).toMatchObject({ ready: false, missing: ['user-result'] })
  }, 25_000)

  it('does not fill a second manual criterion from a report for the first one', async () => {
    await boundFixture(true, 'task', 'source-and-docs')
    await local('report', userReport('fixture:user-accepts-current-source-only'))
    expect((await local('inspect')).readiness).toMatchObject({ ready: false, missing: ['user-docs'] })
    const result = await client.callTool({ name: 'todo_done', arguments: {
      repo: repoRef, item: todoId, completion: completion('missing-docs-observation'),
    } })
    expect(result.isError).toBe(true)
    expect(state().checks.map(item => item.acceptance_id)).toEqual(['arithmetic', 'user-result'])
    expect(state().closure).toBeNull()
    expect(store.get(0)!.status).toBe('active')
    expect(store.listArchived()).toEqual([])
    expect((await local('inspect')).readiness).toMatchObject({ ready: false, missing: ['user-docs'] })
  }, 25_000)

  it('allows one statement to support distinct reports for multiple actually reviewed objects and completion', async () => {
    await boundFixture(true, 'task', 'source-and-docs')
    const userStatement = 'fixture:user-reviewed-source-and-docs-accepts-whole-task-and-finish'
    for (const acceptanceId of ['user-result', 'user-docs'] as const) {
      await local('report', userReport(userStatement, acceptanceId))
    }
    expect((await local('inspect')).readiness).toMatchObject({ ready: true, missing: [] })
    expect(store.get(0)!.status).toBe('active')
    const result = await client.callTool({ name: 'todo_done', arguments: {
      repo: repoRef, item: todoId,
      completion: { ...completion(), decision: userStatement },
    } })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(state().checks.map(item => item.acceptance_id)).toEqual(['arithmetic', 'user-result', 'user-docs'])
    expect(state().closings[0]!.intent.decision).toBe(userStatement)
    expect(store.get(0)!.status).toBe('done')
    expect(store.listArchived()).toEqual([])
  }, 25_000)

  it('exposes stage coverage across MCP/CLI without treating passing checks as whole-task completion', async () => {
    await boundFixture(true, 'stage')
    const context = await client.callTool({ name: 'todo_context', arguments: args() })
    expect(context.structuredContent).toMatchObject({ completion_coverage: {
      scope: 'stage', confirmed: true, remaining_scope: ['Build the arithmetic UI'], scope_allows_task_completion: false,
    } })
    const inspected = await local('inspect')
    expect(inspected).toMatchObject({
      readiness: { ready: true }, completion_coverage: { scope: 'stage', scope_allows_task_completion: false },
    })
    for (const mode of ['verified', 'with_gaps']) {
      const result = await client.callTool({ name: 'todo_done', arguments: {
        repo: repoRef, item: todoId, completion: completion(`stage-${mode}`, mode),
      } })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).toMatch(/coverage|stage/i)
    }
    expect(state().closings).toEqual([])
    expect(state().checks).toHaveLength(1)
    expect(store.get(0)!.status).toBe('active')
    await expect(local('close', { ...completion(), target: { kind: 'local' } })).rejects.toThrow(/coverage|stage/i)
    expect(store.listArchived()).toEqual([])
  }, 25_000)

  it('refuses missing evidence through public todo_done without archiving or silently downgrading', async () => {
    await boundFixture()
    const receipt = state().checks[0]!.receipt
    const artifact = join(directory(), 'executions', executionId, 'artifacts', `${receipt}.json`)
    const content = readFileSync(artifact)
    rmSync(artifact)
    const result = await client.callTool({ name: 'todo_done', arguments: {
      repo: repoRef, item: todoId, completion: completion('missing-evidence'),
    } })
    expect(result.isError).toBe(true)
    expect(store.listArchived()).toEqual([])
    expect(state().closure).toBeNull()
    writeFileSync(artifact, content)
    const recovered = await client.callTool({ name: 'todo_done', arguments: {
      repo: repoRef, item: todoId, completion: completion('new-closure'),
    } })
    expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true)
    expect(store.list()[0]!.executions[0]!.workflow!.closure?.mode).toBe('verified')
  }, 30_000)

  it.each(['with_gaps', 'stopped'])('keeps public %s closure distinct from verified', async mode => {
    await boundFixture(false)
    if (mode === 'stopped') {
      const requested = await client.callTool({ name: 'todo_control', arguments: {
        ...args(), request_id: 'cancel', expected_revision: state().revision,
        command: { action: 'request_control', control_id: 'cancel', kind: 'cancel',
          decision: 'fixture:explicit-user-finish', note: 'Cancel the task without claiming verification.' },
      } })
      expect(requested.isError, JSON.stringify(requested)).not.toBe(true)
    }
    const result = await client.callTool({ name: 'todo_done', arguments: {
      repo: repoRef, item: todoId, completion: completion('explicit-outcome', mode, ['acceptance:arithmetic']),
    } })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ closure: { mode } })
    expect(store.list()[0]!.status).toBe(mode === 'stopped' ? 'cancelled' : 'done')
    expect(store.listArchived()).toEqual([])
  }, 20_000)
})
