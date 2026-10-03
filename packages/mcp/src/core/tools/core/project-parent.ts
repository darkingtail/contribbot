import { ghApi } from '../../clients/github.js'
import { RepoConfig, type ParentConfig } from '../../storage/repo-config.js'
import {
  parseRepositoryInput,
  projectDirectory,
  repositoryDisplay,
  sameRepository,
  type RepositoryRef,
} from '../../utils/repository-ref.js'

interface GitHubRelationship {
  full_name?: unknown
  fork?: unknown
  parent?: { full_name?: unknown } | null
}

export type ParentRefreshResult =
  | { status: 'refreshed', parent: ParentConfig }
  | { status: 'unavailable', parent: ParentConfig }

/**
 * Read-only remote observation followed by a conditional local config update.
 * This does not initialize a project or make parent a tracking source.
 */
export async function refreshParentRelation(repository: RepositoryRef): Promise<ParentRefreshResult> {
  const canonical = parseRepositoryInput(repository)
  if (canonical.platform !== 'github' || canonical.instance !== 'https://github.com') {
    throw new Error('Parent relationship refresh currently supports only repositories on GitHub.com.')
  }

  const store = new RepoConfig(projectDirectory(canonical))
  const snapshot = store.load()
  if (!snapshot) throw new Error('Project is not initialized. Use project_init first.')

  const observed = await ghApi<GitHubRelationship>(`/repos/${canonical.path}`)
  if (observed?.full_name !== canonical.path) {
    throw new Error('GitHub repository identity changed or could not be verified; parent was not updated.')
  }

  let next: ParentConfig
  if (observed.fork === false) {
    next = { status: 'none', relation_verified_at: new Date().toISOString() }
  }
  else if (observed.fork === true && typeof observed.parent?.full_name === 'string') {
    const parent = parseRepositoryInput({
      platform: canonical.platform,
      instance: canonical.instance,
      path: observed.parent.full_name,
    })
    if (sameRepository(canonical, parent)) {
      throw new Error('GitHub returned a self-referential parent; parent was not updated.')
    }
    next = { status: 'confirmed', repository: parent, relation_verified_at: new Date().toISOString() }
  }
  else {
    return { status: 'unavailable', parent: snapshot.parent }
  }

  const updated = store.update({ parent: next }, snapshot)
  if (!updated) throw new Error('Project config disappeared during parent refresh.')
  return { status: 'refreshed', parent: updated.parent }
}

export async function parentRefreshResult(repo: RepositoryRef) {
  const repository = parseRepositoryInput(repo)
  const result = await refreshParentRelation(repository)
  const parent = result.parent
  const markdown = [
    `# Parent Relationship - ${repositoryDisplay(repository)}`,
    `- Refresh status: \`${result.status}\``,
    result.status === 'unavailable'
      ? '**Parent relationship was not reverified. This request did not update the local config. The returned snapshot was read before the query and is not fresh evidence.**'
      : 'The direct parent relationship was verified. Only the local parent snapshot was updated.',
    '',
    '| Field | Value | Notes |',
    '| --- | --- | --- |',
    `| Repository | \`${repositoryDisplay(repository)}\` | Explicitly managed project |`,
    `| Parent status | \`${parent.status}\` | unknown is not evidence of no parent |`,
    `| Direct parent | ${parent.status === 'confirmed' ? `\`${repositoryDisplay(parent.repository)}\`` : '-'} | Direct fork origin, not the root of the fork network |`,
    `| Relation verified at | ${parent.status === 'unknown' ? 'Not verified' : `\`${parent.relation_verified_at}\``} | Last successful relationship verification, not a code sync time |`,
    '',
    'No project initialization, code synchronization, tracking change, lifecycle change, Todo update or remote write was performed.',
  ].join('\n')
  return {
    markdown,
    context: { schema_version: 1 as const, repository, ...result },
  }
}
