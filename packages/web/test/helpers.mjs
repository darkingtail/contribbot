import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectDirectory } from 'contribbot-core/repository/ref'

export function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contribbot-web-boundary-'))
  t.after(() => {
    const relative = path.relative(os.tmpdir(), home)
    assert.ok(relative.startsWith('contribbot-web-boundary-') && !relative.includes(path.sep))
    fs.rmSync(home, { recursive: true, force: true })
  })
  return { home, root: path.join(home, '.contribbot') }
}

export function writeProject(root, name, overrides = {}) {
  const config = {
    schema_version: 3,
    repository: { platform: 'gitlab', instance: 'https://code.example.invalid/gitlab', path: `team/${name}` },
    lifecycle: { status: 'active' }, parent: { status: 'unknown' }, tracking: { status: 'pending' },
    ...overrides,
  }
  const directory = projectDirectory(config.repository, root)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'config.yaml'), JSON.stringify(config))
  return { directory, config }
}

export async function startWeb(t, home) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
    env: { ...process.env, HOME: home, USERPROFILE: home, PORT: '0' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let ended = false
  const closed = new Promise(resolve => child.once('close', () => { ended = true; resolve() }))
  const stop = async () => {
    if (!ended) child.kill()
    await closed
  }
  t.after(stop)
  const url = await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`Web startup timeout: ${stderr}`)), 10000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    closed.then(() => { clearTimeout(timer); reject(new Error(`Web exited: ${stderr}`)) })
    child.stderr.on('data', value => { stderr += value })
    child.stdout.on('data', value => {
      stdout += value
      const url = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
      if (url) { clearTimeout(timer); resolve(url) }
    })
  })
  return { url, stop, read: async () => {
    const response = await fetch(`${url}/api/projects?status=all`, { signal: AbortSignal.timeout(5000) })
    return { status: response.status, body: await response.json() }
  } }
}
