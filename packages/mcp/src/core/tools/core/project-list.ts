import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { TodoStore } from '../../storage/todo-store.js'
import { UpstreamStore } from '../../storage/upstream-store.js'
import { markdownTable } from '../../utils/format.js'
import type { ProjectStatus } from '../../enums.js'
import { repositoryDigest, repositoryDisplay, type RepositoryRef } from '../../utils/repository-ref.js'
import { scanStoredProjects, type ProjectProblem } from 'contribbot-core/repository/projects'
export { listStoredProjects, scanStoredProjects, PROJECT_PROBLEM_CODES } from 'contribbot-core/repository/projects'
export type { ProjectProblemCode, ProjectProblem } from 'contribbot-core/repository/projects'

const TODO_READ_ERROR_NOTE = 'Todo data unreadable (todos.yaml); use todo_list for this project to inspect the error.'

function formatTodoCounts(open: number | null, done: number | null): string {
  return `${open === null ? 'unknown' : open} / ${done === null ? 'unknown' : done}`
}

export interface ProjectListResult {
  markdown: string
  projects: { repository: RepositoryRef, digest: string, status: ProjectStatus }[]
  problems: ProjectProblem[]
}

export function projectListResult(status: ProjectStatus | 'all' = 'active'): ProjectListResult {
  if (!['active', 'archived', 'all'].includes(status)) throw new Error('Invalid project status filter.')
  const scan = scanStoredProjects()
  const storedProjects = scan.projects

  interface ProjectInfo {
    repository: RepositoryRef
    fullName: string
    todosOpen: number | null
    todosDone: number | null
    upstreamPending: number | null
    upstreamTotal: number | null
    lastActive: string
    status: ProjectStatus
  }

  const projects: ProjectInfo[] = []
  const problems = [...scan.problems]
  for (const { directory: repoDir, config } of storedProjects) {
    const fullName = repositoryDisplay(config.repository)
    const projectStatus = config.lifecycle.status
    if (status !== 'all' && status !== projectStatus) continue

    const todoStore = new TodoStore(repoDir)
    let todosOpen: number | null = null
    let todosDone: number | null = null
    try {
      const todos = todoStore.list()
      todosOpen = todos.filter(t => !['done', 'cancelled'].includes(t.status)).length
      todosDone = todos.filter(t => t.status === 'done').length
    }
    catch (error) {
      problems.push({
        code: 'todo_data_unreadable',
        directory: repoDir,
        repository: config.repository,
        message: TODO_READ_ERROR_NOTE,
      })
    }

    let upstreamPending: number | null = 0
    let upstreamTotal: number | null = 0
    try {
      const upstreamStore = new UpstreamStore(repoDir)
      const upstreamRepos = upstreamStore.listRepos()
      for (const ur of upstreamRepos) {
        const daily = upstreamStore.getDaily(ur)
        upstreamTotal += daily.commits.length
        upstreamPending += daily.commits.filter(c => c.action === null).length
      }
    }
    catch (error) {
      upstreamPending = null
      upstreamTotal = null
      problems.push({
        code: 'upstream_data_unreadable',
        directory: repoDir,
        repository: config.repository,
        message: 'Upstream data unreadable (upstream.yaml); use upstream_list for this project to inspect the error.',
      })
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

    projects.push({ repository: config.repository, fullName, todosOpen, todosDone, upstreamPending, upstreamTotal, lastActive, status: projectStatus })
  }

  const headers = ['Project', 'Status', 'Todos (open/done)', 'Upstream (pending/total)', 'Last Active', 'Note']
  const rows = projects.map(p => [
    p.fullName,
    p.status,
    formatTodoCounts(p.todosOpen, p.todosDone),
    p.upstreamTotal === null ? 'unknown / unknown' : p.upstreamTotal > 0 ? `${p.upstreamPending} / ${p.upstreamTotal}` : '—',
    p.lastActive,
    p.status === 'archived' ? 'Archived; data retained, patrol blocked' : 'Active maintenance',
  ])

  const problemMarkdown = problems.length === 0
    ? ''
    : `\n\n## Project Diagnostics\n\n> ${problems.length} diagnostic problem(s) reported; no damaged data was modified.\n\n${
      markdownTable(
        ['Code', 'Directory', 'Repository', 'Message', 'Note'],
        problems.map(problem => [
          problem.code,
          problem.directory,
          problem.repository ? repositoryDisplay(problem.repository) : '—',
          problem.message,
          'Needs direct inspection before repair or write',
        ]),
      )
    }`

  const projectMarkdown = projects.length === 0
    ? `_No ${status === 'all' ? '' : `${status} `}projects found. Use project_list with status "all" to include archived projects._`
    : `> ${projects.length} projects tracked (filter: ${status})\n\n${markdownTable(headers, rows)}`

  return {
    markdown: `## Projects\n\n${projectMarkdown}${problemMarkdown}`,
    projects: projects.map(({ repository, status: projectStatus }) => ({
      repository,
      digest: repositoryDigest(repository),
      status: projectStatus,
    })),
    problems,
  }
}

export function projectList(status: ProjectStatus | 'all' = 'active'): string {
  return projectListResult(status).markdown
}
