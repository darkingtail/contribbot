import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { projectDirectory, repositoryDigest } from 'contribbot-core/repository/ref'

test('projects API filters archived projects without losing history', { timeout: 20000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contribbot-web-archive-'))
  for (const name of ['active', 'other', 'archived']) {
    const repository = { platform: 'github', instance: 'https://github.com', path: `owner/${name}` }
    const dir = projectDirectory(repository, path.join(home, '.contribbot'))
    fs.mkdirSync(path.join(dir, 'patrol'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.yaml'), JSON.stringify({
      schema_version: 3, repository,
      lifecycle: name === 'archived' ? { status: 'archived', archived_at: '2026-09-16T00:00:00Z' } : { status: 'active' },
      parent: { status: 'unknown' }, tracking: { status: 'pending' },
    }))
    fs.writeFileSync(path.join(dir, 'patrol/latest.md'), 'old report retained')
    fs.writeFileSync(path.join(dir, 'todos.archive.yaml'), JSON.stringify({
      todos: [{ title: 'Already archived', status: 'done', archived: '2026-09-16' }],
    }))
    fs.writeFileSync(path.join(dir, 'todos.yaml'), JSON.stringify({ todos: [
      ...Array.from({ length: 8 }, (_, i) => ({ title: `work-${i}`, status: 'active' })),
      { title: 'Finished', status: 'done' }, { title: 'Stopped', status: 'cancelled' },
      { title: 'Review', status: 'active', pr: 42, pull_requests: [
        { repo: repository, number: 41 }, { repo: repository, number: 42 },
      ] },
      { title: 'Paused design', status: 'paused' }, { title: 'Cancelled work', status: 'cancelled' },
      { title: 'Idea', status: 'idea' }, { title: 'Backlog', status: 'backlog' },
    ] }))
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { ...process.env, HOME: home, USERPROFILE: home, PORT: '0' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    const relative = path.relative(os.tmpdir(), home)
    assert.ok(relative.startsWith('contribbot-web-archive-') && !relative.includes(path.sep))
    fs.rmSync(home, { recursive: true, force: true })
  })
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Web startup timeout')), 10000)
    let text = ''
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Web exited: ${code}`)) })
    child.stdout.on('data', chunk => {
      text += chunk
      const address = text.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
      if (address) { clearTimeout(timer); resolve(address) }
    })
  })
  const active = await (await fetch(`${url}/api/projects`)).json()
  assert.deepEqual(active.projects.map(p => p.repository.path), ['owner/active', 'owner/other'])
  assert.deepEqual(active.problems, [])
  assert.equal(active.projects[0].todos.done, 1)
  assert.equal(Object.hasOwn(active.projects[0].todos, 'notPlanned'), false)
  assert.equal(active.projects[0].todos.active, 9)
  assert.equal(active.projects[0].todos.backlog, 2)
  assert.equal(active.projects[0].todos.total, 15)
  assert.equal(active.projects[0].todos.items.length, 15)
  assert.equal(active.projects[0].todos.items.some(todo => todo.title === 'Already archived'), false)
  assert.equal(active.projects[0].todos.paused, 1)
  assert.equal(active.projects[0].todos.cancelled, 2)
  assert.equal(active.projects[0].todos.items[8].status, 'done')
  assert.equal(active.projects[0].todos.items[10].status, 'active')
  assert.deepEqual(active.projects[0].todos.items[10].pull_requests, [
    {
      repo: { platform: 'github', instance: 'https://github.com', path: 'owner/active' },
      number: 41,
    },
    {
      repo: { platform: 'github', instance: 'https://github.com', path: 'owner/active' },
      number: 42,
    },
  ])
  const archived = await (await fetch(`${url}/api/projects?status=archived`)).json()
  assert.equal(archived.projects.length, 1)
  assert.equal(archived.projects[0].config.lifecycle.status, 'archived')
  assert.equal(archived.projects[0].patrol.report, 'old report retained')
  const all = await (await fetch(`${url}/api/projects?status=all`)).json()
  assert.equal(all.projects.length, 3)
  assert.equal((await fetch(`${url}/api/projects?status=typo`)).status, 400)
})

test('Todo queue and project detail show current lifecycle states independently of PR links', async () => {
  const elements = new Map()
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', addEventListener() {} })
      return elements.get(selector)
    },
    querySelectorAll() { return [] },
  }
  const statuses = ['idea', 'backlog', 'active', 'paused', 'done', 'cancelled']
  const repository = { platform: 'github', instance: 'https://github.com', path: 'owner/repo' }
  const project = {
    repo: 'github://github.com/owner/repo', repository, digest: repositoryDigest(repository), problems: [],
    config: { lifecycle: { status: 'active' }, parent: { status: 'unknown' }, tracking: { status: 'pending' } }, patrol: { status: 'not_run' },
    todos: { active: 1, backlog: 2, total: statuses.length,
      items: statuses.map(status => ({ title: `Todo ${status}`, status, pr: 42 })) },
  }
  const context = {
    document,
    fetch: async () => ({ ok: true, json: async () => ({ projects: [project], problems: [], generatedAt: '2026-10-02T00:00:00Z' }) }),
  }
  runInNewContext(fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8'), context)
  await runInNewContext('load()', context)
  for (const command of ['renderTodos()', `openProject("${project.digest}")`]) {
    runInNewContext(command, context)
    const html = elements.get('#app').innerHTML
    for (const status of statuses) {
      const label = `${status}${['done', 'cancelled'].includes(status) ? ' · not archived' : ''}`
      assert.ok(html.includes(`${label} · no branch`), `${command}: missing ${label}`)
    }
    assert.equal((html.match(/not archived/g) ?? []).length, 2)
  }
})
