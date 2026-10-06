import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'smol-toml'
import { planSetup, planRemove, applySetup } from './dev-setup.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contribbot-dev-'))
  const repo = path.join(root, 'repo with spaces')
  const home = path.join(root, 'home')
  const codexHome = path.join(home, 'custom-codex')
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value)
  }
  const skill = (dir, name = 'contribbot:init') => write(path.join(dir, 'SKILL.md'), `---\nname: "${name}"\n---\nHello`)
  const source = path.join(repo, 'skills', 'init')
  skill(source)
  write(path.join(repo, 'packages/mcp/node_modules/tsx/dist/cli.mjs'), '')
  write(path.join(repo, 'packages/mcp/src/mcp/index.ts'), '')
  const configPath = path.join(codexHome, 'config.toml')
  write(configPath, '# original comment\nmodel = "example"\n[mcp_servers.other]\ncommand = "keep"\n[mcp_servers.contribbot]\ncommand = "npx"\nargs = ["contribbot-mcp"]\nstartup_timeout_sec = 40\n[mcp_servers.contribbot.env]\nEXAMPLE = "preserve"\n')
  const destination = path.join(home, '.agents/skills/contribbot-init')
  const legacy = path.join(codexHome, 'skills/init')
  // Remove junctions explicitly so cleanup cannot traverse repository targets.
  t.after(() => {
    for (const dir of [destination, legacy]) {
      if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) fs.unlinkSync(dir)
    }
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'contribbot-dev-')))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { repo, home, codexHome, configPath, source, destination, legacy, write, skill }
}

test('plan is read-only; setup preserves settings, backs up copies and is idempotent', t => {
  const f = fixture(t)
  f.skill(f.legacy)
  const unrelated = path.join(f.codexHome, 'skills/other/SKILL.md')
  f.write(unrelated, 'unrelated')
  const before = fs.readFileSync(f.configPath, 'utf8')
  const plan = planSetup(f)
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), before)
  assert.equal(fs.existsSync(f.destination), false)
  const backups = applySetup(plan)
  assert.equal(backups.length, 2)
  assert.equal(fs.readFileSync(backups[0], 'utf8'), before)
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unrelated')
  assert.equal(fs.existsSync(f.legacy), false)
  assert.equal(fs.realpathSync(f.destination), fs.realpathSync(f.source))
  const config = parse(fs.readFileSync(f.configPath, 'utf8'))
  assert.equal(config.model, 'example')
  assert.equal(config.mcp_servers.other.command, 'keep')
  assert.equal(config.mcp_servers.contribbot.env.EXAMPLE, 'preserve')
  assert.equal(config.mcp_servers.contribbot.startup_timeout_sec, 40)
  assert.equal(config.mcp_servers.contribbot.command, process.execPath)
  assert.ok(config.mcp_servers.contribbot.args[1].endsWith(path.join('src', 'mcp', 'index.ts')))
  f.write(path.join(f.source, 'SKILL.md'), 'edited live')
  assert.equal(fs.readFileSync(path.join(f.destination, 'SKILL.md'), 'utf8'), 'edited live')
  f.skill(f.source)
  const second = planSetup(f)
  assert.equal(second.changed, false)
  assert.deepEqual(applySetup(second), [])
})

test('refuses unrelated destination before any changes', t => {
  const f = fixture(t)
  f.skill(f.destination, 'another:init')
  assert.throws(() => planSetup(f), /Unrelated/)
  assert.equal(parse(fs.readFileSync(f.configPath, 'utf8')).mcp_servers.contribbot.command, 'npx')
})

test('deduplicates renamed legacy contribbot copies but leaves unrelated init alone', t => {
  const f = fixture(t)
  f.skill(f.legacy, 'other:init')
  const renamed = path.join(f.codexHome, 'skills/my-init')
  f.skill(renamed)
  applySetup(planSetup(f))
  assert.ok(fs.existsSync(f.legacy))
  assert.equal(fs.existsSync(renamed), false)
})

test('malformed TOML and missing dependencies fail without moving skills', t => {
  const f = fixture(t)
  f.skill(f.legacy)
  f.write(f.configPath, '[invalid')
  assert.throws(() => planSetup(f))
  assert.ok(fs.existsSync(f.legacy))
  f.write(f.configPath, '')
  fs.unlinkSync(path.join(f.repo, 'packages/mcp/node_modules/tsx/dist/cli.mjs'))
  assert.throws(() => planSetup(f), /pnpm install/)
})

test('detects changed config between planning and applying', t => {
  const f = fixture(t)
  f.skill(f.legacy)
  const plan = planSetup(f)
  f.write(f.configPath, 'model = "new-value"\n')
  assert.throws(() => applySetup(plan), /changed since planning/)
  assert.ok(fs.existsSync(f.legacy))
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), 'model = "new-value"\n')
})

test('rolls back moved copies on link failure without deleting a competing destination', t => {
  const f = fixture(t)
  f.skill(f.legacy)
  const plan = planSetup(f)
  f.skill(f.destination, 'other:init')
  assert.throws(() => applySetup(plan), /EEXIST/)
  assert.ok(fs.existsSync(f.legacy))
  assert.match(fs.readFileSync(path.join(f.destination, 'SKILL.md'), 'utf8'), /other:init/)
  assert.equal(parse(fs.readFileSync(f.configPath, 'utf8')).mcp_servers.contribbot.command, 'npx')
})

test('fresh home creates a config; current links need no backup', t => {
  const f = fixture(t)
  fs.unlinkSync(f.configPath)
  applySetup(planSetup(f))
  assert.equal(planSetup(f).changed, false)
})

test('HTTP entries and enabled duplicate plugins are not silently replaced', t => {
  const f = fixture(t)
  f.write(f.configPath, '[mcp_servers.contribbot]\nurl = "http://localhost:9999"\n')
  assert.throws(() => planSetup(f), /HTTP/)
  f.write(f.configPath, '[plugins."contribbot@local"]\nenabled = true\n')
  assert.throws(() => planSetup(f), /plugin/)
})

test('refuses to move a skill whose identity changed after planning', t => {
  const f = fixture(t)
  f.skill(f.legacy)
  const plan = planSetup(f)
  f.skill(f.legacy, 'unrelated:init')
  assert.throws(() => applySetup(plan), /Skill changed/)
  assert.match(fs.readFileSync(path.join(f.legacy, 'SKILL.md'), 'utf8'), /unrelated:init/)
  assert.equal(fs.existsSync(f.destination), false)
})

test('backs up copies beside the physical skills root when that root is redirected', t => {
  const f = fixture(t)
  const physical = path.join(f.home, 'redirected', 'skills')
  const root = path.dirname(f.legacy)
  fs.mkdirSync(physical, { recursive: true })
  fs.symlinkSync(physical, root, process.platform === 'win32' ? 'junction' : 'dir')
  t.after(() => { if (fs.existsSync(root)) fs.unlinkSync(root) })
  f.skill(f.legacy)
  const backups = applySetup(planSetup(f))
  assert.ok(backups.some(file => file.startsWith(path.join(f.home, 'redirected', 'contribbot-dev-backups'))))
  assert.equal(planSetup(f).changed, false)
})

test('CODEX_HOME from the environment changes config and legacy location, not user skills', t => {
  const f = fixture(t)
  const previous = process.env.CODEX_HOME
  try {
    process.env.CODEX_HOME = f.codexHome
    const plan = planSetup({ repo: f.repo, home: f.home })
    assert.equal(plan.configPath, f.configPath)
    assert.equal(plan.skills[0].destination, f.destination)
  }
  finally {
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
  }
})

test('updates an existing repository MCP override, preserving local settings and backing it up', t => {
  const f = fixture(t)
  const local = path.join(f.repo, '.codex/config.toml')
  const before = 'model = "local"\n[mcp_servers.contribbot]\ncommand = "node"\nargs = ["old-dist.js"]\ntool_timeout_sec = 90\n'
  f.write(local, before)
  const backups = applySetup(planSetup(f))
  const config = parse(fs.readFileSync(local, 'utf8'))
  assert.equal(config.model, 'local')
  assert.equal(config.mcp_servers.contribbot.tool_timeout_sec, 90)
  assert.equal(config.mcp_servers.contribbot.args[1], path.join(f.repo, 'packages/mcp/src/mcp/index.ts'))
  const backup = backups.find(file => file.startsWith(path.join(f.repo, '.codex')))
  assert.equal(fs.readFileSync(backup, 'utf8'), before)
  assert.equal(planSetup(f).changed, false)
})

test('does not add a repository MCP override when none exists', t => {
  const f = fixture(t)
  const local = path.join(f.repo, '.codex/config.toml')
  f.write(local, '# keep formatting\nmodel = "local"\n')
  applySetup(planSetup(f))
  assert.equal(fs.readFileSync(local, 'utf8'), '# keep formatting\nmodel = "local"\n')
})

test('rejects repository-local duplicate plugins even without a local MCP entry', t => {
  const f = fixture(t)
  const local = path.join(f.repo, '.codex/config.toml')
  f.write(local, '[plugins."contribbot@local"]\nenabled = true\n')
  assert.throws(() => planSetup(f), /plugin/)
  f.write(local, '[plugins."contribbot@local"]\nenabled = true\n[mcp_servers.contribbot]\ncommand = "node"\n')
  assert.throws(() => planSetup(f), /plugin/)
})

test('a second config write failure rolls back the first config and skills', t => {
  const f = fixture(t)
  f.skill(f.legacy)
  const local = path.join(f.repo, '.codex/config.toml')
  const before = '[mcp_servers.contribbot]\ncommand = "node"\nargs = ["old-dist.js"]\n'
  f.write(local, before)
  const original = fs.readFileSync(f.configPath, 'utf8')
  const rename = fs.renameSync
  const mock = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === local) throw new Error('simulated second-config failure')
    return rename(source, destination)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => applySetup(planSetup(f)), /simulated/)
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), original)
    assert.equal(fs.readFileSync(local, 'utf8'), before)
    assert.ok(fs.existsSync(f.legacy))
    assert.equal(fs.existsSync(f.destination), false)
    fs.unlinkSync(f.configPath)
    assert.throws(() => applySetup(planSetup(f)), /simulated/)
    assert.equal(fs.existsSync(f.configPath), false)
    assert.ok(fs.existsSync(f.legacy))
  }
  finally {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
})

test('remove backs up configs, preserves unrelated values and unlinks without deleting source', t => {
  const f = fixture(t)
  const local = path.join(f.repo, '.codex/config.toml')
  f.write(local, '[mcp_servers.contribbot]\ncommand = "node"\n')
  applySetup(planSetup(f))
  const before = fs.readFileSync(f.configPath, 'utf8')
  const plan = planRemove(f)
  assert.ok(fs.existsSync(f.destination))
  const backups = applySetup(plan)
  assert.equal(backups.length, 2)
  assert.equal(fs.readFileSync(backups[0], 'utf8'), before)
  const expected = parse(before)
  delete expected.mcp_servers.contribbot
  assert.deepEqual(parse(fs.readFileSync(f.configPath, 'utf8')), expected)
  assert.deepEqual(parse(fs.readFileSync(local, 'utf8')), {})
  assert.ok(fs.existsSync(path.join(f.source, 'SKILL.md')))
  assert.equal(fs.existsSync(f.destination), false)
  assert.equal(planRemove(f).changed, false)
})

test('verified removal cleans only its own config backups, preserving setup backups', t => {
  const f = fixture(t)
  const oldBackups = applySetup(planSetup(f))
  const plan = planRemove(f)
  plan.cleanupConfigBackups = true
  assert.deepEqual(applySetup(plan), [])
  assert.ok(oldBackups.every(file => fs.existsSync(file)))
  assert.equal(planRemove(f).changed, false)
})

test('remove preserves MCP and skills belonging to another installation', t => {
  const f = fixture(t)
  f.skill(f.destination, 'contribbot:init')
  const plan = planRemove(f)
  assert.equal(plan.changed, false)
  assert.equal(plan.warnings.length, 2)
  assert.deepEqual(applySetup(plan), [])
  assert.ok(fs.existsSync(f.destination))
  assert.equal(parse(fs.readFileSync(f.configPath, 'utf8')).mcp_servers.contribbot.command, 'npx')
})

test('remove still works when dependencies and a source skill have been deleted', t => {
  const f = fixture(t)
  applySetup(planSetup(f))
  fs.unlinkSync(path.join(f.repo, 'packages/mcp/node_modules/tsx/dist/cli.mjs'))
  fs.unlinkSync(path.join(f.source, 'SKILL.md'))
  fs.rmdirSync(f.source)
  const plan = planRemove(f)
  assert.equal(plan.removals.length, 1)
  applySetup(plan)
  assert.equal(planRemove(f).changed, false)
})

test('failed removal restores links and config, retaining recovery backups', t => {
  const f = fixture(t)
  applySetup(planSetup(f))
  const before = fs.readFileSync(f.configPath, 'utf8')
  const plan = planRemove(f)
  plan.cleanupConfigBackups = true
  const rename = fs.renameSync
  const mock = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === f.configPath) throw new Error('simulated remove failure')
    return rename(source, destination)
  })
  syncBuiltinESMExports()
  try { assert.throws(() => applySetup(plan), /simulated/) }
  finally { mock.mock.restore(); syncBuiltinESMExports() }
  assert.equal(fs.realpathSync(f.destination), fs.realpathSync(f.source))
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), before)
  const backupRoot = path.join(f.codexHome, 'contribbot-dev-backups')
  assert.equal(fs.readdirSync(backupRoot).length, 2)
})

test('remove refuses a link replaced after planning', t => {
  const f = fixture(t)
  applySetup(planSetup(f))
  const plan = planRemove(f)
  fs.unlinkSync(f.destination)
  f.skill(f.destination, 'unrelated:init')
  assert.throws(() => applySetup(plan), /Removal link changed/)
  assert.match(fs.readFileSync(path.join(f.destination, 'SKILL.md'), 'utf8'), /unrelated/)
  assert.ok(parse(fs.readFileSync(f.configPath, 'utf8')).mcp_servers.contribbot)
})

test('post-write verification failure preserves config backups and concurrent edits', t => {
  const f = fixture(t)
  applySetup(planSetup(f))
  const plan = planRemove(f)
  plan.cleanupConfigBackups = true
  const rename = fs.renameSync
  const mock = t.mock.method(fs, 'renameSync', (source, destination) => {
    const result = rename(source, destination)
    if (destination === f.configPath) f.write(destination, 'model = "concurrent-edit"\n')
    return result
  })
  syncBuiltinESMExports()
  try { assert.throws(() => applySetup(plan), /manual recovery/) }
  finally { mock.mock.restore(); syncBuiltinESMExports() }
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), 'model = "concurrent-edit"\n')
  assert.equal(fs.realpathSync(f.destination), fs.realpathSync(f.source))
  assert.equal(fs.readdirSync(path.join(f.codexHome, 'contribbot-dev-backups')).length, 2)
})

test('remove preserves unrelated TOML datetime values', t => {
  const f = fixture(t)
  applySetup(planSetup(f))
  fs.appendFileSync(f.configPath, '\n[custom]\nsaved_at = 2026-09-15T10:00:00Z\nlocal_date = 2026-09-15\n')
  const before = parse(fs.readFileSync(f.configPath, 'utf8'))
  applySetup(planRemove(f))
  const after = parse(fs.readFileSync(f.configPath, 'utf8'))
  assert.deepEqual(after.custom, before.custom)
})
