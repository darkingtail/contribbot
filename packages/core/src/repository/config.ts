import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import { z } from 'zod'
import { assertNoSymlinks } from '../storage/paths.js'
import {
  normalizeRepositoryRef,
  repositoryDigest,
  repositoryIdentityKey,
  repositoryRefSchema,
  sameRepository,
  type RepositoryRef,
} from './ref.js'

export const CONFIG_SCHEMA_VERSION = 3 as const

const isoTimestamp = z.string().refine(value => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!parts) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = parts
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
    && Number(hourText) < 24 && Number(minuteText) < 60 && Number(secondText) < 60
    && (offsetHourText === undefined || (Number(offsetHourText) < 24 && Number(offsetMinuteText) < 60))
}, 'must be an RFC 3339 timestamp with a real calendar date')

const lifecycleSchema = z.object({
  status: z.enum(['active', 'archived']),
  archived_at: isoTimestamp.optional(),
}).strict().superRefine((value, context) => {
  if (value.status === 'active' && value.archived_at !== undefined) {
    context.addIssue({ code: 'custom', path: ['archived_at'], message: 'active lifecycle cannot include archived_at' })
  }
  if (value.status === 'archived' && value.archived_at === undefined) {
    context.addIssue({ code: 'custom', path: ['archived_at'], message: 'archived lifecycle requires archived_at' })
  }
})

const parentSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unknown') }).strict(),
  z.object({ status: z.literal('none'), relation_verified_at: isoTimestamp }).strict(),
  z.object({
    status: z.literal('confirmed'),
    repository: repositoryRefSchema,
    relation_verified_at: isoTimestamp,
  }).strict(),
])

const trackingSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }).strict(),
  z.object({ status: z.literal('none') }).strict(),
  z.object({ status: z.literal('configured'), sources: z.array(repositoryRefSchema).min(1) }).strict(),
])

export const repoConfigSchema = z.object({
  schema_version: z.literal(CONFIG_SCHEMA_VERSION),
  repository: repositoryRefSchema,
  lifecycle: lifecycleSchema,
  parent: parentSchema,
  tracking: trackingSchema,
}).strict().superRefine((value, context) => {
  const self = repositoryIdentityKey(value.repository)
  if (value.parent.status === 'confirmed' && sameRepository(value.parent.repository, value.repository)) {
    context.addIssue({ code: 'custom', path: ['parent', 'repository'], message: 'parent cannot equal repository' })
  }
  if (value.tracking.status === 'configured') {
    const seen = new Set<string>()
    for (const [index, source] of value.tracking.sources.entries()) {
      const key = repositoryIdentityKey(source)
      if (key === self) {
        context.addIssue({ code: 'custom', path: ['tracking', 'sources', index], message: 'tracking source cannot equal repository' })
      }
      if (seen.has(key)) {
        context.addIssue({ code: 'custom', path: ['tracking', 'sources', index], message: 'duplicate tracking source' })
      }
      seen.add(key)
    }
  }
})

export type RepoRef = RepositoryRef
export type LifecycleConfig = z.infer<typeof lifecycleSchema>
export type ParentConfig = z.infer<typeof parentSchema>
export type TrackingConfig = z.infer<typeof trackingSchema>
export type RepoConfigData = z.infer<typeof repoConfigSchema>

/**
 * ProjectMode is derived from the configured repository relationships.
 * A pending or explicitly disabled tracking source is not an active mode.
 */
export type ProjectMode = 'none' | 'fork' | 'tracking' | 'fork+tracking'

export function inferMode(config: RepoConfigData): ProjectMode {
  const hasFork = config.parent.status === 'confirmed'
  const hasTracking = config.tracking.status === 'configured'
  if (hasFork && hasTracking) return 'fork+tracking'
  if (hasFork) return 'fork'
  if (hasTracking) return 'tracking'
  return 'none'
}

export type TrackingStatus = TrackingConfig['status']

export function trackingStatus(config: RepoConfigData): TrackingStatus {
  return config.tracking.status
}

/** Stable machine-readable marker shared by MCP text output and the CLI. */
export function trackingStatusMarker(config: RepoConfigData): string {
  return '<!-- contribbot:tracking-status=' + trackingStatus(config) + ' -->'
}

export function parseConfig(value: unknown, configPath: string): RepoConfigData {
  const result = repoConfigSchema.safeParse(value)
  if (result.success) return result.data
  const details = result.error.issues
    .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
  throw new Error(`Invalid schema v3 repository config in ${configPath}: ${details}`)
}

function parseConfigYaml(content: string, configPath: string): unknown {
  const document = parseDocument(content, { uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error(`Invalid schema v3 repository config in ${configPath}: ${document.errors[0]!.message}`)
  }
  if (document.warnings.length > 0) {
    throw new Error(`Invalid schema v3 repository config in ${configPath}: ${document.warnings[0]!.message}`)
  }

  function inspect(node: typeof document.contents, path: string): void {
    if (!node) return
    if (node.tag && node.tag.startsWith('!')) {
      throw new Error(`Invalid schema v3 repository config in ${configPath}: custom tag at ${path}`)
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        if (pair.key && 'value' in pair.key && pair.key.value === '<<') {
          throw new Error(`Invalid schema v3 repository config in ${configPath}: YAML merge key at ${path}`)
        }
        const key = pair.key && 'value' in pair.key ? String(pair.key.value) : '<key>'
        inspect(pair.key, `${path}.${key}`)
        inspect(pair.value, `${path}.${key}`)
      }
    }
    else if (isSeq(node)) {
      node.items.forEach((item, index) => inspect(item, `${path}[${index}]`))
    }
  }
  inspect(document.contents, '<root>')
  return document.toJS()
}

export function assertDirectoryIdentity(baseDir: string, config: RepoConfigData): void {
  if (basename(dirname(baseDir)) !== 'v1' || basename(dirname(dirname(baseDir))) !== 'projects') return
  if (basename(baseDir) !== repositoryDigest(config.repository)) {
    throw new Error(`Repository identity does not match project directory: ${join(baseDir, 'config.yaml')}`)
  }
}

/** Strict, read-only loading shared by host entry points. Missing config creates nothing. */
export function loadRepoConfig(directory: string): RepoConfigData | null {
  const baseDir = resolve(directory)
  const configPath = join(baseDir, 'config.yaml')
  assertNoSymlinks(configPath)
  if (!existsSync(configPath)) return null
  const content = readFileSync(configPath, 'utf-8')
  const config = parseConfig(parseConfigYaml(content, configPath), configPath)
  assertDirectoryIdentity(baseDir, config)
  for (const [path, repository] of [
    ['repository', config.repository],
    ...(config.parent.status === 'confirmed' ? [['parent.repository', config.parent.repository] as const] : []),
    ...(config.tracking.status === 'configured'
      ? config.tracking.sources.map((source, index) => [`tracking.sources[${index}]`, source] as const)
      : []),
  ] as const) {
    const normalized = normalizeRepositoryRef(repository)
    if (repositoryIdentityKey(normalized) !== repositoryIdentityKey(repository)
      || normalized.instance !== repository.instance
      || normalized.path !== repository.path
      || normalized.platform !== repository.platform) {
      throw new Error(`Invalid schema v3 repository config in ${configPath}: ${path} is not canonical`)
    }
  }
  return config
}
