import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
const flags = process.argv.slice(2)
if (flags.length > 1 || flags.some(flag => flag !== '--source-skill')) throw new Error('Usage: execution-smoke.mjs [--source-skill]')
const sourceSkill = flags.includes('--source-skill')
if (sourceSkill) {
  const { register } = await import(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)
  register({ tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) })
}
const { TodoStore } = await import(sourceSkill ? '../src/core/storage/todo-store.ts' : '../dist/index.js')

const home = mkdtempSync(join(tmpdir(), 'contribbot-execution-smoke-'))
const workspace = join(home, 'workspace')
const dataRoot = join(home, '.contribbot')
const repo = 'execution-smoke/repo'
const directory = join(dataRoot, ...repo.split('/'))
const counter = join(home, 'command-runs.txt')
const gate = join(home, 'wait-for-release')
const started = join(home, 'waiting-command')
const release = join(home, 'release-command')
const finished = join(home, 'finished-command')
const cliPath = sourceSkill
  ? join(home, '.agents/skills/contribbot-todo/scripts/contribbot-exec.mjs')
  : fileURLToPath(new URL('../dist/cli/execution.js', import.meta.url))
const serverArgs = sourceSkill
  ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
      fileURLToPath(new URL('../src/mcp/index.ts', import.meta.url))]
  : [fileURLToPath(new URL('../dist/mcp/index.js', import.meta.url))]
const env = {
  ...process.env, HOME: home, USERPROFILE: home, GH_CONFIG_DIR: join(home, 'gh'),
  GITHUB_TOKEN: 'isolated-fixture-no-network', GH_TOKEN: 'isolated-fixture-no-network',
}
const results = []
let client
let transport
let finishCrashFixture
let sourceSetup
const sourceLinks = []

async function waitFor(check, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (true) {
    try { return check() }
    catch (error) {
      if (Date.now() >= deadline) throw error
      await delay(50)
    }
  }
}

try {
  if (sourceSkill) {
    const { planSetup, applySetup } = await import('../../../scripts/dev-setup.mjs')
    const actualRepo = fileURLToPath(new URL('../../../', import.meta.url))
    // Keep repository-local config writes inside the fixture as well as HOME.
    const developmentRepo = join(home, 'development checkout')
    mkdirSync(developmentRepo)
    writeFileSync(join(developmentRepo, 'package.json'), readFileSync(join(actualRepo, 'package.json')))
    for (const name of ['packages', 'skills']) {
      const link = join(developmentRepo, name)
      symlinkSync(join(actualRepo, name), link, process.platform === 'win32' ? 'junction' : 'dir')
      sourceLinks.push(link)
    }
    sourceSetup = planSetup({
      repo: developmentRepo,
      home, codexHome: join(home, '.codex'),
    })
    applySetup(sourceSetup)
  }
  const beforeDiscovery = readdirSync(home)
  const discovery = spawnSync(process.execPath, [cliPath, 'check', '--schema', '--request', '-'], {
    cwd: home, env, windowsHide: true, encoding: 'utf8', input: '{invalid-json', timeout: 15_000,
  })
  assert.equal(discovery.status, 0, discovery.stderr + discovery.stdout)
  const checkSchema = JSON.parse(discovery.stdout)
  assert.equal(checkSchema.type, 'object')
  assert.ok(checkSchema.required.includes('acceptance_id'))
  assert.equal(checkSchema.properties.directory, undefined)
  assert.equal(checkSchema['x-contribbot'].validation, 'structure-only')
  assert.deepEqual(readdirSync(home), beforeDiscovery)
  assert.equal(existsSync(dataRoot), false)
  results.push({ scenario: 'built CLI discovers check structure before any repository or request exists', outcome: 'passed' })
  console.log('PASS built CLI request discovery without reading invalid input or creating data')
  mkdirSync(workspace)
  const git = (...argv) => execFileSync('git', [
    '-c', 'core.hooksPath=nonexistent-hooks', '-c', 'commit.gpgSign=false', ...argv,
  ], {
    cwd: workspace, windowsHide: true, stdio: 'pipe',
    env: Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_/i.test(key))),
  })
  git('init', '--quiet', '--initial-branch=fixture')
  git('config', 'user.name', 'Isolated Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('remote', 'add', 'origin', `https://github.com/${repo}.git`)
  const packageManifest = '{"name":"arithmetic-smoke","private":true}\n'
  writeFileSync(join(workspace, 'package.json'), packageManifest)
  writeFileSync(join(workspace, 'sum.cjs'), 'module.exports = values => values.reduce((sum, value) => sum + value, 1)\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'Isolated broken fixture')

  const store = new TodoStore(directory)
  const todoId = store.add({ ref: 'sum', title: 'Correct sum calculation', type: 'bug' }).id
  const executionId = store.activateExecution(0).execution.id
  writeFileSync(join(directory, 'config.yaml'), 'fork: null\nupstream: null\n')
  const identity = { todo_id: todoId, execution_id: executionId }
  const workflow = () => store.list()[0].executions[0].workflow
  const revision = () => workflow()?.revision ?? 0
  const mark = (scenario) => {
    results.push({ scenario, outcome: 'passed' })
    console.log(`PASS ${scenario}`)
  }
  const local = (action, payload = {}, success = true, root = dataRoot) => {
    const child = spawnSync(process.execPath, [
      cliPath, action, '--repo', repo, '--data-root', root, '--request', '-',
    ], {
      cwd: home, env, windowsHide: true, encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ ...identity, ...payload }), maxBuffer: 4 * 1024 * 1024,
    })
    assert.equal(child.error, undefined)
    assert.equal(child.signal, null)
    assert.equal(child.status, success ? 0 : 1, child.stderr + child.stdout)
    return JSON.parse(child.stdout)
  }
  const connect = async () => {
    client = new Client({ name: 'execution-smoke', version: '1' })
    transport = new StdioClientTransport({
      command: process.execPath, args: serverArgs, cwd: home, env, stderr: 'pipe',
    })
    let serverError = ''
    transport.stderr?.on('data', chunk => { serverError = (serverError + String(chunk)).slice(-8192) })
    try { await client.connect(transport, { timeout: 10_000 }) }
    catch (error) { throw new Error(`Fixture MCP connection failed: ${serverError}`, { cause: error }) }
  }
  const call = async (name, payload = {}) => {
    const response = await client.callTool({ name, arguments: { repo, ...identity, ...payload } })
    assert.notEqual(response.isError, true, JSON.stringify(response))
    assert.equal(response.structuredContent?.schema_version, 1)
    return response.structuredContent
  }
  const apply = (name, requestId, command) => call(name, {
    request_id: requestId, expected_revision: revision(), command,
  })
  const yieldWorkspace = (requestId) => local('yield', {
    request_id: requestId, expected_revision: revision(), actor: 'scripted-host',
    observed_operations: workflow().operations.map(operation => operation.id), note: 'Fixture host has finished all writes.',
  })
  const commandRequest = (id) => ({
    request_id: id, operation_id: id, expected_revision: revision(), acceptance_id: 'sum-behavior', actor: 'local-runner',
  })

  await connect()
  await apply('todo_plan', 'plan', {
    action: 'propose_plan', plan_id: 'p1',
    plan: {
      goal: 'Sum returns the arithmetic sum, including the empty input', completion_scope: 'task', remaining_scope: [],
      non_goals: ['Network access', 'Publishing'], scope: ['sum.cjs'], risk: 'normal',
      steps: [{ id: 'fix', title: 'Correct sum', scope: ['sum.cjs'], depends_on: [], acceptance_ids: ['sum-behavior'] }],
      acceptance: [{
        id: 'sum-behavior', description: 'Execute sum([2,3]), sum([]), and sum([-2,2]) and assert their results',
        required: true, kind: 'command', independent: false,
        command: {
          executable: process.execPath,
          argv: ['-e', [
            "require('node:fs').appendFileSync(process.argv[1], 'run\\n')",
            "const assert = require('node:assert/strict')",
            "assert.equal(require('./package.json').name, 'arithmetic-smoke')",
            "const sum = require('./sum.cjs')",
            'assert.equal(sum([2, 3]), 5)',
            'assert.equal(sum([]), 0)',
            'assert.equal(sum([-2, 2]), 0)',
            `if (require('node:fs').existsSync(${JSON.stringify(gate)})) {
              const fs = require('node:fs');
              fs.writeFileSync(${JSON.stringify(started)}, String(process.pid));
              const timer = setInterval(() => {
                if (fs.existsSync(${JSON.stringify(release)})) {
                  clearInterval(timer);
                  fs.writeFileSync(${JSON.stringify(finished)}, 'assertions verified');
                  console.log('gated-behavior-verified');
                }
              }, 50);
            }`,
          ].join(';'), counter],
          timeout_ms: 20_000, max_output_bytes: 16_384,
          dependency_inputs: ['package.json'],
        },
      }],
    },
  })
  assert.match(local('bind', {
    request_id: 'premature-bind', expected_revision: revision(), attempt_id: 'a1', owner: 'scripted-host', workspace,
  }, false).error.message, /confirm/i)
  mark('Unconfirmed plan cannot start implementation')

  await apply('todo_plan', 'confirm', {
    action: 'confirm_plan', plan_id: 'p1', digest: workflow().plans[0].digest,
    confirmation: 'isolated-fixture:explicit-plan-decision',
  })
  local('bind', { request_id: 'bind', expected_revision: revision(), attempt_id: 'a1', owner: 'scripted-host', workspace })
  yieldWorkspace('baseline-yield')
  const failed = local('check', commandRequest('check-broken'))
  assert.equal(failed.outcome, 'failed')
  assert.equal(local('inspect').readiness.ready, false)
  assert.match(local('close', {
    closure_id: 'premature-close', expected_revision: revision(), mode: 'verified', acknowledged_gaps: [],
    decision: 'isolated-fixture:attempt-close', note: 'Must be rejected', target: { kind: 'local' },
  }, false).error.message, /acceptance|gap/i)
  assert.equal(store.listArchived().length, 0)
  mark('Broken behavior fails a real subprocess check and cannot be delivered')

  await apply('todo_operation', 'edit-start', {
    action: 'begin_operation', operation_id: 'edit', kind: 'write', actor: 'scripted-host', delegated: false,
    step_id: 'fix', scope: ['sum.cjs'], purpose: 'Repair the incorrect accumulator',
  })
  writeFileSync(join(workspace, 'sum.cjs'), 'module.exports = values => values.reduce((sum, value) => sum + value, 0)\n')
  await apply('todo_operation', 'edit-return', {
    action: 'return_operation', operation_id: 'edit', process_stopped: true,
    receipt: 'isolated-fixture:scripted-host-edit', note: 'Changed accumulator in the actual fixture file.',
  })
  await apply('todo_operation', 'edit-adopt', {
    action: 'adopt_operation', operation_id: 'edit', actor: 'scripted-host', decision: 'accepted',
    note: 'Fixture host retains the bounded change; execution checks are still required.',
  })
  yieldWorkspace('fixed-yield')
  const successfulRequest = commandRequest('check-fixed')
  const passed = local('check', successfulRequest)
  assert.equal(passed.outcome, 'passed')
  assert.notEqual(passed.receipt.expected.digest, failed.receipt.expected.digest)
  assert.equal(local('inspect').readiness.ready, true)
  mark('Actual source repair passes a fresh candidate-bound check')

  await client.close()
  await transport.close()
  await connect()
  const resumed = await call('todo_resume')
  assert.equal(resumed.execution.workflow.checks.length, 2)
  assert.equal(resumed.workspace_observation, 'not_observed')
  assert.equal(resumed.readiness, null)
  const beforeObservation = revision()
  const observation = local('observe', { operation_id: successfulRequest.operation_id })
  assert.equal(observation.runner.observation.state, 'stopped')
  assert.equal(observation.supervisor.observation.state, 'stopped')
  assert.equal(observation.command.observation.state, 'stopped')
  assert.notEqual(observation.supervisor.handle.pid, observation.runner.handle.pid)
  assert.notEqual(observation.supervisor.handle.pid, observation.command.handle.pid)
  assert.equal(observation.result_receipt, passed.artifact)
  assert.equal(observation.automatic_release, false)
  assert.equal(revision(), beforeObservation)
  assert.equal(readFileSync(counter, 'utf8'), 'run\nrun\n')
  mark('Another CLI process observes the original handles and receipt without replay or state changes')
  const recovered = local('recover', successfulRequest)
  assert.equal(recovered.artifact, passed.artifact)
  assert.equal(readFileSync(counter, 'utf8'), 'run\nrun\n')
  mark('A fresh MCP process restores history; receipt recovery does not rerun the command')
  const dependencyInputs = [{ path: 'package.json', digest: createHash('sha256').update(packageManifest).digest('hex') }]
  assert.equal(passed.receipt.version, 2)
  assert.equal(passed.receipt.environment.node, process.version)
  assert.equal(passed.receipt.environment.runner_executable, process.execPath)
  assert.deepEqual(passed.receipt.environment.dependency_inputs, { before: dependencyInputs, after: dependencyInputs })
  assert.deepEqual(recovered.receipt.environment, passed.receipt.environment)
  assert.equal(local('inspect').readiness.environment_limitations[0].receipt_version, 2)
  assert.equal(readFileSync(counter, 'utf8'), 'run\nrun\n')
  mark('Built CLI preserves original declared-input hashes and runner observations across receipt recovery')

  const recordPath = resumed.document_projection.path
  const recordBefore = readFileSync(recordPath, 'utf8')
  assert.ok(recordBefore.includes(passed.artifact))
  assert.ok(recordBefore.includes(failed.artifact))
  const handwritten = '\r\n## Personal next steps\r\nKeep this text byte-for-byte.\r\n'
  const expectedRecord = recordBefore + handwritten
  const workflowBeforeRepair = readFileSync(join(directory, 'todos.yaml'), 'utf8')
  writeFileSync(recordPath, expectedRecord.replace(workflow().plans[0].content.goal, 'A hand-edited claim, not task state'))
  const changedRecord = readFileSync(recordPath, 'utf8')
  assert.equal(local('context').document_projection.status, 'outdated')
  assert.equal(readFileSync(recordPath, 'utf8'), changedRecord)
  assert.equal((await call('todo_resume')).document_projection.status, 'current')
  assert.equal(readFileSync(recordPath, 'utf8'), expectedRecord)
  const invalidBytes = Buffer.concat([Buffer.from(expectedRecord), Buffer.from([0xff])])
  writeFileSync(recordPath, invalidBytes)
  assert.equal(local('resume').document_projection.status, 'blocked')
  assert.deepEqual(readFileSync(recordPath), invalidBytes)
  writeFileSync(recordPath, expectedRecord)
  assert.equal(readFileSync(join(directory, 'todos.yaml'), 'utf8'), workflowBeforeRepair)
  assert.equal(readFileSync(counter, 'utf8'), 'run\nrun\n')
  mark('Built MCP/CLI repair only the generated document, preserve handwritten bytes and reject lossy encoding without replay')

  writeFileSync(gate, 'wait')
  const crashRequest = commandRequest('requester-crash')
  const requestPath = join(home, 'crash-request.json')
  writeFileSync(requestPath, JSON.stringify({ ...identity, ...crashRequest }))
  const requester = spawn(process.execPath, [
    cliPath, 'check', '--repo', repo, '--data-root', dataRoot, '--request', requestPath,
  ], { cwd: home, env, windowsHide: true, stdio: 'ignore' })
  const requesterStopped = new Promise((resolve) => {
    requester.once('close', () => resolve())
    requester.once('error', error => resolve(error))
  })
  finishCrashFixture = async () => {
    writeFileSync(release, 'release')
    if (requester.exitCode === null && requester.signalCode === null) requester.kill('SIGKILL')
    await requesterStopped
    await waitFor(() => {
      const observed = local('observe', { operation_id: crashRequest.operation_id })
      assert.equal(observed.supervisor?.observation.state, 'stopped')
      assert.equal(observed.command?.observation.state, 'stopped')
    }, 30_000)
  }
  await waitFor(() => assert.equal(existsSync(started), true))
  requester.kill('SIGKILL')
  assert.equal(await requesterStopped, undefined)
  const surviving = await waitFor(() => {
    const observed = local('observe', { operation_id: crashRequest.operation_id })
    assert.equal(observed.command?.observation.state, 'running')
    assert.equal(observed.command.handle.pid, Number(readFileSync(started, 'utf8')))
    return observed
  })
  assert.equal(surviving.runner.observation.state, 'stopped')
  assert.equal(surviving.supervisor.observation.state, 'running')
  assert.equal(surviving.command.observation.state, 'running')
  assert.equal(surviving.result_receipt, null)
  const blockedWriter = await client.callTool({
    name: 'todo_operation',
    arguments: {
      repo, ...identity, request_id: 'writer-during-surviving-check', expected_revision: revision(),
      command: {
        action: 'begin_operation', operation_id: 'unsafe-writer', kind: 'write', actor: 'scripted-host',
        delegated: false, step_id: 'fix', scope: ['sum.cjs'], purpose: 'Must be rejected while the original command runs',
      },
    },
  })
  assert.equal(blockedWriter.isError, true)
  assert.equal(workflow().operations.some(operation => operation.id === 'unsafe-writer'), false)
  await finishCrashFixture()
  finishCrashFixture = undefined
  assert.equal(readFileSync(finished, 'utf8'), 'assertions verified')
  assert.equal(workflow().checks.length, 2)
  const crashRecovered = local('recover', crashRequest)
  assert.equal(crashRecovered.outcome, 'passed')
  assert.equal(crashRecovered.receipt.process.stdout.trim(), 'gated-behavior-verified')
  assert.equal(local('recover', crashRequest).artifact, crashRecovered.artifact)
  assert.equal(workflow().checks.length, 3)
  assert.equal(readFileSync(counter, 'utf8'), 'run\nrun\nrun\n')
  mark('Killing the requesting CLI preserves the real command result; a new process recovers it without rerunning')

  writeFileSync(join(workspace, 'later.txt'), 'Untracked change after checking\n')
  assert.equal(local('inspect').readiness.ready, false)
  rmSync(join(workspace, 'later.txt'))
  assert.equal(local('inspect').readiness.ready, true)
  mark('An untracked post-check change invalidates current delivery readiness')

  const evidencePath = join(directory, 'executions', executionId, 'artifacts', `${crashRecovered.artifact}.json`)
  const evidence = readFileSync(evidencePath)
  rmSync(evidencePath)
  try {
    const missingEvidence = await client.callTool({
      name: 'todo_done', arguments: {
        repo, item: todoId, completion: {
          execution_id: executionId, closure_id: 'public-missing-evidence', expected_revision: revision(),
          mode: 'verified', acknowledged_gaps: [], decision: 'isolated-fixture:attempt-close', note: 'Must reject lost evidence',
        },
      },
    })
    assert.equal(missingEvidence.isError, true)
    assert.equal(missingEvidence.structuredContent.error.code, 'closure_error')
    assert.equal(workflow().closure, null)
    assert.equal(store.listArchived().length, 0)
    assert.equal(readFileSync(counter, 'utf8'), 'run\nrun\nrun\n')
  }
  finally { writeFileSync(evidencePath, evidence) }
  mark('Public MCP completion refuses lost evidence without archiving or rerunning checks')

  const closeRequest = {
    closure_id: 'finish', expected_revision: revision(), mode: 'verified', acknowledged_gaps: [],
    decision: 'isolated-fixture:explicit-finish-decision', note: 'Finish the verified fixture task', target: { kind: 'local' },
  }
  const { target: _target, ...completion } = closeRequest
  const publicClose = { item: todoId, completion: { execution_id: executionId, ...completion } }
  assert.equal((await call('todo_done', publicClose)).closure.mode, 'verified')
  assert.equal((await call('todo_done', publicClose)).closure.id, 'finish')
  const localClosed = local('close', closeRequest)
  assert.equal(localClosed.todo.status, 'done')
  assert.equal(localClosed.archived, false)
  assert.equal(store.list().length, 1)
  assert.equal(store.listArchived().length, 0)
  const previewResult = await client.callTool({ name: 'todo_archive', arguments: { repo } })
  assert.notEqual(previewResult.isError, true)
  const archivePreview = previewResult.content[0].text
  const archiveSelections = JSON.parse(archivePreview.match(/```json\n([\s\S]*?)\n```/)[1])
  assert.equal(archiveSelections.length, 1)
  assert.equal(archiveSelections[0].todo_id, todoId)
  const archiveResult = await client.callTool({ name: 'todo_archive', arguments: { repo, selections: archiveSelections } })
  assert.notEqual(archiveResult.isError, true)
  assert.match(archiveResult.content[0].text, /success/)
  const archived = store.listArchived()
  assert.equal(store.list().length, 0)
  assert.equal(archived.length, 1)
  assert.equal(archived[0].executions[0].workflow.closure.mode, 'verified')
  const historical = await call('todo_resume')
  assert.equal(historical.execution.workflow.closure.candidate.digest, passed.receipt.expected.digest)
  assert.equal(readFileSync(counter, 'utf8'), 'run\nrun\nrun\n')
  mark('Public MCP and local CLI end once without archival, then explicit preview selection archives without repeating execution')

  const recoveryTodo = store.add({ ref: 'interruption', title: 'Continue an interrupted check', type: 'bug' })
  const recoveryExecution = store.activateExecution(0).execution.id
  const recoveryIdentity = { todo_id: recoveryTodo.id, execution_id: recoveryExecution }
  const recoveryLocal = (action, payload = {}, success = true) => local(action, { ...recoveryIdentity, ...payload }, success)
  const recoveryCounter = join(home, 'interrupted-command-runs')
  const recoveryGate = join(home, 'interrupted-command-wait')
  writeFileSync(recoveryGate, 'wait')
  recoveryLocal('apply', { request_id: 'p', expected_revision: 0, command: {
    action: 'propose_plan', plan_id: 'p', plan: {
      goal: 'Continue without treating interruption recovery as passed acceptance', completion_scope: 'task', remaining_scope: [], non_goals: ['Network'],
      scope: ['.'], risk: 'normal',
      steps: [{ id: 's', title: 'Verify sum', scope: ['.'], depends_on: [], acceptance_ids: ['sum'] }],
      acceptance: [{
        id: 'sum', description: 'Invoke actual sum with nonempty and empty input',
        kind: 'command', required: true, independent: false,
        command: { executable: process.execPath, argv: ['-e', `
          const fs=require('node:fs'),a=require('node:assert/strict'),sum=require('./sum.cjs');
          fs.appendFileSync(${JSON.stringify(recoveryCounter)},'run\\n');
          a.equal(sum([2,3]),5);a.equal(sum([]),0);
          if(fs.existsSync(${JSON.stringify(recoveryGate)}))setInterval(()=>{},100);
        `], timeout_ms: 500, max_output_bytes: 4096 },
      }],
    },
  } })
  recoveryLocal('apply', { request_id: 'confirm', expected_revision: revision(), command: {
    action: 'confirm_plan', plan_id: 'p', digest: workflow().plans[0].digest, confirmation: 'isolated-fixture:user-plan',
  } })
  recoveryLocal('bind', { request_id: 'bind', expected_revision: revision(), attempt_id: 'attempt', owner: 'scripted-host', workspace })
  const recoveryYield = () => recoveryLocal('yield', {
    request_id: `yield-${revision()}`, expected_revision: revision(), actor: 'scripted-host',
    observed_operations: workflow().operations.map(operation => operation.id), note: 'Fixture accounted for its own processes.',
  })
  recoveryYield()
  const interruptedRequest = { request_id: 'interrupted', operation_id: 'interrupted', acceptance_id: 'sum',
    actor: 'local-runner', expected_revision: revision() }
  const interrupted = recoveryLocal('check', interruptedRequest)
  assert.equal(interrupted.outcome, 'blocked')
  const stopped = await waitFor(() => {
    const observation = recoveryLocal('observe', { operation_id: 'interrupted' })
    assert.equal(observation.supervisor?.observation.state, 'stopped')
    assert.equal(observation.command?.observation.state, 'stopped')
    return observation
  })
  const reconcileRequest = {
    request_id: 'reconcile', operation_id: 'interrupted', expected_revision: revision(), actor: 'scripted-host',
    decision: 'isolated-fixture:user-interruption-recovery',
    report: {
      source: 'host_report', actor: 'fixture-controller', locator: 'fixture:observed-owned-command',
      operation_id: 'interrupted', attempt_id: 'attempt', observed_at: new Date().toISOString(),
      reviewed_candidate: recoveryLocal('inspect').candidate.digest,
      raw: JSON.stringify(stopped),
      coverage_basis: 'Fixture owns the entire inline command; it never spawns descendants. Original recorded processes were observed stopped.',
      descendants: [], accounted_missing: [], unresolved: [],
    },
  }
  const reconciled = recoveryLocal('reconcile', reconcileRequest)
  assert.equal(reconciled.verification, 'not_verified')
  assert.equal(workflow().checks.length, 1)
  assert.equal(workflow().checks[0].outcome, 'blocked')
  assert.equal(workflow().yield, null)
  assert.equal(recoveryLocal('reconcile', reconcileRequest).reconciliation_receipt, reconciled.reconciliation_receipt)
  recoveryLocal('recover', interruptedRequest, false)
  assert.equal(readFileSync(recoveryCounter, 'utf8'), 'run\n')
  recoveryYield()
  assert.equal(recoveryLocal('inspect').readiness.ready, false)
  rmSync(recoveryGate)
  assert.equal(recoveryLocal('check', {
    request_id: 'fresh', operation_id: 'fresh', acceptance_id: 'sum', actor: 'local-runner', expected_revision: revision(),
  }).outcome, 'passed')
  assert.equal(recoveryLocal('inspect').readiness.ready, true)
  assert.equal(readFileSync(recoveryCounter, 'utf8'), 'run\nrun\n')
  recoveryLocal('close', {
    closure_id: 'finish-recovery', expected_revision: revision(), mode: 'verified', acknowledged_gaps: [],
    decision: 'isolated-fixture:user-complete', note: 'Fresh actual assertions passed', target: { kind: 'local' },
  })
  assert.equal(store.list()[0].status, 'done')
  assert.equal(store.listArchived().length, 1)
  store.archiveAndDelete(0)
  assert.equal(store.list().length, 0)
  assert.equal(store.listArchived().length, 2)
  mark('An interrupted command is reconciled without replay or a fake pass; a fresh CLI check is required before completion')

  const closeTodo = store.add({ ref: 'post-close-drift', title: 'Keep changes after a recorded remote close', type: 'bug' })
  const closeExecution = store.activateExecution(0).execution.id
  const closeIdentity = { todo_id: closeTodo.id, execution_id: closeExecution }
  const closeLocal = (action, payload = {}, success = true) => local(action, { ...closeIdentity, ...payload }, success)
  const closeCounter = join(home, 'post-close-checks')
  closeLocal('apply', { request_id: 'plan', expected_revision: 0, command: {
    action: 'propose_plan', plan_id: 'plan', plan: {
      goal: 'Retain reviewed changes and verify the new candidate', completion_scope: 'task', remaining_scope: [], scope: ['.'], non_goals: ['Network'], risk: 'normal',
      steps: [{ id: 'fix', title: 'Verify sum', scope: ['.'], depends_on: [], acceptance_ids: ['sum'] }],
      acceptance: [{
        id: 'sum', description: 'Compute sum of positive, empty and signed input', kind: 'command', required: true, independent: false,
        command: { executable: process.execPath, timeout_ms: 2000, max_output_bytes: 4096, argv: ['-e', `
          const fs=require('node:fs'),a=require('node:assert/strict'),sum=require('./sum.cjs');
          fs.appendFileSync(${JSON.stringify(closeCounter)},'run\\n');
          a.equal(sum([2,3]),5);a.equal(sum([]),0);a.equal(sum([-2,2]),0);
        `] },
      }],
    },
  } })
  closeLocal('apply', { request_id: 'confirm', expected_revision: revision(), command: {
    action: 'confirm_plan', plan_id: 'plan', digest: workflow().plans[0].digest, confirmation: 'fixture:confirmed-plan',
  } })
  closeLocal('bind', { request_id: 'bind', expected_revision: revision(), attempt_id: 'attempt', owner: 'scripted-host', workspace })
  const closeYield = () => closeLocal('yield', {
    request_id: `yield-${revision()}`, expected_revision: revision(), actor: 'scripted-host',
    observed_operations: workflow().operations.map(operation => operation.id), note: 'Only the fixture controller writes these files.',
  })
  closeYield()
  assert.equal(closeLocal('check', { request_id: 'initial', operation_id: 'initial', acceptance_id: 'sum',
    actor: 'runner', expected_revision: revision() }).outcome, 'passed')
  const remoteIntent = {
    closure_id: 'remote-fixture', expected_revision: revision(), mode: 'verified', acknowledged_gaps: [],
    decision: 'fixture:prepare-without-publication', note: 'Seeded receipt is not a real GitHub close',
    target: { kind: 'issue', repo, issue_number: 42, comment_digest: createHash('sha256').update('').digest('hex') },
  }
  assert.match(closeLocal('close', remoteIntent, false).error.message, /remote receipt/i)
  assert.equal(workflow().closings[0].state, 'prepared')
  // Simulate a historical journal, not a live GitHub operation or authenticated receipt.
  const [closeOwner, closeName] = repo.split('/')
  const journalDigest = createHash('sha256').update(`${repo}#42\0${closeTodo.id}\0${closeExecution}`).digest('hex').slice(0, 24)
  mkdirSync(join(directory, '.operations'), { recursive: true })
  const journalPath = join(directory, '.operations', `issue-close-${journalDigest}.json`)
  writeFileSync(journalPath, JSON.stringify({
    owner: closeOwner, repo: closeName, issueNumber: 42, todoId: closeTodo.id, executionId: closeExecution,
    lifecycleRevision: closeTodo.lifecycle_revision ?? 0,
    state: 'closed', startedAt: new Date().toISOString(), remoteClosedAt: new Date().toISOString(), closureId: remoteIntent.closure_id,
    dispatch: { version: 1, initializedAt: new Date().toISOString(),
      commentDigest: remoteIntent.target.comment_digest, effects: [] },
  }))
  const keptFile = join(workspace, 'retained-user-change.txt')
  writeFileSync(keptFile, 'preserve this reviewed content')
  const continuation = {
    closure_id: remoteIntent.closure_id, request_id: 'local-continuation', expected_revision: revision(), actor: 'scripted-host',
    decision: 'fixture:keep-remote-state-and-continue-locally',
    report: {
      source: 'host_report', actor: 'fixture-controller', locator: 'fixture:seeded-journal',
      observed_at: new Date().toISOString(), reviewed_candidate: closeLocal('inspect').candidate.digest,
      raw: 'The fixture synchronously wrote the simulated journal and retained file; no HTTP request was sent.',
      quiescence_basis: 'No GitHub publisher or other file writers exist in this fixture.',
      changes_review: 'Read retained-user-change.txt and preserve its full contents.', unresolved: [],
    },
  }
  const continued = closeLocal('reconcile-close', continuation)
  assert.equal(continued.verification, 'not_verified')
  assert.equal(workflow().closing_id, null)
  assert.equal(workflow().yield, null)
  assert.equal(workflow().checks.length, 1)
  assert.equal(existsSync(journalPath), false)
  assert.equal(closeLocal('reconcile-close', continuation).reconciliation_receipt, continued.reconciliation_receipt)
  closeLocal('close', remoteIntent, false)
  assert.equal(readFileSync(closeCounter, 'utf8'), 'run\n')
  assert.equal(readFileSync(keptFile, 'utf8'), 'preserve this reviewed content')
  closeYield()
  assert.equal(closeLocal('inspect').readiness.ready, false)
  assert.equal(closeLocal('check', { request_id: 'fresh', operation_id: 'fresh', acceptance_id: 'sum',
    actor: 'runner', expected_revision: revision() }).outcome, 'passed')
  assert.equal(readFileSync(closeCounter, 'utf8'), 'run\nrun\n')
  closeLocal('close', {
    closure_id: 'local-finish', expected_revision: revision(), mode: 'verified', acknowledged_gaps: [],
    decision: 'fixture:finish-local-task', note: 'New candidate passed actual arithmetic assertions', target: { kind: 'local' },
  })
  assert.equal(store.list()[0].status, 'done')
  assert.equal(store.listArchived().length, 2)
  store.archiveAndDelete(0)
  assert.equal(store.list().length, 0)
  assert.equal(store.listArchived().length, 3)
  assert.equal(readFileSync(keptFile, 'utf8'), 'preserve this reviewed content')
  mark('A seeded remote-close journal supports local continuation across CLI processes, retaining files and requiring fresh checks')

  const occupant = (root, actor) => {
    const path = join(root, ...repo.split('/'))
    const ownerStore = new TodoStore(path)
    const todo = ownerStore.add({ ref: actor, title: 'Preserve unfinished work', type: 'feature' })
    const execution = ownerStore.activateExecution(0).execution
    writeFileSync(join(path, 'config.yaml'), 'fork: null\nupstream: null\n')
    const context = { todo_id: todo.id, execution_id: execution.id }
    const state = () => ownerStore.list()[0].executions[0].workflow
    const invoke = (action, payload, success = true) => local(action, { ...context, ...payload }, success, root)
    invoke('apply', { request_id: 'plan', expected_revision: 0, command: {
      action: 'propose_plan', plan_id: 'plan', plan: {
        goal: 'Only the owner can change the unfinished source', completion_scope: 'task', remaining_scope: [], non_goals: ['Network'], scope: ['sum.cjs'], risk: 'normal',
        steps: [{ id: 'edit', title: 'Edit', scope: ['sum.cjs'], depends_on: [], acceptance_ids: ['content'] }],
        acceptance: [{ id: 'content', description: 'Inspect actual content', kind: 'manual', required: true, independent: false }],
      },
    } })
    invoke('apply', { request_id: 'confirm', expected_revision: state().revision, command: {
      action: 'confirm_plan', plan_id: 'plan', digest: state().plans[0].digest, confirmation: 'fixture:user-plan',
    } })
    invoke('bind', { request_id: 'bind', expected_revision: state().revision, owner: actor, attempt_id: 'attempt', workspace })
    const apply = (command, success = true) => invoke('apply', {
      request_id: `${command.action}-${state().revision}`, expected_revision: state().revision, command,
    }, success)
    const begin = (success = true) => apply({
      action: 'begin_operation', operation_id: 'edit', kind: 'write', actor, delegated: false,
      step_id: 'edit', scope: ['sum.cjs'], purpose: 'Keep actual file exclusive',
    }, success)
    return { state, begin, apply }
  }
  const writerA = occupant(dataRoot, 'writer-a')
  const writerB = occupant(join(home, 'independent-root'), 'writer-b')
  writerA.begin()
  writeFileSync(join(workspace, 'sum.cjs'), '// writer-a unfinished\n')
  assert.match(writerB.begin(false).error.message, /occupied/i)
  assert.equal(readFileSync(join(workspace, 'sum.cjs'), 'utf8'), '// writer-a unfinished\n')
  assert.equal(writerB.state().operations.length, 0)
  writerA.apply({ action: 'return_operation', operation_id: 'edit', process_stopped: true,
    receipt: 'fixture:stopped-a', note: 'Actual fixture writer stopped' })
  assert.match(writerB.begin(false).error.message, /occupied/i)
  writerA.apply({ action: 'adopt_operation', operation_id: 'edit', actor: 'writer-a', decision: 'accepted',
    note: 'Fixture has inspected the unfinished contents; no delivery claim' })
  writerB.begin()
  writeFileSync(join(workspace, 'sum.cjs'), '// writer-b after release\n')
  assert.equal(readFileSync(join(workspace, 'sum.cjs'), 'utf8'), '// writer-b after release\n')
  writerB.apply({ action: 'return_operation', operation_id: 'edit', process_stopped: true,
    receipt: 'fixture:stopped-b', note: 'Actual fixture writer stopped' })
  writerB.apply({ action: 'adopt_operation', operation_id: 'edit', actor: 'writer-b', decision: 'accepted',
    note: 'Fixture inspected the resulting file; no delivery claim' })
  mark('Separate CLI data roots cannot overwrite live or unadopted work; the next writer can proceed after actual release')

  const stageTodo = store.add({ ref: 'stage-coverage', title: 'Deliver arithmetic and its UI', type: 'feature' })
  const stageExecution = store.activateExecution(store.list().findIndex(todo => todo.id === stageTodo.id)).execution.id
  const stageIdentity = { todo_id: stageTodo.id, execution_id: stageExecution }
  const stageState = () => store.resolveItemFromAll(stageTodo.id).executions[0].workflow
  const stageLocal = (action, payload = {}, success = true) => local(action, { ...stageIdentity, ...payload }, success)
  const stageApply = (requestId, command) => stageLocal('apply', {
    request_id: requestId, expected_revision: stageState()?.revision ?? 0, command,
  })
  const stagePlan = {
    goal: 'Implement and verify the arithmetic core', completion_scope: 'stage',
    remaining_scope: ['Implement and verify the user interface'], non_goals: ['Publishing'],
    scope: ['sum.cjs'], risk: 'normal',
    steps: [{ id: 'core', title: 'Implement core', scope: ['sum.cjs'], depends_on: [], acceptance_ids: ['behavior'] }],
    acceptance: [{ id: 'behavior', description: 'Invoke arithmetic with nonempty and empty inputs',
      required: true, kind: 'command', independent: false, command: {
        executable: process.execPath,
        argv: ['-e', "const a=require('node:assert/strict'),s=require('./sum.cjs');a.equal(s([2,3]),5);a.equal(s([]),0)"],
        timeout_ms: 2000, max_output_bytes: 4096,
      } }],
  }
  await call('todo_plan', { ...stageIdentity, request_id: 'stage-plan', expected_revision: 0,
    command: { action: 'propose_plan', plan_id: 'stage', plan: stagePlan } })
  stageApply('stage-confirm', { action: 'confirm_plan', plan_id: 'stage',
    digest: stageState().plans[0].digest, confirmation: 'fixture:user-confirms-stage-only' })
  stageLocal('bind', { request_id: 'bind', expected_revision: stageState().revision,
    owner: 'scripted-host', attempt_id: 'stage-attempt', workspace })
  stageApply('write', { action: 'begin_operation', operation_id: 'write', actor: 'scripted-host',
    kind: 'write', delegated: false, step_id: 'core', scope: ['sum.cjs'], purpose: 'Implement stage fixture' })
  writeFileSync(join(workspace, 'sum.cjs'), 'module.exports = values => values.reduce((sum, value) => sum + value, 0)\n')
  stageApply('return', { action: 'return_operation', operation_id: 'write', process_stopped: true,
    receipt: 'fixture:synchronous-stage-write', note: 'The only writer has returned' })
  stageApply('adopt', { action: 'adopt_operation', operation_id: 'write', actor: 'scripted-host',
    decision: 'accepted', note: 'Fixture owner reviewed arithmetic implementation' })
  stageLocal('yield', { request_id: 'yield', expected_revision: stageState().revision, actor: 'scripted-host',
    observed_operations: ['write'], note: 'All stage writes accounted for' })
  stageLocal('check', { request_id: 'check', expected_revision: stageState().revision, operation_id: 'check',
    acceptance_id: 'behavior', actor: 'local-runner' })
  const stageInspect = stageLocal('inspect')
  assert.equal(stageInspect.readiness.ready, true)
  assert.equal(stageInspect.completion_coverage.scope, 'stage')
  assert.equal(stageInspect.completion_coverage.scope_allows_task_completion, false)
  const stageContext = await call('todo_context', stageIdentity)
  assert.deepEqual(stageContext.completion_coverage.remaining_scope, stagePlan.remaining_scope)
  for (const mode of ['verified', 'with_gaps']) {
    const completion = { execution_id: stageExecution, closure_id: `stage-${mode}`, expected_revision: stageState().revision,
      mode, decision: 'fixture:cannot-accept-whole-task-from-stage', note: 'Stage only', acknowledged_gaps: [] }
    assert.match(stageLocal('close', { ...completion, target: { kind: 'local' } }, false).error.message, /coverage|stage/i)
    const response = await client.callTool({ name: 'todo_done', arguments: { repo, item: stageTodo.id, completion } })
    assert.equal(response.isError, true)
    assert.match(response.structuredContent.error.message, /coverage|stage/i)
  }
  assert.equal(stageState().closings.length, 0)
  assert.equal(store.resolveItemFromAll(stageTodo.id).status, 'active')
  assert.equal(stageState().checks.length, 1)
  await call('todo_control', { ...stageIdentity, request_id: 'request-pause', expected_revision: stageState().revision,
    command: { action: 'request_control', control_id: 'pause', kind: 'pause',
      decision: 'fixture:user-pauses', note: 'Pause after the stage checks' } })
  stageLocal('settle-pause', { request_id: 'settle-pause', expected_revision: stageState().revision,
    control_id: 'pause', actor: 'scripted-host' })
  assert.equal(store.resolveItemFromAll(stageTodo.id).status, 'paused')
  const pausedRevision = stageState().revision
  await call('todo_resume', stageIdentity)
  assert.equal(stageState().revision, pausedRevision)
  assert.equal(store.resolveItemFromAll(stageTodo.id).status, 'paused')
  stageLocal('continue', { request_id: 'continue', expected_revision: stageState().revision,
    control_id: 'pause', actor: 'scripted-host', decision: 'fixture:user-continues' })
  assert.equal(stageState().attempts.length, 1)
  assert.equal(stageState().checks.length, 1)
  assert.equal(stageState().yield, null)
  stageLocal('yield', { request_id: 'continued-yield', expected_revision: stageState().revision, actor: 'scripted-host',
    observed_operations: stageState().operations.map(operation => operation.id), note: 'Original work is accounted for' })
  assert.equal(stageLocal('inspect').readiness.ready, false)
  stageLocal('check', { request_id: 'continued-check', expected_revision: stageState().revision,
    operation_id: 'continued-check', acceptance_id: 'behavior', actor: 'local-runner' })
  assert.equal(stageLocal('inspect').readiness.ready, true)
  mark('Built MCP records stop; local pause and same-attempt continuation require fresh checks and context resume cannot unpause')
  await call('todo_control', { ...stageIdentity, request_id: 'request-cancel', expected_revision: stageState().revision,
    command: { action: 'request_control', control_id: 'cancel', kind: 'cancel',
      decision: 'fixture:user-cancels-remainder', note: 'End the remaining work explicitly' } })
  const stoppedStage = stageLocal('close', { closure_id: 'stop-stage', expected_revision: stageState().revision,
    mode: 'stopped', acknowledged_gaps: [], decision: 'fixture:user-cancels-remainder', note: 'Stop, not complete',
    target: { kind: 'local' } })
  assert.equal(stoppedStage.todo.status, 'cancelled')
  assert.equal(stoppedStage.archived, false)
  mark('Built MCP/CLI retain a fully checked stage, reject whole-task completion and allow explicit safe stopping')

  const unboundTodo = store.add({ ref: 'unbound-control', title: 'Pause design without creating a workspace', type: 'docs' })
  const unboundExecution = store.activateExecution(store.list().findIndex(todo => todo.id === unboundTodo.id)).execution.id
  const unbound = { todo_id: unboundTodo.id, execution_id: unboundExecution }
  await call('todo_control', { ...unbound, request_id: 'pause', expected_revision: 0, command: {
    action: 'request_control', control_id: 'pause', kind: 'pause', decision: 'fixture:pause-design', note: 'Pause discussion',
  } })
  local('settle-pause', { ...unbound, request_id: 'settle', expected_revision: 1, actor: 'scripted-host', control_id: 'pause' })
  const pausedDesign = await call('todo_context', unbound)
  assert.equal(pausedDesign.todo.status, 'paused')
  assert.equal(pausedDesign.execution.workflow.attempts.length, 0)
  assert.equal(pausedDesign.control.settled, true)
  local('continue', { ...unbound, request_id: 'continue', expected_revision: 2, actor: 'scripted-host',
    control_id: 'pause', decision: 'fixture:continue-design' })
  const continuedDesign = await call('todo_context', unbound)
  assert.equal(continuedDesign.todo.executions.length, 1)
  assert.equal(continuedDesign.execution.workflow.attempts.length, 0)
  mark('Built MCP and CLI pause unbound design and continue the same execution without fabricated workspace evidence')

  const linkedTodo = store.add({ ref: 'independent-pr-links', title: 'Keep delivery separate', type: 'feature' })
  const linkedIndex = store.list().findIndex(todo => todo.id === linkedTodo.id)
  store.update(linkedIndex, { status: 'backlog', pr: 41 })
  for (const pr of [42, 43, 42]) {
    const response = await client.callTool({ name: 'todo_update', arguments: { repo, item: linkedTodo.id, pr } })
    assert.notEqual(response.isError, true, JSON.stringify(response))
  }
  const associated = store.resolveItemById(linkedTodo.id).item
  assert.equal(associated.status, 'backlog')
  assert.equal(associated.pr, 42)
  assert.deepEqual(associated.pull_requests, [41, 42, 43].map(number => ({ repo, number })))
  await client.close()
  await transport.close()
  await connect()
  const listed = await client.callTool({ name: 'todo_list', arguments: { repo } })
  assert.notEqual(listed.isError, true, JSON.stringify(listed))
  const listText = listed.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
  for (const number of [41, 42, 43]) assert.ok(listText.includes(`/pull/${number}`))
  assert.equal(store.resolveItemById(linkedTodo.id).item.status, 'backlog')
  mark('Built MCP retains multiple PR links across restart without changing lifecycle or making network calls')

  const deliveryTodo = store.add({ ref: 'local-delivery', title: 'Deliver a local report', type: 'docs' })
  const deliveryExecution = store.activateExecution(store.list().findIndex(todo => todo.id === deliveryTodo.id)).execution.id
  const deliveryIdentity = { todo_id: deliveryTodo.id, execution_id: deliveryExecution }
  const deliveryState = () => store.resolveItemById(deliveryTodo.id).item.executions.at(-1).workflow
  const deliveryLocal = (action, payload = {}, success = true) => local(action, { ...deliveryIdentity, ...payload }, success)
  const deliveryPlan = {
    goal: 'Deliver the reviewed file', completion_scope: 'task', remaining_scope: [], non_goals: [],
    scope: ['delivery.md'], risk: 'normal',
    steps: [{ id: 'write', title: 'Write report', scope: ['delivery.md'], depends_on: [], acceptance_ids: ['review'] }],
    acceptance: [{ id: 'review', description: 'User inspects the report', required: true, kind: 'manual', independent: false }],
    deliverables: [{ id: 'report', description: 'The actual report file', required: true, acceptance_ids: ['review'],
      target: { kind: 'file', path: 'delivery.md' } }],
  }
  await call('todo_plan', { ...deliveryIdentity, request_id: 'plan', expected_revision: 0,
    command: { action: 'propose_plan', plan_id: 'plan', plan: deliveryPlan } })
  await call('todo_plan', { ...deliveryIdentity, request_id: 'confirm', expected_revision: deliveryState().revision,
    command: { action: 'confirm_plan', plan_id: 'plan', digest: deliveryState().plans[0].digest, confirmation: 'fixture:explicit-file-requirement' } })
  deliveryLocal('bind', { request_id: 'bind', expected_revision: deliveryState().revision, attempt_id: 'attempt', owner: 'scripted-host', workspace })
  const deliveryYield = suffix => deliveryLocal('yield', { request_id: `yield-${suffix}`, expected_revision: deliveryState().revision,
    actor: 'scripted-host', observed_operations: deliveryState().operations.map(operation => operation.id), note: 'Fixture writes stopped' })
  const deliveryReport = suffix => deliveryLocal('report', { request_id: `report-${suffix}`, expected_revision: deliveryState().revision,
    operation_id: `report-${suffix}`, acceptance_id: 'review', actor: 'fixture-user', source: 'user',
    outcome: 'passed', locator: `fixture:user-observation-${suffix}`, summary: 'Scripted user observation, not actual product acceptance',
    plan_id: deliveryState().plan_id, attempt_id: deliveryState().attempt_id, epoch: deliveryState().epoch,
    candidate: deliveryState().yield.candidate, observed_at: new Date().toISOString() })
  deliveryYield('missing')
  deliveryReport('missing')
  assert.deepEqual(deliveryLocal('inspect').readiness.gaps, ['delivery:report'])
  const completionForDelivery = (closure_id, mode) => ({ execution_id: deliveryExecution, closure_id,
    expected_revision: deliveryState().revision, mode, acknowledged_gaps: ['delivery:report'],
    decision: 'fixture:whole-task-decision', note: 'Fixture completion' })
  const refused = await client.callTool({ name: 'todo_done', arguments: {
    repo, item: deliveryTodo.id, completion: completionForDelivery('missing-file', 'verified'),
  } })
  assert.equal(refused.isError, true)
  assert.match(refused.structuredContent.error.message, /delivery:report/)
  assert.match(deliveryLocal('close', {
    ...completionForDelivery('no-waiver', 'with_gaps'), target: { kind: 'local' },
  }, false).error.message, /delivery:report/)
  writeFileSync(join(workspace, 'delivery.md'), 'Reviewed report in the exact candidate.\n')
  deliveryYield('present')
  assert.equal(deliveryLocal('inspect').readiness.ready, false)
  deliveryReport('present')
  const readyDelivery = deliveryLocal('inspect').readiness
  assert.equal(readyDelivery.ready, true)
  assert.equal(readyDelivery.deliveries[0].endpoint, 'present')
  await client.close()
  await transport.close()
  await connect()
  const deliveryContext = await call('todo_context', deliveryIdentity)
  assert.equal(deliveryContext.readiness, null)
  assert.equal(deliveryContext.workspace_observation, 'not_observed')
  assert.deepEqual(deliveryContext.delivery_requirements.items, deliveryPlan.deliverables)
  const finalDelivery = await client.callTool({ name: 'todo_done', arguments: {
    repo, item: deliveryTodo.id, completion: { ...completionForDelivery('delivered', 'verified'), acknowledged_gaps: [] },
  } })
  assert.notEqual(finalDelivery.isError, true, JSON.stringify(finalDelivery))
  assert.equal(store.resolveItemById(deliveryTodo.id).item.status, 'done')
  assert.ok(!store.listArchived().some(todo => todo.id === deliveryTodo.id))
  mark('Built MCP and CLI require the actual declared file, reject waivers, recheck changed candidates and retain declarations across restart')

  const committedTodo = store.add({ ref: 'committed-delivery', title: 'Commit the reviewed report', type: 'docs' })
  const committedExecution = store.activateExecution(store.list().findIndex(todo => todo.id === committedTodo.id)).execution.id
  const committedIdentity = { todo_id: committedTodo.id, execution_id: committedExecution }
  const committedState = () => store.resolveItemById(committedTodo.id).item.executions.at(-1).workflow
  const committedLocal = (action, payload = {}, success = true) => local(action, { ...committedIdentity, ...payload }, success)
  const committedPlan = { ...deliveryPlan, goal: 'The accepted report is in the captured local commit',
    deliverables: [{ id: 'commit', description: 'Committed report and matching index', required: true, acceptance_ids: ['review'],
      target: { kind: 'commit', scope: ['delivery.md'] } }] }
  await call('todo_plan', { ...committedIdentity, request_id: 'plan', expected_revision: 0,
    command: { action: 'propose_plan', plan_id: 'plan', plan: committedPlan } })
  await call('todo_plan', { ...committedIdentity, request_id: 'confirm', expected_revision: committedState().revision,
    command: { action: 'confirm_plan', plan_id: 'plan', digest: committedState().plans[0].digest, confirmation: 'fixture:explicit-commit-requirement' } })
  committedLocal('bind', { request_id: 'bind', expected_revision: committedState().revision, attempt_id: 'attempt', owner: 'scripted-host', workspace })
  const committedYield = suffix => committedLocal('yield', { request_id: `yield-${suffix}`, expected_revision: committedState().revision,
    actor: 'scripted-host', observed_operations: committedState().operations.map(operation => operation.id), note: 'Fixture writes stopped' })
  const committedReport = suffix => committedLocal('report', { request_id: `report-${suffix}`, expected_revision: committedState().revision,
    operation_id: `report-${suffix}`, acceptance_id: 'review', actor: 'fixture-user', source: 'user', outcome: 'passed',
    locator: `fixture:commit-observation-${suffix}`, summary: 'Scripted content report, not commit proof',
    plan_id: committedState().plan_id, attempt_id: committedState().attempt_id, epoch: committedState().epoch,
    candidate: committedState().yield.candidate, observed_at: new Date().toISOString() })
  committedYield('before')
  committedReport('before')
  assert.deepEqual(committedLocal('inspect').readiness.gaps, ['delivery:commit'])
  assert.match(committedLocal('close', {
    closure_id: 'uncommitted', expected_revision: committedState().revision, mode: 'with_gaps',
    acknowledged_gaps: ['delivery:commit'], target: { kind: 'local' }, decision: 'fixture:whole-task', note: 'Cannot waive endpoint',
  }, false).error.message, /delivery:commit/)
  // The fixture makes its own commit. Product inspection must never do this.
  git('add', '--', 'delivery.md')
  git('commit', '--quiet', '-m', 'Isolated report delivery')
  committedYield('after')
  assert.deepEqual(committedLocal('inspect').readiness.gaps, ['acceptance:review'])
  committedReport('after')
  const commitObservation = committedLocal('inspect').readiness
  assert.equal(commitObservation.ready, true)
  assert.equal(commitObservation.deliveries[0].commit.oid, git('rev-parse', 'HEAD').toString().trim())
  assert.equal(commitObservation.deliveries[0].commit.tree, git('rev-parse', 'HEAD^{tree}').toString().trim())
  await client.close()
  await transport.close()
  await connect()
  assert.deepEqual((await call('todo_context', committedIdentity)).delivery_requirements.items, committedPlan.deliverables)
  const committedResult = await client.callTool({ name: 'todo_done', arguments: {
    repo, item: committedTodo.id, completion: { execution_id: committedExecution, closure_id: 'committed',
      expected_revision: committedState().revision, mode: 'verified', acknowledged_gaps: [],
      decision: 'fixture:whole-task', note: 'Actual fixture commit and fresh acceptance' },
  } })
  assert.notEqual(committedResult.isError, true, JSON.stringify(committedResult))
  assert.equal(store.resolveItemById(committedTodo.id).item.status, 'done')
  assert.ok(!store.listArchived().some(todo => todo.id === committedTodo.id))
  mark('Built MCP and CLI reject uncommitted delivery, invalidate pre-commit acceptance and verify the exact local commit across restart')

  await client.close()
  await transport.close()
  const githubState = join(home, 'github-readback.json')
  const githubCalls = join(home, 'github-readback-calls.txt')
  const githubFixture = fileURLToPath(new URL('./fixtures/github-readback.mjs', import.meta.url))
  env.CONTRIBBOT_SMOKE_GITHUB_STATE = githubState
  env.CONTRIBBOT_SMOKE_GITHUB_CALLS = githubCalls
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import "${pathToFileURL(githubFixture).href}"`
  const remoteOid = 'a'.repeat(40)
  const remoteTree = 'd'.repeat(40)
  const remoteBlob = git('rev-parse', 'HEAD:delivery.md').toString().trim()
  const pullResponse = number => ({
    number, merged: number === 52, state: number === 52 ? 'closed' : 'open', draft: false,
    merged_at: number === 52 ? '2026-09-19T00:00:00Z' : null,
    merge_commit_sha: number === 52 ? remoteOid : null,
    head: { ref: 'fixture', sha: remoteOid, repo: { full_name: repo } },
    base: { ref: 'main', sha: 'c'.repeat(40), repo: { full_name: repo } },
  })
  const routes = {
    [`/repos/${repo}/pulls/51`]: { body: pullResponse(51) },
    [`/repos/${repo}/pulls/52`]: { status: 403, body: { message: 'Fixture access unavailable' } },
    [`/repos/${repo}/git/ref/heads%2Fmain`]: { body: { ref: 'refs/heads/main', object: { type: 'commit', sha: remoteOid } } },
    [`/repos/${repo}/git/commits/${remoteOid}`]: { body: { sha: remoteOid, tree: { sha: remoteTree } } },
    [`/repos/${repo}/git/trees/${remoteTree}`]: { body: {
      sha: remoteTree, truncated: false, tree: [{ path: 'delivery.md', mode: '100644', type: 'blob', sha: remoteBlob }],
    } },
  }
  writeFileSync(githubState, JSON.stringify(routes))
  await connect()
  const remoteTodo = store.add({ ref: 'remote-delivery', title: 'Verify remote delivery', type: 'chore' })
  const remoteExecution = store.activateExecution(store.list().findIndex(todo => todo.id === remoteTodo.id)).execution.id
  const remoteIdentity = { todo_id: remoteTodo.id, execution_id: remoteExecution }
  const remoteState = () => store.resolveItemById(remoteTodo.id).item.executions.at(-1).workflow
  const remoteLocal = (action, payload = {}, success = true) => local(action, { ...remoteIdentity, ...payload }, success)
  const remotePlan = { ...deliveryPlan, goal: 'Verify three explicitly declared remote endpoints',
    deliverables: [
      { id: 'push', description: 'Remote branch content', required: true, acceptance_ids: ['review'],
        target: { kind: 'remote_ref', repo, ref: 'refs/heads/main', scope: ['delivery.md'] } },
      ...[51, 52].map(number => ({ id: `pr-${number}`, description: 'Explicit PR endpoint', required: true, acceptance_ids: ['review'],
        target: { kind: 'remote_pull', repo, number, base: 'main', endpoint: number === 51 ? 'submitted' : 'merged',
          scope: ['delivery.md'], allow_draft: false } })),
    ] }
  await call('todo_plan', { ...remoteIdentity, request_id: 'plan', expected_revision: 0,
    command: { action: 'propose_plan', plan_id: 'plan', plan: remotePlan } })
  await call('todo_plan', { ...remoteIdentity, request_id: 'confirm', expected_revision: remoteState().revision,
    command: { action: 'confirm_plan', plan_id: 'plan', digest: remoteState().plans[0].digest, confirmation: 'fixture:remote-requirements' } })
  remoteLocal('bind', { request_id: 'bind', expected_revision: remoteState().revision, attempt_id: 'attempt', owner: 'scripted-host', workspace })
  remoteLocal('yield', { request_id: 'yield', expected_revision: remoteState().revision,
    actor: 'scripted-host', observed_operations: [], note: 'Fixture writers stopped' })
  remoteLocal('report', { request_id: 'report', expected_revision: remoteState().revision, operation_id: 'report',
    acceptance_id: 'review', actor: 'fixture-user', source: 'user', outcome: 'passed',
    locator: 'fixture:reported-merged', summary: 'Content accepted; merge only reported, not verified.',
    plan_id: remoteState().plan_id, attempt_id: remoteState().attempt_id, epoch: remoteState().epoch,
    candidate: remoteState().yield.candidate, observed_at: new Date().toISOString() })
  assert.deepEqual((await call('todo_context', remoteIdentity)).delivery_requirements.items, remotePlan.deliverables)
  assert.deepEqual(remoteLocal('inspect').readiness.gaps, ['delivery:pr-52'])
  assert.match(remoteLocal('close', {
    closure_id: 'unverified-remote', expected_revision: remoteState().revision, mode: 'with_gaps',
    acknowledged_gaps: ['delivery:pr-52'], target: { kind: 'local' }, decision: 'fixture:finish', note: 'Cannot waive remote delivery',
  }, false).error.message, /delivery:pr-52/)
  routes[`/repos/${repo}/pulls/52`] = { body: pullResponse(52) }
  writeFileSync(githubState, JSON.stringify(routes))
  assert.equal(remoteLocal('inspect').readiness.ready, true)
  routes[`/repos/${repo}/git/trees/${remoteTree}`].body.tree[0].sha = 'e'.repeat(40)
  writeFileSync(githubState, JSON.stringify(routes))
  const remoteCompletion = { execution_id: remoteExecution, closure_id: 'remote-wrong-content',
    expected_revision: remoteState().revision, mode: 'verified', acknowledged_gaps: [],
    decision: 'fixture:finish', note: 'Explicit completion with fresh remote verification' }
  const remoteRefused = await client.callTool({ name: 'todo_done', arguments: {
    repo, item: remoteTodo.id, completion: remoteCompletion,
  } })
  assert.equal(remoteRefused.isError, true)
  assert.match(remoteRefused.structuredContent.error.message, /delivery:/)
  routes[`/repos/${repo}/git/trees/${remoteTree}`].body.tree[0].sha = remoteBlob
  writeFileSync(githubState, JSON.stringify(routes))
  remoteCompletion.closure_id = 'remote-verified'
  remoteCompletion.expected_revision = remoteState().revision
  const remoteCompleted = await client.callTool({ name: 'todo_done', arguments: {
    repo, item: remoteTodo.id, completion: remoteCompletion,
  } })
  assert.notEqual(remoteCompleted.isError, true, JSON.stringify(remoteCompleted))
  assert.equal(store.resolveItemById(remoteTodo.id).item.status, 'done')
  const callsBeforeReplay = readFileSync(githubCalls, 'utf8')
  await client.callTool({ name: 'todo_done', arguments: { repo, item: remoteTodo.id, completion: remoteCompletion } })
  assert.equal(readFileSync(githubCalls, 'utf8'), callsBeforeReplay)
  assert.ok(!store.listArchived().some(todo => todo.id === remoteTodo.id))
  mark('Built CLI/MCP query simulated GitHub endpoints, reject reports and wrong content, recheck before completion and preserve completed replay')

  for (const [controlKind, observedState] of [['cancel', 'open'], ['cancel', 'closed'], ['pause', 'open'], ['pause', 'closed']]) {
    const cancelledTodo = store.add({ ref: `${controlKind}-issue-${observedState}`, title: 'Stop locally while preserving Issue facts', type: 'chore' })
    const cancelledExecution = store.activateExecution(store.list().findIndex(todo => todo.id === cancelledTodo.id)).execution.id
    const cancelledIdentity = { todo_id: cancelledTodo.id, execution_id: cancelledExecution }
    const cancelledState = () => store.resolveItemById(cancelledTodo.id).item.executions.at(-1).workflow
    const cancelledLocal = (action, payload = {}, success = true) => local(action, { ...cancelledIdentity, ...payload }, success)
    const plan = { ...deliveryPlan, goal: 'Keep the accepted work and account for an interrupted Issue close', deliverables: [] }
    await call('todo_plan', { ...cancelledIdentity, request_id: 'plan', expected_revision: 0,
      command: { action: 'propose_plan', plan_id: 'plan', plan } })
    await call('todo_plan', { ...cancelledIdentity, request_id: 'confirm', expected_revision: cancelledState().revision,
      command: { action: 'confirm_plan', plan_id: 'plan', digest: cancelledState().plans[0].digest, confirmation: 'fixture:original-plan' } })
    cancelledLocal('bind', { request_id: 'bind', expected_revision: cancelledState().revision,
      attempt_id: 'attempt', owner: 'scripted-host', workspace })
    cancelledLocal('yield', { request_id: 'yield', expected_revision: cancelledState().revision,
      actor: 'scripted-host', observed_operations: [], note: 'Fixture writers stopped' })
    cancelledLocal('report', { request_id: 'report', expected_revision: cancelledState().revision,
      operation_id: 'report', acceptance_id: 'review', actor: 'fixture-user', source: 'user', outcome: 'passed',
      locator: 'fixture:content-review', summary: 'Scripted original content acceptance',
      plan_id: cancelledState().plan_id, attempt_id: cancelledState().attempt_id, epoch: cancelledState().epoch,
      candidate: cancelledState().yield.candidate, observed_at: new Date().toISOString() })
    const target = { kind: 'issue', repo, issue_number: 43, comment_digest: createHash('sha256').update('').digest('hex') }
    assert.match(cancelledLocal('close', { closure_id: 'original', expected_revision: cancelledState().revision,
      mode: 'verified', acknowledged_gaps: [], decision: 'fixture:original-close', note: 'Prepare without dispatch', target,
    }, false).error.message, /remote receipt/i)
    // Seed an explicitly simulated returned response; this is not a real Issue mutation.
    const at = new Date().toISOString()
    const digest = createHash('sha256').update(`${repo}#43\0${cancelledTodo.id}\0${cancelledExecution}`).digest('hex').slice(0, 24)
    const journal = join(directory, '.operations', `issue-close-${digest}.json`)
    writeFileSync(journal, JSON.stringify({
      owner: closeOwner, repo: closeName, issueNumber: 43, todoId: cancelledTodo.id, executionId: cancelledExecution,
      lifecycleRevision: cancelledTodo.lifecycle_revision ?? 0,
      state: 'closed', startedAt: at, remoteClosedAt: at, closureId: 'original',
      dispatch: { version: 1, initializedAt: at, commentDigest: target.comment_digest,
        effects: [{ kind: 'close', admittedAt: at, returnedAt: at, result: { kind: 'close', state: 'closed' } }] },
    }))
    routes[`/repos/${repo}/issues/43`] = { body: { number: 43, state: observedState } }
    routes[`/repos/${repo}/issues/43/comments`] = { body: [] }
    writeFileSync(githubState, JSON.stringify(routes))
    await call('todo_control', { ...cancelledIdentity, request_id: controlKind, expected_revision: cancelledState().revision,
      command: { action: 'request_control', control_id: controlKind, kind: controlKind,
        decision: `fixture:${controlKind}`, note: 'Stop local work without changing Issue facts' } })
    const request = { closure_id: 'original', control_id: controlKind, request_id: 'reconcile',
      expected_revision: cancelledState().revision, actor: 'scripted-host', decision: `fixture:${controlKind}`,
      report: { source: 'host_report', actor: 'fixture-controller', locator: 'fixture:simulated-close-response',
        observed_at: new Date().toISOString(), reviewed_candidate: cancelledLocal('inspect').candidate.digest,
        raw: 'Fixture seeded the exact returned-response ledger; no public request was sent.',
        quiescence_basis: 'Only synchronous fixture writes occurred and no publisher exists.', unresolved: [] } }
    const accounted = cancelledLocal('reconcile-close', request)
    assert.equal(accounted.verification, 'not_verified')
    assert.equal(cancelledState().control.active_id, controlKind)
    assert.equal(cancelledState().closing_id, null)
    assert.equal(store.resolveItemById(cancelledTodo.id).item.status, 'active')
    assert.equal(existsSync(journal), false)
    const calls = readFileSync(githubCalls, 'utf8')
    assert.equal(cancelledLocal('reconcile-close', request).reconciliation_receipt, accounted.reconciliation_receipt)
    cancelledLocal('yield', { request_id: 'yield-cancel', expected_revision: cancelledState().revision,
      actor: 'scripted-host', observed_operations: ['report'], note: 'All original fixture operations accounted for' })
    if (controlKind === 'cancel') {
      const closed = cancelledLocal('close', { closure_id: 'cancel-local', expected_revision: cancelledState().revision,
        mode: 'stopped', acknowledged_gaps: [], decision: 'fixture:cancel', note: 'Keep partial work', target: { kind: 'local' } })
      assert.equal(closed.todo.status, 'cancelled')
      assert.equal(closed.archived, false)
    }
    else {
      const checks = cancelledState().checks
      cancelledLocal('settle-pause', { request_id: 'settle', expected_revision: cancelledState().revision,
        control_id: 'pause', actor: 'scripted-host' })
      assert.equal(store.resolveItemById(cancelledTodo.id).item.status, 'paused')
      cancelledLocal('continue', { request_id: 'continue', expected_revision: cancelledState().revision,
        control_id: 'pause', actor: 'scripted-host', decision: 'fixture:continue-work-only' })
      assert.equal(store.resolveItemById(cancelledTodo.id).item.status, 'active')
      assert.equal(store.resolveItemById(cancelledTodo.id).item.executions.at(-1).id, cancelledExecution)
      assert.equal(cancelledState().attempt_id, 'attempt')
      assert.equal(cancelledState().closing_id, null)
      assert.equal(cancelledState().closure, null)
      assert.equal(cancelledState().yield, null)
      assert.deepEqual(cancelledState().checks, checks)
      assert.equal(cancelledLocal('inspect').readiness.ready, false)
      assert.equal(cancelledLocal('reconcile-close', request).reconciliation_receipt, accounted.reconciliation_receipt)
    }
    assert.ok(!store.listArchived().some(todo => todo.id === cancelledTodo.id))
    assert.equal(readFileSync(githubCalls, 'utf8'), calls)
    assert.equal(readFileSync(join(workspace, 'delivery.md'), 'utf8'), 'Reviewed report in the exact candidate.\n')
    mark(`Built MCP ${controlKind} and CLI reconciliation retain an observed-${observedState} Issue without archival or new remote effects`)
  }

  const plainTodo = store.add({ ref: 'plain-cancellation', title: 'Cancel without invented execution', type: 'chore' })
  const plainRequest = { repo, todo_id: plainTodo.id, expected_lifecycle_revision: 0, decision: 'fixture:cancel-unstarted-task' }
  const plainResponse = await client.callTool({ name: 'todo_cancel', arguments: plainRequest })
  assert.notEqual(plainResponse.isError, true, JSON.stringify(plainResponse))
  assert.equal(plainResponse.structuredContent.todo.status, 'cancelled')
  assert.deepEqual(plainResponse.structuredContent.todo.executions, [])
  assert.equal(plainResponse.structuredContent.archived, false)
  const plainSnapshot = readFileSync(join(directory, 'todos.yaml'), 'utf8')
  assert.notEqual((await client.callTool({ name: 'todo_cancel', arguments: plainRequest })).isError, true)
  assert.equal(readFileSync(join(directory, 'todos.yaml'), 'utf8'), plainSnapshot)
  assert.notEqual((await client.callTool({ name: 'todo_reopen', arguments: { repo, item: plainTodo.id } })).isError, true)
  const reopenedSnapshot = readFileSync(join(directory, 'todos.yaml'), 'utf8')
  assert.equal((await client.callTool({ name: 'todo_cancel', arguments: plainRequest })).isError, true)
  assert.equal(readFileSync(join(directory, 'todos.yaml'), 'utf8'), reopenedSnapshot)
  mark('Built MCP cancels an unstarted task without execution or archival and rejects stale cancellation after reopening')
  for (const status of ['pr_submitted', 'not_planned']) {
    assert.equal((await client.callTool({ name: 'todo_update', arguments: {
      repo, item: plainTodo.id, status, branch: 'must-not-change', note: 'Must not be saved',
    } })).isError, true)
    assert.equal((await client.callTool({ name: 'todo_list', arguments: { repo, status } })).isError, true)
    assert.equal(readFileSync(join(directory, 'todos.yaml'), 'utf8'), reopenedSnapshot)
  }
  mark('Built MCP rejects removed Todo state updates and filters before any metadata writes')

  console.log(JSON.stringify({
    schema_version: 1, outcome: 'passed', runtime: sourceSkill ? 'source-skill' : 'build', results, platform: process.platform,
    limitations: [
      'The host and user decisions are scripted fixture inputs, not a live AI or human acceptance session.',
      'Interruption reconciliation uses a fixture known to spawn no descendants; arbitrary process-tree termination, delegated-agent integration and live GitHub effects are not verified.',
      'Remote-close continuation uses a seeded historical journal; no real GitHub request or authenticated publisher is verified.',
      'Issue pause/cancellation use seeded dispatch results and simulated readbacks, not a real interrupted GitHub mutation.',
      'Remote delivery uses a Node preload replacing fetch; no real GitHub response or gh CLI backend is verified by that scenario.',
      'No real tracked repository, personal contribbot data or runtime configuration was changed.',
    ],
  }, null, 2))
}
catch (error) {
  console.error(error)
  process.exitCode = 1
}
finally {
  await finishCrashFixture?.()
  await client?.close()
  await transport?.close()
  const path = resolve(home)
  const rel = relative(resolve(tmpdir()), path)
  if (!rel.startsWith('contribbot-execution-smoke-') || rel.includes(sep)) {
    throw new Error('Refusing cleanup outside the owned temporary fixture.')
  }
  for (const { destination } of sourceSetup?.links || []) {
    if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) unlinkSync(destination)
  }
  for (const link of sourceLinks) {
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link)
  }
  rmSync(path, { recursive: true, force: true })
}
