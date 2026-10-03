import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export const REPOSITORY_PLATFORMS = ['github', 'gitlab'] as const
export type RepositoryPlatform = typeof REPOSITORY_PLATFORMS[number]

const segment = /^[A-Za-z0-9_.-]+$/
const host = /^[A-Za-z0-9.-]+$/
const controlCharacter = /[\u0000-\u001f\u007f]/

export interface RepositoryRef {
  platform: RepositoryPlatform
  instance: string
  path: string
}

export type RepositoryInput = RepositoryRef

export const repositoryRefSchema = z.object({
  platform: z.enum(REPOSITORY_PLATFORMS),
  instance: z.string().min(1),
  path: z.string().min(1),
}).strict().superRefine((value, context) => {
  try {
    const normalized = normalizeRepositoryRef(value)
    if (normalized.instance !== value.instance) {
      context.addIssue({ code: 'custom', path: ['instance'], message: 'must be a normalized instance URL' })
    }
    if (normalized.path !== value.path) {
      context.addIssue({ code: 'custom', path: ['path'], message: 'must be a canonical repository path' })
    }
  }
  catch (error) {
    context.addIssue({
      code: 'custom',
      path: [],
      message: error instanceof Error ? error.message : String(error),
    })
  }
})

function rejectUnsafeUrl(url: URL, raw: string): void {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Repository instance must use http or https: ${raw}`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Repository instance cannot contain credentials, query, or fragment.')
  }
  if (!url.hostname || !host.test(url.hostname)) {
    throw new Error(`Invalid repository instance host: ${raw}`)
  }
  if (url.pathname.includes('//') || /(^|\/)(?:\.|\.\.)(?:\/|$)/.test(url.pathname)) {
    throw new Error(`Repository instance contains an unsafe path: ${raw}`)
  }
  if (url.pathname.includes('%') || /[\u0000-\u001f\u007f\\]/.test(url.pathname)) {
    throw new Error(`Repository instance contains an unsafe character: ${raw}`)
  }
}

function rejectUnsafeRawInstancePath(raw: string): void {
  if (controlCharacter.test(raw)) {
    throw new Error('Repository instance contains a control character.')
  }
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/i.exec(raw)
  const path = match?.[1] ?? ''
  if (path.includes('//') || /(^|\/)(?:\.|\.\.)(?:\/|$)/.test(path)
    || path.includes('%') || /[\u0000-\u001f\u007f\\]/.test(path)) {
    throw new Error(`Repository instance contains an unsafe path: ${raw}`)
  }
  if (raw.includes('?') || raw.includes('#') || match?.[0].split('/')[2]?.includes('@')) {
    throw new Error('Repository instance cannot contain credentials, query, or fragment.')
  }
}

export function normalizeInstance(value: string): string {
  if (controlCharacter.test(value)) {
    throw new Error('Repository instance contains a control character.')
  }
  const raw = value.trim()
  if (!raw) throw new Error('Repository instance is required.')
  rejectUnsafeRawInstancePath(raw)
  const url = new URL(raw)
  rejectUnsafeUrl(url, raw)
  if (isIP(url.hostname) === 4) {
    const authority = /^https?:\/\/([^/?#]+)/i.exec(raw)?.[1] ?? ''
    const rawHostname = authority.replace(/:\d+$/, '').toLowerCase()
    if (rawHostname !== url.hostname) {
      throw new Error(`Non-canonical IPv4 repository instance host: ${raw}`)
    }
  }

  const publicInstance = url.hostname === 'github.com'
    ? 'https://github.com'
    : url.hostname === 'gitlab.com'
      ? 'https://gitlab.com'
      : undefined
  if (publicInstance && (url.origin !== publicInstance || url.pathname !== '/')) {
    throw new Error(`Public repository instance must be its service root: ${publicInstance}`)
  }

  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  const port = url.port
    && !((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80'))
    ? `:${url.port}`
    : ''
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}${pathname}`
}

export function normalizeRepositoryPath(platform: RepositoryPlatform, value: string): string {
  if (controlCharacter.test(value)) {
    throw new Error('Repository path contains a control character.')
  }
  const path = value.trim()
  if (!path || path.startsWith('/') || path.endsWith('/') || path.includes('//')) {
    throw new Error('Repository path must be a non-empty relative path.')
  }
  if (path.includes('\\') || path.includes('%') || path.includes('?') || path.includes('#')
    || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error('Repository path contains an unsafe character.')
  }
  const parts = path.split('/')
  const minimumParts = platform === 'github' ? 2 : 2
  if (parts.length < minimumParts || (platform === 'github' && parts.length !== 2)
    || parts.some(part => !part || part === '.' || part === '..' || !segment.test(part))) {
    throw new Error(`Invalid ${platform} repository path: ${value}`)
  }
  if (parts.at(-1)?.endsWith('.git')) {
    throw new Error('Repository path must not include a .git suffix.')
  }
  return parts.join('/')
}

export function normalizeRepositoryRef(value: RepositoryRef): RepositoryRef {
  if (!REPOSITORY_PLATFORMS.includes(value.platform)) {
    throw new Error(`Unsupported repository platform: ${String(value.platform)}`)
  }
  const instance = normalizeInstance(value.instance)
  if ((instance === 'https://github.com' && value.platform !== 'github')
    || (instance === 'https://gitlab.com' && value.platform !== 'gitlab')) {
    throw new Error(`Repository platform ${value.platform} does not match public instance ${instance}.`)
  }
  return {
    platform: value.platform,
    instance,
    path: normalizeRepositoryPath(value.platform, value.path),
  }
}

export function parseRepositoryInput(value: unknown): RepositoryRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Repository must be an object with exactly platform, instance, and path.')
  }
  return repositoryRefSchema.parse(value)
}

export function repositoryIdentityKey(repository: RepositoryRef): string {
  const normalized = normalizeRepositoryRef(repository)
  return JSON.stringify(['repository-key-v1', normalized.platform, normalized.instance, normalized.path])
}

export function repositoryDigest(repository: RepositoryRef): string {
  return createHash('sha256').update(repositoryIdentityKey(repository), 'utf8').digest('hex')
}

export function repositoryDisplay(repository: RepositoryRef): string {
  const normalized = normalizeRepositoryRef(repository)
  return `${normalized.platform}://${normalized.instance.replace(/^https?:\/\//, '')}/${normalized.path}`
}

export function repositoryWebUrl(repository: RepositoryRef): string {
  const normalized = normalizeRepositoryRef(repository)
  return `${normalized.instance}/${normalized.path}`
}

export function projectDataRoot(root?: string): string {
  return root ?? join(homedir(), '.contribbot')
}

export function projectDirectory(repository: RepositoryRef, root?: string): string {
  return join(projectDataRoot(root), 'projects', 'v1', repositoryDigest(repository))
}

export function sameRepository(left: RepositoryRef, right: RepositoryRef): boolean {
  return repositoryIdentityKey(left) === repositoryIdentityKey(right)
}
