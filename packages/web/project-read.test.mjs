import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { repositoryDigest, repositoryDisplay } from 'contribbot-core/repository/ref'
import { fixture, startWeb, writeProject } from './test/helpers.mjs'

test('API reports broken config and Todo separately without losing healthy siblings or rewriting files', async t => {
  const { home, root } = fixture(t)
  writeProject(root, 'healthy')
  const invalid = writeProject(root, 'bad-config', { role: 'admin' })
  const missing = writeProject(root, 'missing')
  fs.unlinkSync(path.join(missing.directory, 'config.yaml'))
  const brokenTodo = writeProject(root, 'bad-todo')
  const file = path.join(brokenTodo.directory, 'todos.yaml')
  const content = 'todos:\n  - title: old state\n    status: pr_submitted\n'
  fs.writeFileSync(file, content)
  const legacy = path.join(root, 'owner', 'legacy')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'config.yaml'), 'role: admin\n')
  const configBefore = fs.readFileSync(path.join(invalid.directory, 'config.yaml'), 'utf8')
  const server = await startWeb(t, home)
  const { status, body } = await server.read()
  assert.equal(status, 200)
  assert.equal(body.projects.length, 2)
  assert.deepEqual(body.problems.map(problem => problem.code).sort(), ['config_invalid', 'config_missing', 'todo_data_unreadable'])
  const project = body.projects.find(item => item.repository.path === 'team/bad-todo')
  for (const key of ['total', 'active', 'backlog', 'done', 'paused', 'cancelled', 'items']) assert.equal(project.todos[key], null)
  assert.deepEqual(body.projects.find(item => item.repository.path === 'team/healthy').todos.items, [])
  assert.equal(fs.readFileSync(file, 'utf8'), content)
  assert.equal(fs.readFileSync(path.join(invalid.directory, 'config.yaml'), 'utf8'), configBefore)
  assert.deepEqual(fs.readdirSync(missing.directory), [])
  await server.stop()
})

test('API keeps stable digests for different platforms and colliding display labels', async t => {
  const { home, root } = fixture(t)
  const repositories = [
    { platform: 'gitlab', instance: 'https://code.example.invalid/x', path: 'gitlab/team/ui' },
    { platform: 'gitlab', instance: 'https://code.example.invalid/x/gitlab', path: 'team/ui' },
    { platform: 'github', instance: 'https://code.example.invalid/x/gitlab', path: 'team/ui' },
  ]
  for (const repository of repositories) writeProject(root, 'unused', { repository })
  assert.equal(repositoryDisplay(repositories[0]), repositoryDisplay(repositories[1]))
  const server = await startWeb(t, home)
  const { body } = await server.read()
  assert.equal(body.projects.length, 3)
  assert.equal(new Set(body.projects.map(project => project.digest)).size, 3)
  for (const project of body.projects) assert.equal(project.digest, repositoryDigest(project.repository))
  assert.deepEqual(body.problems, [])
  await server.stop()
})

test('API rejects root corruption with HTTP 500 and does not initialize missing data', async t => {
  const { home, root } = fixture(t)
  const server = await startWeb(t, home)
  assert.deepEqual((await server.read()).body.projects, [])
  assert.equal(fs.existsSync(root), false)
  fs.mkdirSync(path.join(root, 'projects', 'v1'), { recursive: true })
  fs.writeFileSync(path.join(root, 'projects', 'v1', 'unexpected'), 'invalid')
  const result = await server.read()
  assert.equal(result.status, 500)
  assert.match(result.body.error, /Invalid schema v3 project directory/)
  assert.equal(Object.hasOwn(result.body, 'projects'), false)
  await server.stop()
})

test('API preserves patrol reports and badges but marks malformed or missing reports unknown', async t => {
  const { home, root } = fixture(t)
  for (const name of ['healthy', 'malformed', 'missing', 'traversal', 'not-run', 'old-report']) {
    const { directory } = writeProject(root, name)
    fs.mkdirSync(path.join(directory, 'patrol'), { recursive: true })
    if (name === 'not-run') continue
    if (name === 'old-report') {
      fs.writeFileSync(path.join(directory, 'patrol', 'latest.md'), 'Retained report')
      continue
    }
    const latest = { run_id: name === 'traversal' ? '../../../../outside' : 'run-1', status: 'succeeded', recorded_at: '2026-10-02T00:00:00Z', report: '../../outside.md' }
    fs.writeFileSync(path.join(directory, 'patrol', 'latest.json'), name === 'malformed' ? '{bad' : JSON.stringify(latest))
    if (name === 'healthy') {
      fs.mkdirSync(path.join(directory, 'patrol', 'runs', 'run-1'), { recursive: true })
      fs.writeFileSync(path.join(directory, 'patrol', 'runs', 'run-1', 'report.md'), 'Real patrol report')
    }
  }
  fs.writeFileSync(path.join(home, 'outside.md'), 'must not appear')
  const server = await startWeb(t, home)
  const { status, body } = await server.read()
  assert.equal(status, 200)
  const get = name => body.projects.find(item => item.repository.path === `team/${name}`)
  assert.equal(get('healthy').patrol.status, 'succeeded')
  assert.equal(get('healthy').patrol.report, 'Real patrol report')
  assert.equal(get('not-run').patrol.status, 'not_run')
  assert.equal(get('old-report').patrol.status, 'unknown')
  assert.equal(get('old-report').patrol.report, 'Retained report')
  for (const name of ['malformed', 'missing', 'traversal']) {
    assert.equal(get(name).patrol.status, 'unknown')
    assert.equal(get(name).patrol.report, '')
    assert.equal(get(name).problems[0].code, 'patrol_data_unreadable')
  }
  assert.ok(!JSON.stringify(body).includes('must not appear'))
  await server.stop()
})

test('linked patrol directories never expose an outside report', async t => {
  const { home, root } = fixture(t)
  const { directory } = writeProject(root, 'linked')
  const outside = path.join(home, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'latest.md'), 'outside-secret-fixture')
  try { fs.symlinkSync(outside, path.join(directory, 'patrol'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('Symlinks unavailable')
    throw error
  }
  const server = await startWeb(t, home)
  const { body } = await server.read()
  assert.equal(body.projects[0].patrol.status, 'unknown')
  assert.equal(body.projects[0].problems[0].code, 'patrol_data_unreadable')
  assert.ok(!JSON.stringify(body).includes('outside-secret-fixture'))
  await server.stop()
})

test('UI refresh keeps the selected digest even when display labels collide', async () => {
  const elements = new Map()
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', addEventListener() {} })
      return elements.get(selector)
    },
    querySelectorAll() { return [] },
  }
  const repositories = [
    { platform: 'gitlab', instance: 'https://code.example.invalid/x', path: 'gitlab/team/ui' },
    { platform: 'gitlab', instance: 'https://code.example.invalid/x/gitlab', path: 'team/ui' },
  ]
  let projects = repositories.map(repository => ({
    repository, digest: repositoryDigest(repository), repo: repositoryDisplay(repository), problems: [],
    config: { lifecycle: { status: 'active' }, parent: { status: 'unknown' }, tracking: { status: 'pending' } },
    todos: { items: [], total: 0, active: 0, backlog: 0 },
    patrol: { runId: null, status: 'not_run', report: '' },
  }))
  const context = { document, fetch: async () => ({ ok: true, json: async () => ({ projects, problems: [], generatedAt: '2026-10-02T00:00:00Z' }) }) }
  runInNewContext(fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8'), context)
  await runInNewContext('load()', context)
  const selected = projects[1].digest
  runInNewContext(`openProject("${selected}")`, context)
  projects = projects.slice().reverse()
  await runInNewContext('load()', context)
  assert.equal(runInNewContext('state.selected.digest', context), selected)
  assert.ok(elements.get('#app').innerHTML.includes('https://code.example.invalid/x/gitlab'))
  assert.ok(!elements.get('#app').innerHTML.includes('role unknown'))
  projects = [projects[1]]
  await runInNewContext('load()', context)
  assert.equal(runInNewContext('state.selected', context), null)
  assert.equal(runInNewContext('state.view', context), 'overview')
})

test('UI shows unknown totals, diagnostics, and no fake empty queue after a read error', async () => {
  const elements = new Map()
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', addEventListener() {} })
      return elements.get(selector)
    },
    querySelectorAll() { return [] },
  }
  const repository = { platform: 'gitlab', instance: 'https://code.example.invalid', path: 'team/ui' }
  const problems = [{ code: 'todo_data_unreadable', repository, message: '<script>unreadable</script>' }]
  const project = {
    repository, digest: repositoryDigest(repository), problems,
    config: { lifecycle: { status: 'active' }, parent: { status: 'unknown' }, tracking: { status: 'pending' } },
    todos: { items: null, active: null, total: null, backlog: null }, patrol: { status: 'unknown' },
  }
  const context = { document, fetch: async () => ({ ok: true, json: async () => ({ projects: [project], problems, generatedAt: '2026-10-02T00:00:00Z' }) }) }
  runInNewContext(fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8'), context)
  await runInNewContext('load()', context)
  assert.match(elements.get('#app').innerHTML, />unknown</)
  for (const command of ['renderTodos()', `openProject("${project.digest}")`]) {
    runInNewContext(command, context)
    const html = elements.get('#app').innerHTML
    assert.match(html, /Todo data unavailable/)
    assert.match(html, /&lt;script&gt;unreadable&lt;\/script&gt;/)
    assert.doesNotMatch(html, /<script>|No todos|No patrol report yet/)
  }
})
