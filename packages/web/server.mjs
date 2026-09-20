import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const root = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(root, 'public')
const dataDir = path.join(os.homedir(), '.contribbot')
const port = Number(process.env.PORT || 4173)
const projectMarkers = [
  'config.yaml',
  'todos.yaml',
  'upstream.yaml',
  'knowledge.proposals.yaml',
  'todos.archive.yaml',
  'upstream.archive.yaml',
]

async function isTrackedProjectDir(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const names = new Set(entries.map(entry => entry.name))
  return projectMarkers.some(marker => names.has(marker))
    || ['knowledge', 'patrol', 'sync'].some(folder => names.has(folder))
}

async function readText(file, fallback = '') {
  try { return await fs.readFile(file, 'utf8') } catch { return fallback }
}

async function readYaml(file, fallback = {}) {
  try { return YAML.parse(await fs.readFile(file, 'utf8')) ?? fallback } catch { return fallback }
}

async function listProjects(status = 'active') {
  const owners = await fs.readdir(dataDir, { withFileTypes: true }).catch(() => [])
  const projects = []
  for (const owner of owners.filter(item => item.isDirectory() && !['remediation', 'worktrees'].includes(item.name))) {
    const repos = await fs.readdir(path.join(dataDir, owner.name), { withFileTypes: true }).catch(() => [])
    for (const repo of repos.filter(item => item.isDirectory())) {
      const dir = path.join(dataDir, owner.name, repo.name)
      if (!await isTrackedProjectDir(dir)) continue
      const config = await readYaml(path.join(dir, 'config.yaml'))
      const projectStatus = config.status ?? 'active'
      if (status !== 'all' && projectStatus !== status) continue
      const todos = await readYaml(path.join(dir, 'todos.yaml'), { todos: [] })
      const latest = await readYaml(path.join(dir, 'patrol', 'latest.json'), {})
      const runId = latest.run_id
      const reportPath = runId
        ? path.join(dir, 'patrol', 'runs', runId, 'report.md')
        : path.join(dir, 'patrol', 'latest.md')
      const report = await readText(reportPath)
      const items = Array.isArray(todos.todos) ? todos.todos : []
      projects.push({
        repo: `${owner.name}/${repo.name}`,
        config: { role: config.role ?? null, fork: config.fork ?? null, upstream: config.upstream ?? null, status: projectStatus, archived_at: config.archived_at ?? null },
        todos: {
          total: items.length,
          active: items.filter(item => item.status === 'active').length,
          backlog: items.filter(item => ['backlog', 'idea'].includes(item.status)).length,
          done: items.filter(item => item.status === 'done').length,
          paused: items.filter(item => item.status === 'paused').length,
          cancelled: items.filter(item => item.status === 'cancelled').length,
          items,
        },
        patrol: {
          runId: runId ?? null,
          status: latest.status ?? 'not_run',
          report,
          recordedAt: latest.recorded_at ?? null,
        },
      })
    }
  }
  return projects.sort((a, b) => a.repo.localeCompare(b.repo))
}

function sendJson(res, value) {
  const body = JSON.stringify(value)
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (url.pathname === '/api/projects') {
    const status = url.searchParams.get('status') || 'active'
    if (!['active', 'archived', 'all'].includes(status)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Invalid project status filter' }))
    }
    return sendJson(res, { projects: await listProjects(status), generatedAt: new Date().toISOString() })
  }
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  const file = path.resolve(publicDir, requested)
  if (!file.startsWith(path.resolve(publicDir))) {
    res.writeHead(403); return res.end('Forbidden')
  }
  try {
    const body = await fs.readFile(file)
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
    res.writeHead(200, { 'content-type': `${types[path.extname(file)] ?? 'application/octet-stream'}; charset=utf-8` })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('Not found')
  }
}

const server = http.createServer(handler)
server.listen(port, '127.0.0.1', () => {
  console.log(`contribbot web http://127.0.0.1:${server.address().port}`)
})
