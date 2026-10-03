import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanStoredProjects } from 'contribbot-core/repository/projects'
import { repositoryDigest, repositoryDisplay } from 'contribbot-core/repository/ref'
import { readTodoItems } from 'contribbot-core/todo/file-read'
import { assertNoSymlinks } from 'contribbot-core/storage/paths'

const root = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(root, 'public')
const port = Number(process.env.PORT || 4173)

async function readOptionalText(file) {
  assertNoSymlinks(file)
  try { return await fs.readFile(file, 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function readPatrol(directory) {
  const patrolDir = path.join(directory, 'patrol')
  const content = await readOptionalText(path.join(patrolDir, 'latest.json'))
  if (content === null) {
    const report = await readOptionalText(path.join(patrolDir, 'latest.md'))
    return { runId: null, status: report === null ? 'not_run' : 'unknown', report: report ?? '', recordedAt: null }
  }
  const latest = JSON.parse(content)
  if (!latest || typeof latest !== 'object' || Array.isArray(latest)
    || typeof latest.run_id !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(latest.run_id)
    || (latest.status !== undefined && (typeof latest.status !== 'string' || !latest.status.trim()))
    || (latest.recorded_at !== undefined && (typeof latest.recorded_at !== 'string' || !Number.isFinite(Date.parse(latest.recorded_at))))) {
    throw new Error('Invalid patrol latest.json metadata.')
  }
  // Report locations are derived from a single safe run ID, never a stored arbitrary path.
  const report = await readOptionalText(path.join(patrolDir, 'runs', latest.run_id, 'report.md'))
  if (report === null) throw new Error(`Patrol report missing for run ${latest.run_id}.`)
  return { runId: latest.run_id, status: latest.status ?? 'unknown', report, recordedAt: latest.recorded_at ?? null }
}

async function listProjects(status = 'active') {
  const scan = scanStoredProjects()
  const problems = [...scan.problems]
  const projects = []
  for (const { directory, config } of scan.projects) {
    if (status !== 'all' && config.lifecycle.status !== status) continue
    const projectProblems = []
    function problem(code, error) {
      const entry = { code, directory, repository: config.repository, message: error instanceof Error ? error.message : String(error) }
      problems.push(entry)
      projectProblems.push(entry)
    }
    let items = null
    try {
      assertNoSymlinks(path.join(directory, 'todos.yaml'))
      items = readTodoItems(directory)
    }
    catch (error) { problem('todo_data_unreadable', error) }
    let patrol = { runId: null, status: 'unknown', report: '', recordedAt: null }
    try { patrol = await readPatrol(directory) }
    catch (error) { problem('patrol_data_unreadable', error) }
    const count = states => items === null ? null : items.filter(item => states.includes(item.status)).length
    projects.push({
      repository: config.repository,
      digest: repositoryDigest(config.repository),
      repo: repositoryDisplay(config.repository),
      config: { lifecycle: config.lifecycle, parent: config.parent, tracking: config.tracking },
      todos: {
        total: items === null ? null : items.length,
        active: count(['active']), backlog: count(['backlog', 'idea']),
        done: count(['done']), paused: count(['paused']), cancelled: count(['cancelled']),
        items,
      },
      patrol,
      problems: projectProblems,
    })
  }
  projects.sort((a, b) => a.repo.localeCompare(b.repo) || a.digest.localeCompare(b.digest))
  return { projects, problems }
}

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
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
    try { return sendJson(res, { ...await listProjects(status), generatedAt: new Date().toISOString() }) }
    catch (error) { return sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500) }
  }
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  const file = path.resolve(publicDir, requested)
  if (!file.startsWith(`${path.resolve(publicDir)}${path.sep}`)) {
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
