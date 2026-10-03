import { RepoConfig } from '../../storage/repo-config.js'
import type { ProjectStatus } from '../../enums.js'
import { resolveRepo, resolveRepoIdentity } from '../../utils/resolve-repo.js'
import { repositoryDisplay, type RepositoryInput } from '../../utils/repository-ref.js'

/** Read-only, including for an unconfigured repository. Never initializes/reactivates it. */
export async function projectStatus(repo: RepositoryInput): Promise<string> {
  const { repository, directory } = await resolveRepoIdentity(repo)
  const config = new RepoConfig(directory).load()
  return JSON.stringify({
    repo: repositoryDisplay(repository),
    configured: config !== null,
    status: config?.lifecycle.status ?? 'not_initialized',
    archived_at: config?.lifecycle.archived_at ?? null,
  })
}

async function setStatus(repo: RepositoryInput, status: ProjectStatus): Promise<string> {
  const { repository, directory } = await resolveRepo(repo)
  const label = repositoryDisplay(repository)
  const store = new RepoConfig(directory)
  const config = store.load()
  if (!config) throw new Error(`Project ${label} has no config. Use project_init first.`)
  const before = config.lifecycle.status
  if (before === status) return `## Project — ${label}\n\nAlready **${status}**. No data changed.`
  store.update({
    lifecycle: status === 'archived'
      ? { status, archived_at: new Date().toISOString() }
      : { status },
  }, config)
  if (store.load()?.lifecycle.status !== status) throw new Error('Project status verification failed.')
  return [
    `## Project — ${label}`, '',
    `**${before} → ${status}**`, '',
    'Todos, knowledge, upstream tracking and patrol history are preserved. GitHub is unchanged.',
    status === 'archived'
      ? 'Excluded from the default project list. New patrol/resume attempts are blocked. An already running patrol is not cancelled. Use project_restore to resume maintenance.'
      : 'Included in the default project list again. No patrol has been started.',
  ].join('\n')
}

export const projectArchive = (repo: RepositoryInput): Promise<string> => setStatus(repo, 'archived')
export const projectRestore = (repo: RepositoryInput): Promise<string> => setStatus(repo, 'active')
