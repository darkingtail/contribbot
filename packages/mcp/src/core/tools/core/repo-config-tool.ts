import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ghApi } from '../../clients/github.js'
import { verifyGitLabIdentity } from '../../clients/gitlab.js'
import {
  RepoConfig, inferMode, trackingStatus, trackingStatusMarker,
  type RepoConfigData,
} from '../../storage/repo-config.js'
import { getProjectRootDir } from '../../utils/config.js'
import { markdownTable } from '../../utils/format.js'
import {
  parseRepositoryInput, projectDirectory, repositoryDisplay, repositoryWebUrl,
  type RepositoryInput, type RepositoryRef,
} from '../../utils/repository-ref.js'

interface GitHubIdentity {
  full_name?: string
}

function storeFor(repository: RepositoryRef): RepoConfig {
  return new RepoConfig(projectDirectory(repository))
}

function assertNoLegacyData(repository: RepositoryRef): void {
  if (repository.platform !== 'github' || repository.instance !== 'https://github.com') return
  const legacy = join(getProjectRootDir(), ...repository.path.split('/'))
  if (existsSync(legacy)) {
    throw new Error(`Legacy project data at ${legacy} has not been handled. Back up or explicitly resolve it before initializing schema v3.`)
  }
}

async function verifyGitHubIdentity(requested: RepositoryRef): Promise<RepositoryRef> {
  if (requested.instance !== 'https://github.com') {
    throw new Error(`GitHub instance ${requested.instance} has no verified identity adapter yet.`)
  }
  const metadata = await ghApi<GitHubIdentity>(`/repos/${requested.path}`)
  if (typeof metadata?.full_name !== 'string') {
    throw new Error('GitHub identity response has no full_name; no project was created.')
  }
  const canonical = parseRepositoryInput({ ...requested, path: metadata.full_name })
  if (canonical.path.toLowerCase() !== requested.path.toLowerCase()) {
    throw new Error(`GitHub identity ${canonical.path} does not match requested ${requested.path}.`)
  }

  return canonical
}

/**
 * Only project_init creates a project. Existing projects remain usable offline,
 * including when the parent is private or otherwise temporarily inaccessible.
 */
export async function getOrInitConfig(repo: RepositoryInput): Promise<{
  config: RepoConfigData
  repository: RepositoryRef
  owner: string
  name: string
  directory: string
}> {
  const requested = parseRepositoryInput(repo)
  const initial = storeFor(requested).load()
  let config = initial
  if (!config) {
    assertNoLegacyData(requested)
    const directory = projectDirectory(requested)
    if (existsSync(directory) && readdirSync(directory).length > 0) {
      throw new Error(`Project directory ${directory} contains data without a valid config; initialization stopped.`)
    }
    const canonical = requested.platform === 'gitlab'
      ? await verifyGitLabIdentity(requested)
      : await verifyGitHubIdentity(requested)
    assertNoLegacyData(canonical)
    const canonicalStore = storeFor(canonical)
    config = canonicalStore.load()
    if (!config) {
      config = {
        schema_version: 3,
        repository: canonical,
        lifecycle: { status: 'active' },
        parent: { status: 'unknown' },
        tracking: { status: 'pending' },
      }
      canonicalStore.save(config)
    }
  }
  const parts = config.repository.path.split('/')
  return {
    config,
    repository: config.repository,
    owner: parts.slice(0, -1).join('/'),
    name: parts.at(-1)!,
    directory: projectDirectory(config.repository),
  }
}

/** Read or explicitly change tracking without implicit project creation or network access. */
export async function repoConfig(repo: RepositoryInput, tracking?: RepositoryRef[] | ''): Promise<string> {
  const repository = parseRepositoryInput(repo)
  const store = storeFor(repository)
  const config = store.load()
  if (!config) {
    if (tracking !== undefined) throw new Error('Project is not initialized. Use project_init first.')
    return `## Config - ${repositoryDisplay(repository)}\n\nnot_initialized. Use project_init for this exact repository.`
  }

  if (tracking !== undefined) {
    const nextTracking: RepoConfigData['tracking'] = tracking === ''
      ? { status: 'none' }
      : { status: 'configured', sources: tracking.map(source => parseRepositoryInput(source)) }
    const updated = store.update({ tracking: nextTracking }, config)
    if (!updated) {
      throw new Error('Repository config no longer exists or changed before the update could be applied.')
    }
    return `Updated **${repositoryDisplay(repository)}** tracking to ${updated.tracking.status}`
      + `\nTracking status: ${trackingStatus(updated)}\n${trackingStatusMarker(updated)}`
  }

  return renderRepoConfig(config)
}

export function renderRepoConfig(config: RepoConfigData): string {
  const rows = [
    ['schema_version', String(config.schema_version), 'Strict schema v3'],
    ['repository', repositoryDisplay(config.repository), 'Managed project identity'],
    ['lifecycle.status', config.lifecycle.status, 'Local project lifecycle'],
    ['lifecycle.archived_at', config.lifecycle.archived_at ?? '-', 'Only while archived'],
    ['parent.status', config.parent.status, 'Observed direct fork relationship'],
    ['parent.repository', config.parent.status === 'confirmed'
      ? `[${repositoryDisplay(config.parent.repository)}](${repositoryWebUrl(config.parent.repository)})` : '-', 'Not a storage redirect'],
    ['parent.relation_verified_at', config.parent.status !== 'unknown' ? config.parent.relation_verified_at : '-', 'Last verified relationship'],
    ['tracking.status', config.tracking.status, 'User decision, independent of parent'],
    ['tracking.sources', config.tracking.status === 'configured'
      ? config.tracking.sources.map(source => `[${repositoryDisplay(source)}](${repositoryWebUrl(source)})`).join(', ') : '-', 'Configured sources only'],
    ['mode', inferMode(config), 'Derived, not stored'],
  ]
  return [
    `## Config - ${repositoryDisplay(config.repository)}`,
    '',
    markdownTable(['Field', 'Value', 'Notes'], rows),
    '',
    trackingStatusMarker(config),
    `Tracking status: ${trackingStatus(config)}`,
    `Config path: ${join(projectDirectory(config.repository), 'config.yaml')}`,
  ].join('\n')
}
