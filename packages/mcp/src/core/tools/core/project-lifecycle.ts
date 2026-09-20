import { RepoConfig } from '../../storage/repo-config.js'
import type { ProjectStatus } from '../../enums.js'
import { getContribDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'

/** Read-only, including for an unconfigured repository. Never initializes/reactivates it. */
export async function projectStatus(repo: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const config = new RepoConfig(getContribDir(owner, name)).load()
  return JSON.stringify({
    repo: `${owner}/${name}`,
    configured: config !== null,
    status: config?.status ?? 'active',
    archived_at: config?.archived_at ?? null,
  })
}

async function setStatus(repo: string, status: ProjectStatus): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const store = new RepoConfig(getContribDir(owner, name))
  const config = store.load()
  if (!config) throw new Error(`Project ${owner}/${name} has no config. Use project_init first.`)
  const before = config.status ?? 'active'
  if (before === status) return `## Project — ${owner}/${name}\n\nAlready **${status}**. No data changed.`
  store.update({ status, archived_at: status === 'archived' ? new Date().toISOString() : null })
  if (store.load()?.status !== status) throw new Error('Project status verification failed.')
  return [
    `## Project — ${owner}/${name}`, '',
    `**${before} → ${status}**`, '',
    'Todos, knowledge, upstream tracking and patrol history are preserved. GitHub is unchanged.',
    status === 'archived'
      ? 'Excluded from the default project list. New patrol/resume attempts are blocked. An already running patrol is not cancelled. Use project_restore to resume maintenance.'
      : 'Included in the default project list again. No patrol has been started.',
  ].join('\n')
}

export const projectArchive = (repo: string): Promise<string> => setStatus(repo, 'archived')
export const projectRestore = (repo: string): Promise<string> => setStatus(repo, 'active')
