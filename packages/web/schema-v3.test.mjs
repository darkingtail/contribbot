import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import YAML from 'yaml'

function repositoryDigest(repository) {
  return createHash('sha256').update(JSON.stringify([
    'repository-key-v1', repository.platform, repository.instance, repository.path,
  ])).digest('hex')
}

function fingerprint(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const file = path.join(directory, entry.name)
      return entry.isDirectory()
        ? fingerprint(file).map(([name, digest]) => [path.join(entry.name, name), digest])
        : [[entry.name, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]]
    })
}

test('Web discovers both v3 projects with the same path on different instances without writes', { timeout: 20000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contribbot-web-v3-'))
  const dataRoot = path.join(home, '.contribbot')
  const repositories = [
    { platform: 'gitlab', instance: 'https://first.example.invalid/gitlab', path: 'team/ui' },
    { platform: 'gitlab', instance: 'https://second.example.invalid:8443/gitlab', path: 'team/ui' },
  ]
  for (const repository of repositories) {
    const directory = path.join(dataRoot, 'projects', 'v1', repositoryDigest(repository))
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'config.yaml'), YAML.stringify({
      schema_version: 3, repository, lifecycle: { status: 'active' },
      parent: { status: 'unknown' }, tracking: { status: 'pending' },
    }))
    fs.writeFileSync(path.join(directory, 'todos.yaml'), 'todos: []\n')
  }
  const before = fingerprint(dataRoot)
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { ...process.env, HOME: home, USERPROFILE: home, PORT: '0' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let ended = false
  const closed = new Promise(resolve => child.once('close', () => { ended = true; resolve() }))
  t.after(async () => {
    if (!ended) child.kill()
    await closed
    assert.deepEqual(fingerprint(dataRoot), before, 'Listing must not write, convert, or create data')
    const relative = path.relative(os.tmpdir(), home)
    assert.ok(relative.startsWith('contribbot-web-v3-') && !relative.includes(path.sep))
    fs.rmSync(home, { recursive: true, force: true })
  })
  const address = await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`Web startup timeout: ${stderr}`)), 10000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    closed.then(() => { clearTimeout(timer); reject(new Error(`Web exited: ${stderr}`)) })
    child.stderr.on('data', value => { stderr += value.toString('utf8') })
    child.stdout.on('data', value => {
      stdout += value.toString('utf8')
      const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
      if (url) { clearTimeout(timer); resolve(url) }
    })
  })
  for (const status of ['active', 'all']) {
    const response = await fetch(`${address}/api/projects?status=${status}`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.projects.length, 2, 'Both valid v3 projects must remain visible')
    assert.deepEqual(result.projects.map(project => project.repository)
      .sort((a, b) => a.instance.localeCompare(b.instance)), repositories)
  }
})
