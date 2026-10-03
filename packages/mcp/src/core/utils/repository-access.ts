import { ghApi, parseRepo } from '../clients/github.js'
import type { RepoConfigData, RepoRef } from '../storage/repo-config.js'
import { repositoryDisplay, sameRepository } from './repository-ref.js'

export type RepositoryPermission = 'read' | 'triage' | 'write' | 'maintain' | 'admin' | 'unknown'
export type RepositoryAccessState = 'reachable' | 'public' | 'forbidden' | 'not_found' | 'api_error'

export interface RepositoryAccessObservation {
  repository: RepoRef
  permission: RepositoryPermission
  state: RepositoryAccessState
  owner_type: 'user' | 'organization' | 'unknown'
  error?: string
}

interface RepositoryMetadata {
  private?: boolean
  visibility?: string
  owner?: { type?: string }
  permissions?: {
    admin?: boolean
    maintain?: boolean
    push?: boolean
    triage?: boolean
    pull?: boolean
  }
}

interface ForkMetadata {
  fork?: boolean
  parent?: { full_name?: string }
}

function permissionFrom(metadata: RepositoryMetadata): RepositoryPermission {
  const permissions = metadata.permissions
  if (!permissions) return 'unknown'
  if (permissions.admin) return 'admin'
  if (permissions.maintain) return 'maintain'
  if (permissions.push) return 'write'
  if (permissions.triage) return 'triage'
  if (permissions.pull) return 'read'
  return 'unknown'
}

function ownerTypeFrom(metadata: RepositoryMetadata): RepositoryAccessObservation['owner_type'] {
  if (metadata.owner?.type === 'Organization') return 'organization'
  if (metadata.owner?.type === 'User') return 'user'
  return 'unknown'
}

function errorState(error: unknown): RepositoryAccessState {
  const message = error instanceof Error ? error.message : String(error)
  if (/\b403\b|forbidden/i.test(message)) return 'forbidden'
  if (/\b404\b|not found/i.test(message)) return 'not_found'
  return 'api_error'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function canReadRepository(observation: RepositoryAccessObservation): boolean {
  return observation.state === 'public'
    || (observation.state === 'reachable'
      && ['read', 'triage', 'write', 'maintain', 'admin'].includes(observation.permission))
}

export function canWriteRepository(observation: RepositoryAccessObservation): boolean {
  return ['write', 'maintain', 'admin'].includes(observation.permission)
    && ['reachable', 'public'].includes(observation.state)
}

export function describeRepositoryAccess(observation: RepositoryAccessObservation): string {
  return `${repositoryDisplay(observation.repository)}: state=${observation.state}, permission=${observation.permission}`
    + (observation.error ? `, error=${observation.error}` : '')
}

/**
 * Observe one repository at call time. This is deliberately not persisted:
 * permissions and reachability are volatile facts, not configuration intent.
 */
export async function observeRepositoryAccess(repository: RepoRef): Promise<RepositoryAccessObservation> {
  const { owner, name } = parseRepo(repository)
  try {
    const metadata = await ghApi<RepositoryMetadata>(`/repos/${owner}/${name}`)
    const isPublic = metadata.private === false || metadata.visibility === 'public'
    return {
      repository,
      permission: permissionFrom(metadata),
      state: isPublic ? 'public' : 'reachable',
      owner_type: ownerTypeFrom(metadata),
    }
  }
  catch (error: unknown) {
    return {
      repository,
      permission: 'unknown',
      state: errorState(error),
      owner_type: 'unknown',
      error: errorMessage(error),
    }
  }
}

async function observeForkRelationship(repository: RepoRef, parent: RepoRef): Promise<void> {
  try {
    const { owner, name } = parseRepo(repository)
    const metadata = await ghApi<ForkMetadata>(`/repos/${owner}/${name}`)
    if (metadata.fork !== true || metadata.parent?.full_name?.toLowerCase() !== parent.path.toLowerCase()) {
      throw new Error(`configured parent ${parent.path} does not match GitHub parent ${metadata.parent?.full_name ?? 'unknown'}`)
    }
  }
  catch (error: unknown) {
    throw new Error(`Cannot verify fork relationship for ${repositoryDisplay(repository)}: ${errorMessage(error)}`)
  }
}

export async function assertForkSyncAccess(config: RepoConfigData): Promise<void> {
  if (config.parent.status !== 'confirmed') throw new Error('No verified parent configured for this project.')
  const { repository } = config
  const [destination, parentAccess] = await Promise.all([
    observeRepositoryAccess(repository),
    observeRepositoryAccess(config.parent.repository),
  ])
  if (!canWriteRepository(destination)) {
    throw new Error(`Fork sync requires write access to the destination. ${describeRepositoryAccess(destination)}`)
  }
  if (!canReadRepository(parentAccess)) {
    throw new Error(`Fork sync requires read access to the parent. ${describeRepositoryAccess(parentAccess)}`)
  }
  await observeForkRelationship(repository, config.parent.repository)
}

export async function assertPullRequestAccess(
  target: RepoRef,
  headRepository: RepoRef,
): Promise<void> {
  const targetObservation = await observeRepositoryAccess(target)
  if (sameRepository(headRepository, target)) {
    if (!canWriteRepository(targetObservation)) {
      throw new Error(`Creating a same-repository PR requires write access. ${describeRepositoryAccess(targetObservation)}`)
    }
    return
  }

  const headObservation = await observeRepositoryAccess(headRepository)
  if (!canReadRepository(targetObservation)) {
    throw new Error(`Creating a fork PR requires a readable target repository. ${describeRepositoryAccess(targetObservation)}`)
  }
  if (!canWriteRepository(headObservation)) {
    throw new Error(`Creating a fork PR requires write access to the head repository. ${describeRepositoryAccess(headObservation)}`)
  }
}
