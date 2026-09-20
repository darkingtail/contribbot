import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { planSetup, planRemove, applySetup, probeExecution } from './dev-setup.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contribbot-exec-dev-'))
  const repo = path.join(root, 'source checkout')
  const home = path.join(root, 'home')
  const cwd = path.join(root, '\u6d4b\u8bd5 target repo')
  const codexHome = path.join(home, '.codex')
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value)
  }
  const source = path.join(repo, 'skills/todo')
  const launcher = path.join(source, 'scripts/contribbot-exec.mjs')
  const installed = path.join(home, '.agents/skills/contribbot-todo')
  const nodeModules = path.join(repo, 'packages/mcp/node_modules')
  const rootModules = path.join(repo, 'node_modules')
  const entry = path.join(repo, 'packages/mcp/src/cli/execution.ts')
  write(path.join(repo, 'package.json'), '{"name":"contribbot","private":true,"type":"module"}')
  write(path.join(repo, 'packages/mcp/package.json'),
    '{"name":"contribbot-mcp","type":"module","bin":{"contribbot-exec":"./dist/cli/execution.js"}}')
  write(path.join(repo, 'packages/mcp/tsconfig.json'), '{"compilerOptions":{"target":"ES2022","module":"ESNext"}}')
  write(path.join(source, 'SKILL.md'), '---\nname: contribbot:todo\n---\n')
  write(path.join(repo, 'packages/mcp/src/mcp/index.ts'), '')
  // This TypeScript fixture verifies transport, not the execution domain.
  write(entry, "const value: string = 'source-v1'; console.log(JSON.stringify({ value, cwd: process.cwd(), args: process.argv.slice(2) }))")
  const actual = path.join(repository, 'skills/todo/scripts/contribbot-exec.mjs')
  if (fs.existsSync(actual)) {
    fs.mkdirSync(path.dirname(launcher), { recursive: true })
    fs.copyFileSync(actual, launcher)
  }
  fs.symlinkSync(path.join(repository, 'packages/mcp/node_modules'), nodeModules,
    process.platform === 'win32' ? 'junction' : 'dir')
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome }
  for (const name of Object.keys(env)) {
    if (/^(path|node_options|tsx_.*)$/i.test(name)) delete env[name]
  }
  env.PATH = ''
  const run = (args = [], extra = {}) => spawnSync(process.execPath,
    [path.join(installed, 'scripts/contribbot-exec.mjs'), ...args], {
      cwd, env, windowsHide: true, encoding: 'utf8', timeout: 15_000, ...extra,
    })
  t.after(() => {
    for (const link of [installed, nodeModules, rootModules]) {
      try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const relative = path.relative(os.tmpdir(), root)
    assert.ok(relative.startsWith('contribbot-exec-dev-') && !relative.includes(path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const dev = (flags) => {
    const script = path.join(repo, 'scripts/dev-setup.mjs')
    if (!fs.existsSync(script)) {
      write(script, fs.readFileSync(path.join(repository, 'scripts/dev-setup.mjs'), 'utf8'))
      fs.symlinkSync(path.join(repository, 'node_modules'), rootModules,
        process.platform === 'win32' ? 'junction' : 'dir')
    }
    return spawnSync(process.execPath, [script, ...flags], {
      cwd, env, windowsHide: true, encoding: 'utf8', timeout: 20_000,
    })
  }
  return { root, repo, home, cwd, codexHome, write, source, launcher, installed, nodeModules, entry, run, env, dev }
}

test('setup exposes source execution through the Skill from another cwd without a PATH command', t => {
  const f = fixture(t)
  applySetup(planSetup(f))
  const result = f.run(['check', '--schema'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.deepEqual(JSON.parse(result.stdout), {
    value: 'source-v1', cwd: f.cwd, args: ['check', '--schema'],
  })
  assert.equal(fs.existsSync(path.join(f.home, '.contribbot')), false)
})

test('subsequent calls load edited source and never run an available stale dist', t => {
  const f = fixture(t)
  const trap = path.join(f.repo, 'dist-was-used')
  f.write(path.join(f.repo, 'packages/mcp/dist/cli/execution.js'),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(trap)}, 'bad fallback')`)
  applySetup(planSetup(f))
  assert.equal(JSON.parse(f.run().stdout).value, 'source-v1')
  f.write(f.entry, "const value: string = 'source-v2'; console.log(JSON.stringify({value}))")
  const result = f.run()
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(JSON.parse(result.stdout).value, 'source-v2')
  assert.equal(fs.existsSync(trap), false)
})

test('literal arguments, stdin, cwd and nonzero exit stay in the execution process', t => {
  const f = fixture(t)
  f.write(f.entry, `import fs from 'node:fs'
    const body: unknown = JSON.parse(fs.readFileSync(0, 'utf8'))
    console.log(JSON.stringify({body, args:process.argv.slice(2), cwd:process.cwd(), pid:process.pid}))
    process.exitCode = 7`)
  applySetup(planSetup(f))
  const argv = ['context', '--request', '-', 'literal & | " spaced']
  const result = f.run(argv, { input: '{"note":"keep \\\\ \\" input"}' })
  assert.equal(result.status, 7, result.stderr + result.stdout)
  const actual = JSON.parse(result.stdout)
  assert.deepEqual(actual.body, { note: 'keep \\ " input' })
  assert.deepEqual(actual.args, argv)
  assert.equal(actual.cwd, f.cwd)
  assert.equal(actual.pid, result.pid)
})

test('missing source or dependencies fails clearly without using dist or creating task data', t => {
  const f = fixture(t)
  applySetup(planSetup(f))
  fs.unlinkSync(f.entry)
  let result = f.run()
  assert.equal(result.status, 1)
  assert.match(JSON.parse(result.stdout).error.message, /source entry/i)
  f.write(f.entry, 'console.log("unexpected")')
  fs.unlinkSync(f.nodeModules)
  result = f.run()
  assert.equal(result.status, 1)
  assert.match(JSON.parse(result.stdout).error.message, /dependencies|pnpm install/i)
  assert.equal(fs.existsSync(path.join(f.home, '.contribbot')), false)
})

test('a copied Skill does not infer a checkout from cwd or fall back to an arbitrary CLI', t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.installed, 'scripts'), { recursive: true })
  fs.copyFileSync(f.launcher, path.join(f.installed, 'scripts/contribbot-exec.mjs'))
  const result = f.run([], { cwd: repository })
  assert.equal(result.status, 1)
  assert.match(JSON.parse(result.stdout).error.message, /source checkout/i)
  assert.equal(fs.existsSync(path.join(f.home, '.contribbot')), false)
})

test('remove removes discovery even without dependencies and preserves source and task data', t => {
  const f = fixture(t)
  applySetup(planSetup(f))
  const data = path.join(f.home, '.contribbot/example/repo/todos.yaml')
  f.write(data, 'user task data')
  fs.unlinkSync(f.nodeModules)
  applySetup(planRemove(f))
  assert.equal(fs.existsSync(f.installed), false)
  assert.notEqual(f.run().status, 0)
  assert.ok(fs.existsSync(f.launcher))
  assert.ok(fs.existsSync(f.entry))
  assert.equal(fs.readFileSync(data, 'utf8'), 'user task data')
})

const schema = {
  type: 'object', required: ['acceptance_id'],
  'x-contribbot': { action: 'check', validation: 'structure-only' },
}

test('startup probe parses the schema without writing configuration, task data or links', t => {
  const f = fixture(t)
  f.write(f.entry, `console.log(${JSON.stringify(JSON.stringify(schema))})`)
  const plan = planSetup(f)
  assert.deepEqual(probeExecution(plan.execution, { cwd: f.cwd }), schema)
  assert.equal(fs.existsSync(f.installed), false)
  assert.equal(fs.existsSync(path.join(f.codexHome, 'config.toml')), false)
  assert.equal(fs.existsSync(path.join(f.home, '.contribbot')), false)
})

test('probe rejects incompatible, corrupt and nonzero startup output', t => {
  const f = fixture(t)
  const plan = planSetup(f)
  assert.throws(() => probeExecution(plan.execution, { cwd: f.cwd }), /incompatible/)
  f.write(f.entry, 'console.log("not json")')
  assert.throws(() => probeExecution(plan.execution, { cwd: f.cwd }), /invalid discovery JSON/)
  f.write(f.entry, 'process.exitCode = 3')
  assert.throws(() => probeExecution(plan.execution, { cwd: f.cwd }), /startup failed/)
  assert.equal(fs.existsSync(f.installed), false)
})

test('probe has a deadline and stops a hanging discovery process', t => {
  const f = fixture(t)
  const plan = planSetup(f)
  f.write(f.entry, 'setInterval(() => {}, 1000)')
  assert.throws(() => probeExecution(plan.execution, { cwd: f.cwd, timeout: 1500 }), /startup failed/)
  assert.equal(fs.existsSync(f.installed), false)
})

test('the explicit source tsconfig is used instead of a broken cwd or environment tsconfig', t => {
  const f = fixture(t)
  f.write(path.join(f.cwd, 'tsconfig.json'), '{broken')
  const wrong = path.join(f.root, 'bad-config.json')
  f.write(wrong, '{also broken')
  applySetup(planSetup(f))
  const result = f.run([], { env: { ...f.env, TSX_TSCONFIG_PATH: wrong } })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(JSON.parse(result.stdout).value, 'source-v1')
})

test('setup planning refuses a missing helper before touching existing configuration', t => {
  const f = fixture(t)
  const configPath = path.join(f.codexHome, 'config.toml')
  f.write(configPath, 'model = "keep"\n')
  fs.unlinkSync(f.launcher)
  assert.throws(() => planSetup(f), /Missing execution helper/)
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'model = "keep"\n')
  assert.equal(fs.existsSync(f.installed), false)
})

test('CLI dry-run does not launch a probe; failed startup leaves configuration and skills untouched', t => {
  const f = fixture(t)
  const configPath = path.join(f.codexHome, 'config.toml')
  const before = 'model = "keep"\n'
  f.write(configPath, before)
  const ran = path.join(f.root, 'probe-ran')
  f.write(f.entry, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(ran)}, 'yes'); process.exitCode=9`)
  let result = f.dev(['--dry-run'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(fs.existsSync(ran), false)
  result = f.dev([])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /startup failed/)
  assert.equal(fs.existsSync(ran), true)
  assert.equal(fs.readFileSync(configPath, 'utf8'), before)
  assert.equal(fs.existsSync(f.installed), false)
})

test('CLI check distinguishes configured links from startup failure; remove survives a missing helper', t => {
  const f = fixture(t)
  f.write(f.entry, `console.log(${JSON.stringify(JSON.stringify(schema))})`)
  let result = f.dev([])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  result = f.dev(['--check'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /startup\/schema OK/)
  const configPath = path.join(f.codexHome, 'config.toml')
  const before = fs.readFileSync(configPath, 'utf8')
  f.write(f.entry, 'throw new Error("fixture-import-failed")')
  result = f.dev(['--check'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /fixture-import-failed/)
  assert.doesNotMatch(result.stdout, /startup\/schema OK/)
  assert.equal(fs.readFileSync(configPath, 'utf8'), before)
  fs.unlinkSync(f.launcher)
  fs.unlinkSync(f.nodeModules)
  result = f.dev(['--remove'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(fs.existsSync(f.installed), false)
  assert.equal(fs.existsSync(path.join(f.home, '.contribbot')), false)
})
