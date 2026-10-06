import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

test('projects API filters archived projects without losing history', { timeout: 20000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contribbot-web-archive-'))
  for (const [name, config] of [
    ['legacy', 'role: admin\n'],
    ['active', 'status: active\n'],
    ['archived', 'status: archived\narchived_at: "2026-09-16T00:00:00Z"\n'],
  ]) {
    const dir = path.join(home, '.contribbot', 'owner', name)
    fs.mkdirSync(path.join(dir, 'patrol'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.yaml'), config)
    fs.writeFileSync(path.join(dir, 'patrol/latest.md'), 'old report retained')
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
  assert.deepEqual(active.projects.map(p => p.repo), ['owner/active', 'owner/legacy'])
  const archived = await (await fetch(`${url}/api/projects?status=archived`)).json()
  assert.equal(archived.projects.length, 1)
  assert.equal(archived.projects[0].config.status, 'archived')
  assert.equal(archived.projects[0].patrol.report, 'old report retained')
  const all = await (await fetch(`${url}/api/projects?status=all`)).json()
  assert.equal(all.projects.length, 3)
  assert.equal((await fetch(`${url}/api/projects?status=typo`)).status, 400)
})
