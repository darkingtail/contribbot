import { RepoConfig } from '../storage/repo-config.js'
import { getProjectDir } from './config.js'
import { parseRepositoryInput, repositoryDisplay, type RepositoryInput, type RepositoryRef } from './repository-ref.js'

export interface ResolvedRepository {
  repository: RepositoryRef
  directory: string
  owner: string
  name: string
}

/**
 * Resolve an explicit repository identity without requiring a local project.
 * Use only for operations that intentionally work before project_init.
 */
export async function resolveRepoIdentity(repo?: RepositoryInput): Promise<ResolvedRepository> {
  const repository = parseRepositoryInput(repo)
  const parts = repository.path.split('/')
  const name = parts.at(-1)!
  const owner = parts.slice(0, -1).join('/')
  return {
    repository,
    directory: getProjectDir(repository),
    owner,
    name,
  }
}

/** Require the requested local project before reading or writing project data. */
export async function resolveRepo(repo?: RepositoryInput): Promise<ResolvedRepository> {
  const resolved = await resolveRepoIdentity(repo)
  if (!new RepoConfig(resolved.directory).load()) {
    throw new Error(`Project ${repositoryDisplay(resolved.repository)} is not initialized. Use project_init first.`)
  }
  return resolved
}
