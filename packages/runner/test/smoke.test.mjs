import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { describeProcessAsync, executableDigest, localMachine } from 'contribbot-agent-runtime'
import { digest } from 'contribbot-core'
import { createConsultStore } from '../dist/composition.js'

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(directory, '..', '..')
const cli = resolve(directory, 'dist', 'cli.js')
const sourceCli = resolve(directory, 'src', 'cli.ts')
const sourceLauncher = resolve(repository, 'skills/consult/scripts/contribbot-run.mjs')
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
const packageJson = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))

function binding(executable, executableDigestValue = digest('runner-fixture'), runtime = 'claude') {
  const disclosure = 'Runner fixture; no model call is expected.'
  return {
    runtime, executable, executable_digest: executableDigestValue,
    runtime_version: 'fixture', binding_version: '1', model: null,
    protocol: 'native-oneshot', transport: 'pipe', execution_location: 'local', model_location: 'unknown',
    write_boundary: runtime === 'claude' ? 'tool_free' : 'sandbox_read_only',
    read_boundary: runtime === 'claude' ? 'tools_disabled' : 'not_confined',
    disclosure, disclosure_digest: digest(disclosure),
  }
}

function reserve(store, id = 'runner-turn') {
  return store.reserve({
    request_id: `${id}-request`, discussion_id: `${id}-discussion`, purpose: 'design', mode: 'fresh',
    todo_id: null, expected_todo: null,
    packet: {
      workspace: store.directory, head: null, manifest: [], body: 'Runner fixture question',
      digest: digest('Runner fixture question'), omitted: [],
    },
    binding: binding(process.execPath),
    authorization: { explicit_once: { source: 'runner-test', statement: 'Run one bounded test turn.' } },
  })
}

async function waitForSettled(store, discussionId, timeout = 20_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const turn = store.get(discussionId).turns[0]
    if (turn.lifecycle === 'settled' || turn.lifecycle === 'reconciled_by_attestation') return turn
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${turn.lifecycle} turn to settle.`)
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
}

function runNode(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repository, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...options,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolvePromise({ code, stdout, stderr }))
  })
}

test('runner package is a private wiring boundary', () => {
  assert.equal(packageJson.name, 'contribbot-runner')
  assert.equal(packageJson.private, true)
  assert.match(readFileSync(resolve(directory, 'src/index.ts'), 'utf8'), /PACKAGE_BOUNDARY/)
  assert.match(packageJson.scripts.build, /compile-package/)
  assert.equal(packageJson.dependencies['contribbot-mcp'], undefined)
  assert.doesNotMatch(readFileSync(resolve(directory, 'src/composition.ts'), 'utf8'), /contribbot-mcp/)
})

test('built CLI returns a structured error instead of starting an unspecified task', () => {
  assert.equal(existsSync(cli), true, 'runner dist must be built before runner tests')
  const result = spawnSync(process.execPath, [cli], { cwd: repository, encoding: 'utf8', windowsHide: true, shell: false })
  assert.equal(result.status, 1)
  assert.equal(result.stderr, '')
  const output = JSON.parse(result.stdout)
  assert.equal(output.schema_version, 1)
  assert.equal(output.error.code, 'runner_error')
  assert.match(output.error.message, /usage/i)
})

test('source and dist worker commands propagate the matching dependency resolution into a child', async () => {
  for (const source of [false, true]) {
    const supervisor = pathToFileURL(resolve(directory, source ? 'src/supervisor.ts' : 'dist/supervisor.js')).href
    const program = `
      import { spawnSync } from 'node:child_process';
      const {workerCommand} = await import(${JSON.stringify(supervisor)});
      const command = workerCommand();
      const code = "import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url'; const paths=['contribbot-core','contribbot-agent-runtime','contribbot-runner/worker'].map(name => import.meta.resolve(name)); paths.push(pathToFileURL(createRequire(import.meta.resolve('contribbot-agent-runtime')).resolve('contribbot-platform')).href); console.log(JSON.stringify(paths));";
      const result = spawnSync(command.executable, [...command.argv.slice(0,-1), '--input-type=module', '--eval', code], {cwd:${JSON.stringify(directory)}, encoding:'utf8', windowsHide:true, shell:false});
      if (result.status !== 0) throw new Error(result.stderr);
      console.log(JSON.stringify({worker:command.argv.at(-1), paths:JSON.parse(result.stdout)}));
    `
    const result = await runNode([
      ...(source ? ['--conditions=contribbot-source', '--import', tsx] : []),
      '--input-type=module', '--eval', program,
    ])
    assert.equal(result.code, 0, result.stderr + result.stdout)
    const output = JSON.parse(result.stdout)
    assert.match(output.worker, source ? /src[/\\]consult-worker\.ts$/ : /dist[/\\]consult-worker\.js$/)
    for (const path of output.paths) assert.match(path, source ? /\/src\/.*\.ts$/ : /\/dist\/.*\.js$/)
  }
})

test('CLI discovery is read-only and malformed arguments always return JSON', async () => {
  const home = mkdtempSync(join(tmpdir(), 'contribbot-runner-discovery-'))
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home }
    const discovery = await runNode([cli, '--schema'], { env })
    assert.equal(discovery.code, 0, discovery.stderr + discovery.stdout)
    const schema = JSON.parse(discovery.stdout)
    assert.equal(schema.kind, 'contribbot-runner')
    assert.ok(schema.commands.includes('consult reconcile'))
    assert.equal(existsSync(join(home, '.contribbot')), false)
    for (const args of [['--invalid'], ['consult', 'observe', '--expected-revision', '-1'], ['extra', 'words', 'ignored']]) {
      const result = await runNode([cli, ...args], { env })
      assert.equal(result.code, 1)
      assert.equal(result.stderr, '')
      assert.equal(JSON.parse(result.stdout).error.code, 'runner_error')
    }
  }
  finally { rmSync(home, { recursive: true, force: true }) }
})

test('start rejects a missing exact turn without launching an untracked worker', async () => {
  const home = mkdtempSync(join(tmpdir(), 'contribbot-runner-missing-'))
  try {
    const result = await runNode([cli, 'consult', 'start', '--directory', home, '--discussion', 'missing', '--turn', 'missing'])
    assert.equal(result.code, 1)
    assert.match(JSON.parse(result.stdout).error.message, /not found/i)
    assert.equal(existsSync(join(home, 'consult')), false)
  }
  finally { rmSync(home, { recursive: true, force: true }) }
})

test('CLI observes actual processes and reconciles only a fresh explicit operator report', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'contribbot-runner-reconcile-'))
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, shell: false })
  const closed = once(child, 'close')
  await once(child, 'spawn')
  try {
    const store = createConsultStore(home)
    const reserved = reserve(store)
    const handle = await describeProcessAsync(child.pid)
    store.claim(reserved.discussion_id, reserved.turn.id, handle)
    store.dispatch(reserved.discussion_id, reserved.turn.id, () => undefined)
    const args = ['--directory', home, '--discussion', reserved.discussion_id, '--turn', reserved.turn.id]
    const revision = store.get(reserved.discussion_id).revision
    const live = await runNode([cli, 'consult', 'observe', ...args, '--expected-revision', String(revision)])
    assert.equal(live.code, 1)
    assert.match(JSON.parse(live.stdout).error.message, /running|unknown/i)
    child.kill()
    await closed
    const stopped = await runNode([cli, 'consult', 'observe', ...args, '--expected-revision', String(revision)])
    assert.equal(stopped.code, 0, stopped.stderr + stopped.stdout)
    const observation = JSON.parse(stopped.stdout).observation
    assert.equal(observation.local_handles[0].observation.state, 'stopped')
    await new Promise(done => setTimeout(done, 5))
    const request = {
      id: 'operator-release', expected_revision: observation.revision, observation_id: observation.id,
      decision: { source: 'fixture-user', statement: 'Release local occupancy, retain remote uncertainty.' },
      accept_remote_uncertainty: true,
      report: {
        source: 'host_report', actor: 'fixture-owner', locator: 'test:supervised-node-with-no-children',
        machine: localMachine(), observed_at: new Date().toISOString(),
        method: 'Awaited the controlled fixture process close event; fixture creates no descendants.',
        scope: 'Exact fixture process and descendants', handles_covered: [handle],
        all_descendants_stopped: true, unresolved: [],
      },
    }
    const requestPath = join(home, 'reconcile.json')
    const before = readFileSync(join(home, 'consult/discussions.yaml'))
    for (const invalid of [
      { ...request, accept_remote_uncertainty: undefined },
      { ...request, state: 'stopped' },
      { ...request, expected_revision: observation.revision - 1 },
      { ...request, report: { ...request.report, observed_at: observation.at } },
    ]) {
      writeFileSync(requestPath, JSON.stringify(invalid))
      const rejected = await runNode([cli, 'consult', 'reconcile', ...args, '--request', requestPath])
      assert.equal(rejected.code, 1)
      assert.equal(readFileSync(join(home, 'consult/discussions.yaml')).equals(before), true)
    }
    writeFileSync(requestPath, JSON.stringify(request))
    const released = await runNode([cli, 'consult', 'reconcile', ...args, '--request', requestPath])
    assert.equal(released.code, 0, released.stderr + released.stdout)
    const turn = JSON.parse(released.stdout).turn
    assert.equal(turn.lifecycle, 'reconciled_by_attestation')
    assert.equal(turn.reconciliations[0].remote_generation, 'unknown')
    assert.deepEqual(turn.reconciliations[0].operator_attestation, request.report)
    const replay = await runNode([cli, 'consult', 'reconcile', ...args, '--request', requestPath])
    assert.equal(replay.code, 0, replay.stdout)
    assert.equal(JSON.parse(replay.stdout).turn.reconciliations.length, 1)
  }
  finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
    rmSync(home, { recursive: true, force: true })
  }
})

test('dist Runner executes one injected turn and does not redispatch a settled turn', async () => {
  const home = mkdtempSync(join(tmpdir(), 'contribbot-runner-package-'))
  try {
    const store = createConsultStore(home)
    const reserved = reserve(store)
    const runner = await import('../dist/index.js')
    let runs = 0
    const dependencies = {
      describeSupervisor: async pid => ({
        pid, machine: { hostname: 'runner-test', platform: process.platform }, started_at: null,
        observed_at: new Date().toISOString(),
      }),
      runtime: {
        verifyBinding: async () => {},
        prepare: async () => ({
          status: 'ready', preparations: [{ scratch_directory: null, probe: null }],
          run: async (_prompt, hooks) => {
            runs++
            hooks.dispatch(() => ({ fixture: true }))
            return {
              outcome: 'returned', text: 'Injected runner result', stdout: '', stderr: '',
              exit_code: 0, signal: null, integrity: 'ok', reason: null, unresolved: [],
            }
          },
        }),
      },
    }

    await runner.runConsultTurn(store, reserved.discussion_id, reserved.turn.id, dependencies)
    assert.equal(store.get(reserved.discussion_id).turns[0].lifecycle, 'settled')
    assert.equal(runs, 1)
    await runner.runConsultTurn(store, reserved.discussion_id, reserved.turn.id, dependencies)
    assert.equal(runs, 1)
  }
  finally { rmSync(home, { recursive: true, force: true }) }
})

test('source and dist CLIs launch detached workers and settle a bounded provider failure', async () => {
  const executableDigestValue = await executableDigest(process.execPath)
  for (const [label, command] of [
    ['dist', [cli]],
    ['source', ['--conditions=contribbot-source', '--import', tsx, sourceCli]],
    ['source-skill-other-repo', [sourceLauncher]],
  ]) {
    const home = mkdtempSync(join(tmpdir(), `contribbot-runner-worker-${label}-`))
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home }
      if (label === 'source-skill-other-repo') {
        writeFileSync(join(home, 'tsconfig.json'), '{broken foreign project config')
        env.TSX_TSCONFIG_PATH = join(home, 'tsconfig.json')
      }
      const store = createConsultStore(home)
      const body = `${label} worker fixture`
      const reserved = store.reserve({
        request_id: `${label}-request`, discussion_id: `${label}-discussion`, purpose: 'design', mode: 'fresh',
        todo_id: null, expected_todo: null,
        packet: { workspace: home, head: null, manifest: [], body, digest: digest(body), omitted: [] },
        binding: binding(process.execPath, executableDigestValue, 'codex'),
        authorization: { explicit_once: { source: 'runner-test', statement: 'Run one bounded worker fixture.' } },
      })
      const result = await runNode([...command,
        'consult', 'start', '--directory', home,
        '--discussion', reserved.discussion_id, '--turn', reserved.turn.id,
      ], {
        cwd: label === 'source-skill-other-repo' ? home : repository,
        env,
      })
      assert.equal(result.code, 0, `${label} worker stderr: ${result.stderr}`)
      assert.match(result.stdout, /"status":"worker_started"/)
      const settled = await waitForSettled(store, reserved.discussion_id)
      assert.equal(settled.output_digest !== null, true)
      assert.equal(settled.dispatch_started_at, null)
      assert.equal(settled.outcome, 'failed')
      const probe = settled.sandbox_probe
      assert.equal(probe.verified, false)
      const expected = {
        text: null, stdout: '', stderr: '', exit_code: null, signal: null,
        integrity: 'ok', outcome: 'failed',
        reason: `Advisor unavailable: ${probe.reason} Probe digest: ${probe.digest}. No model call was made.`,
        unresolved: [],
      }
      const content = readFileSync(join(home, 'consult', `${settled.id}.result.json`), 'utf8')
      assert.deepEqual(JSON.parse(content), expected)
      assert.equal(settled.output_digest, digest(content))
    }
    finally { rmSync(home, { recursive: true, force: true }) }
  }
})
