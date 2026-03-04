import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { TodoStore } from '../storage/todo-store.js'
import { UpstreamStore } from '../storage/upstream-store.js'
import { markdownTable } from '../utils/format.js'

export function projectList(): string {
  const contribRoot = join(homedir(), '.contribbot')

  if (!existsSync(contribRoot)) {
    return '## Projects\n\n_No projects configured. Data will appear after using contrib tools._'
  }

  const owners = readdirSync(contribRoot).filter((f) => {
    const p = join(contribRoot, f)
    return statSync(p).isDirectory() && !f.startsWith('.')
  })

  interface ProjectInfo {
    fullName: string
    todosOpen: number
    todosDone: number
    upstreamPending: number
    upstreamTotal: number
    lastActive: string
  }

  const projects: ProjectInfo[] = []

  for (const owner of owners) {
    const ownerDir = join(contribRoot, owner)
    const repos = readdirSync(ownerDir).filter((f) => {
      return statSync(join(ownerDir, f)).isDirectory()
    })

    for (const repo of repos) {
      const repoDir = join(ownerDir, repo)
      const fullName = `${owner}/${repo}`

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

      projects.push({ fullName, todosOpen, todosDone, upstreamPending, upstreamTotal, lastActive })
    }
  }

  if (projects.length === 0) {
    return '## Projects\n\n_No projects found._'
  }

  const headers = ['Project', 'Todos (open/done)', 'Upstream (pending/total)', 'Last Active']
  const rows = projects.map(p => [
    p.fullName,
    `${p.todosOpen} / ${p.todosDone}`,
    p.upstreamTotal > 0 ? `${p.upstreamPending} / ${p.upstreamTotal}` : '—',
    p.lastActive,
  ])

  return `## Projects\n\n> ${projects.length} projects tracked\n\n${markdownTable(headers, rows)}`
}
