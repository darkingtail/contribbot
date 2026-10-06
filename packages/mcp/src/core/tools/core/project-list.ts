import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { TodoStore } from '../../storage/todo-store.js'
import { UpstreamStore } from '../../storage/upstream-store.js'
import { markdownTable } from '../../utils/format.js'
import { RepoConfig } from '../../storage/repo-config.js'
import type { ProjectStatus } from '../../enums.js'

const RESERVED_RUNTIME_DIRS = new Set(['remediation', 'worktrees'])

const PROJECT_MARKERS = [
  'config.yaml',
  'todos.yaml',
  'upstream.yaml',
  'knowledge.proposals.yaml',
  'todos.archive.yaml',
  'upstream.archive.yaml',
]

function isTrackedProjectDir(dir: string): boolean {
  return PROJECT_MARKERS.some(marker => existsSync(join(dir, marker)))
    || ['knowledge', 'patrol', 'sync'].some(folder => existsSync(join(dir, folder)))
}

export function projectList(status: ProjectStatus | 'all' = 'active'): string {
  if (!['active', 'archived', 'all'].includes(status)) throw new Error('Invalid project status filter.')
  const contribRoot = join(homedir(), '.contribbot')

  if (!existsSync(contribRoot)) {
    return '## Projects\n\n_No projects configured. Data will appear after using contrib tools._'
  }

  const owners = readdirSync(contribRoot).filter((f) => {
    const p = join(contribRoot, f)
    return statSync(p).isDirectory() && !f.startsWith('.') && !RESERVED_RUNTIME_DIRS.has(f)
  })

  interface ProjectInfo {
    fullName: string
    todosOpen: number
    todosDone: number
    upstreamPending: number
    upstreamTotal: number
    lastActive: string
    status: ProjectStatus
  }

  const projects: ProjectInfo[] = []

  for (const owner of owners) {
    const ownerDir = join(contribRoot, owner)
    const repos = readdirSync(ownerDir).filter((f) => {
      const repoDir = join(ownerDir, f)
      return statSync(repoDir).isDirectory() && isTrackedProjectDir(repoDir)
    })

    for (const repo of repos) {
      const repoDir = join(ownerDir, repo)
      const fullName = `${owner}/${repo}`
      const projectStatus = new RepoConfig(repoDir).load()?.status ?? 'active'
      if (status !== 'all' && status !== projectStatus) continue

      const todoStore = new TodoStore(repoDir)
      const todos = todoStore.list()
      const todosOpen = todos.filter(t => t.status !== 'done').length
      const todosDone = todos.filter(t => t.status === 'done').length

      const upstreamStore = new UpstreamStore(repoDir)
      const upstreamRepos = upstreamStore.listRepos()
      let upstreamPending = 0
      let upstreamTotal = 0
      for (const ur of upstreamRepos) {
        const daily = upstreamStore.getDaily(ur)
        upstreamTotal += daily.commits.length
        upstreamPending += daily.commits.filter(c => c.action === null).length
      }

      let lastActive = '—'
      try {
        const todosYaml = join(repoDir, 'todos.yaml')
        const upstreamYaml = join(repoDir, 'upstream.yaml')
        const times: number[] = []
        if (existsSync(todosYaml)) times.push(statSync(todosYaml).mtimeMs)
        if (existsSync(upstreamYaml)) times.push(statSync(upstreamYaml).mtimeMs)
        if (times.length > 0) {
          lastActive = new Date(Math.max(...times)).toISOString().slice(0, 10)
        }
      } catch {
        // ignore
      }

      projects.push({ fullName, todosOpen, todosDone, upstreamPending, upstreamTotal, lastActive, status: projectStatus })
    }
  }

  if (projects.length === 0) {
    return `## Projects\n\n_No ${status === 'all' ? '' : `${status} `}projects found. Use project_list with status "all" to include archived projects._`
  }

  const headers = ['Project', 'Status', 'Todos (open/done)', 'Upstream (pending/total)', 'Last Active', 'Note']
  const rows = projects.map(p => [
    p.fullName,
    p.status,
    `${p.todosOpen} / ${p.todosDone}`,
    p.upstreamTotal > 0 ? `${p.upstreamPending} / ${p.upstreamTotal}` : '—',
    p.lastActive,
    p.status === 'archived' ? 'Archived; data retained, patrol blocked' : 'Active maintenance',
  ])

  return `## Projects\n\n> ${projects.length} projects tracked (filter: ${status})\n\n${markdownTable(headers, rows)}`
}
