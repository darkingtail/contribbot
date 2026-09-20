import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(repository, 'scripts', 'data-reset.mjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'contribbot-reset-'))
  const home = path.join(root, 'home with spaces')
  const target = path.join(home, '.contribbot')
  fs.mkdirSync(home)
  const write = (file, value = 'fixture') => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value)
  }
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  })
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, home, target, write, run }
}

test('package exposes data:reset and its test command', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['data:reset'], 'node scripts/data-reset.mjs')
  assert.equal(pkg.scripts['test:data-reset'], 'node --test scripts/data-reset.test.mjs')
  assert.ok(pkg.scripts.test.includes('test:data-reset'))
})

test('default and --dry-run preview leave data byte-identical', t => {
  const f = fixture(t)
  const data = path.join(f.target, 'owner', 'repo', 'todos.yaml')
  f.write(data, 'status: active\n')
  for (const args of [[], ['--dry-run']]) {
    const result = f.run(...args)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /PREVIEW/)
    assert.ok(result.stdout.includes(f.target))
    assert.equal(fs.readFileSync(data, 'utf8'), 'status: active\n')
  }
})

test('--yes removes only .contribbot and repeated reset is a no-op', t => {
  const f = fixture(t)
  f.write(path.join(f.target, 'owner', 'repo', 'config.yaml'))
  f.write(path.join(f.target, 'agent.json'))
  const siblings = ['.contribbot-backups/old/data.txt', '.codex/config.toml',
    '.catpaw/state/projects.json', 'repo/.catpaw/index.md', '.agents/skills/example/SKILL.md']
  for (const sibling of siblings) f.write(path.join(f.home, sibling), 'keep')
  const result = f.run('--yes')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /REMOVED/)
  assert.equal(fs.existsSync(f.target), false)
  for (const sibling of siblings) assert.equal(fs.readFileSync(path.join(f.home, sibling), 'utf8'), 'keep')
  assert.match(f.run('--yes').stdout, /NOTHING TO RESET/)
})

test('absent target is not created by preview or reset', t => {
  const f = fixture(t)
  for (const args of [[], ['--yes']]) {
    const result = f.run(...args)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /NOTHING TO RESET/)
    assert.equal(fs.existsSync(f.target), false)
  }
})

test('unknown flags, positional paths and conflicting flags cannot delete', t => {
  const f = fixture(t)
  f.write(path.join(f.target, 'keep'))
  for (const args of [['--force'], ['--yes', '--dry-run'], ['--yes', f.home], ['--home', f.home]]) {
    assert.equal(f.run(...args).status, 1)
    assert.equal(fs.existsSync(path.join(f.target, 'keep')), true)
  }
})

test('refuses a file instead of a data directory', async t => {
  const f = fixture(t)
  f.write(f.target)
  const { planReset } = await import('./data-reset.mjs')
  assert.throws(() => planReset({ home: f.home }), /directory/)
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'fixture')
})

test('refuses root and nested symlinks/junctions without touching their destinations', async t => {
  const f = fixture(t)
  const outside = path.join(f.root, 'outside')
  f.write(path.join(outside, 'keep'))
  const { planReset } = await import('./data-reset.mjs')
  fs.symlinkSync(outside, f.target, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => planReset({ home: f.home }), /link|junction/i)
  fs.unlinkSync(f.target)
  fs.mkdirSync(f.target)
  const link = path.join(f.target, 'linked')
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => planReset({ home: f.home }), /link|junction/i)
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'fixture')
  fs.unlinkSync(link)
})

test('refuses embedded Git repositories and worktree .git files before deleting anything', async t => {
  const f = fixture(t)
  const { planReset } = await import('./data-reset.mjs')
  const marker = path.join(f.target, 'runs', 'checkout', '.git')
  f.write(marker, 'gitdir: somewhere')
  f.write(path.join(f.target, 'keep'))
  assert.throws(() => planReset({ home: f.home }), /Git/)
  fs.unlinkSync(marker)
  fs.mkdirSync(marker)
  assert.throws(() => planReset({ home: f.home }), /Git/)
  assert.equal(fs.existsSync(path.join(f.target, 'keep')), true)
})

test('rejects filesystem-root home, stale inventory and forged target', async t => {
  const f = fixture(t)
  const { planReset, applyReset } = await import('./data-reset.mjs')
  assert.throws(() => planReset({ home: path.parse(f.home).root }), /root/i)
  f.write(path.join(f.target, 'one'))
  const before = planReset({ home: f.home })
  f.write(path.join(f.target, 'two'))
  assert.throws(() => applyReset(before), /changed/i)
  const current = planReset({ home: f.home })
  assert.throws(() => applyReset({ ...current, target: f.home }), /target/i)
  assert.equal(fs.existsSync(path.join(f.target, 'one')), true)
})

test('refuses bare Git repositories before removing ordinary data', async t => {
  const f = fixture(t)
  const bare = path.join(f.target, 'cache', 'mirror.git')
  f.write(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n')
  f.write(path.join(bare, 'config'), '[core]\n bare = true\n')
  fs.mkdirSync(path.join(bare, 'objects'))
  fs.mkdirSync(path.join(bare, 'refs'))
  f.write(path.join(f.target, 'keep'))
  const { planReset } = await import('./data-reset.mjs')
  assert.throws(() => planReset({ home: f.home }), /bare Git/)
  const result = f.run('--yes')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /bare Git/)
  assert.equal(fs.existsSync(path.join(bare, 'HEAD')), true)
  assert.equal(fs.existsSync(path.join(f.target, 'keep')), true)
})

test('plan and apply support spaces, nested and empty directories', async t => {
  const f = fixture(t)
  const { planReset, applyReset } = await import('./data-reset.mjs')
  f.write(path.join(f.target, 'a b', 'test.txt'), '1234')
  fs.mkdirSync(path.join(f.target, 'empty'))
  const plan = planReset({ home: f.home })
  assert.equal(plan.files, 1)
  assert.equal(plan.bytes, 4)
  assert.equal(applyReset(plan).removed, true)
  assert.equal(fs.existsSync(f.target), false)
})

test('temporary-directory aliases do not break preview assertions or fixture cleanup', t => {
  const f = fixture(t)
  const real = path.join(f.root, 'real-temp')
  const alias = path.join(f.root, 'alias-temp')
  fs.mkdirSync(real)
  fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    const env = { ...process.env, TMPDIR: alias, TEMP: alias, TMP: alias, HOME: f.home, USERPROFILE: f.home }
    // This is a separate test runner, not a worker of the parent's node:test process.
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(process.execPath, [
      '--test', '--test-name-pattern=default and --dry-run', fileURLToPath(import.meta.url),
    ], {
      cwd: f.root, encoding: 'utf8', env,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /# pass 1\b/)
    assert.deepEqual(fs.readdirSync(real), [])
  }
  finally { fs.unlinkSync(alias) }
})
