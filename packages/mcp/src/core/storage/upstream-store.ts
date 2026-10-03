import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument, stringify } from 'yaml'
import { z } from 'zod'
import { todayDate } from '../utils/format.js'
import { assertNoSymlinks, safeWriteFileSync } from '../utils/fs.js'
import { repositoryDigest, repositoryRefSchema, type RepositoryRef } from '../utils/repository-ref.js'
import { DAILY_COMMIT_ACTIONS, UPSTREAM_ITEM_STATUSES, TODO_DIFFICULTIES } from '../enums.js'
import type { UpstreamItemStatus, UpstreamVersionStatus, DailyCommitAction, TodoDifficulty } from '../enums.js'

export interface UpstreamItem {
  title: string
  type: 'feature' | 'bug' | 'chore'
  difficulty: TodoDifficulty | null
  status: UpstreamItemStatus
  pr: number | null
}

export interface UpstreamVersion {
  version: string
  status: UpstreamVersionStatus
  items: UpstreamItem[]
}

export interface DailyCommit {
  sha: string
  message: string
  type: string
  date: string
  action: DailyCommitAction | null
  ref: string | null
}

interface DailyData {
  last_checked: string | null
  commits: DailyCommit[]
}

interface RepoData {
  repository: RepositoryRef
  versions: UpstreamVersion[]
  daily: DailyData
}

type UpstreamFile = Record<string, RepoData>
type ArchiveFile = Record<string, { repository: RepositoryRef; commits: DailyCommit[] }>

const commitSchema = z.object({
  sha: z.string(), message: z.string(), type: z.string(), date: z.string(),
  action: z.enum(DAILY_COMMIT_ACTIONS).nullable(), ref: z.string().nullable(),
}).strict()
const sourceSchema = z.object({
  repository: repositoryRefSchema,
  versions: z.array(z.object({
    version: z.string(), status: z.enum(['active', 'done']),
    items: z.array(z.object({
      title: z.string(), type: z.enum(['feature', 'bug', 'chore']),
      difficulty: z.enum(TODO_DIFFICULTIES).nullable(),
      status: z.enum(UPSTREAM_ITEM_STATUSES), pr: z.number().int().nullable(),
    }).strict()),
  }).strict()),
  daily: z.object({ last_checked: z.string().nullable(), commits: z.array(commitSchema) }).strict(),
}).strict()
const archiveSourceSchema = z.object({
  repository: repositoryRefSchema, commits: z.array(commitSchema),
}).strict()

function sourceKey(repository: RepositoryRef): string {
  return repositoryDigest(repositoryRefSchema.parse(repository))
}

function sameCommit(left: DailyCommit, right: DailyCommit): boolean {
  return left.sha === right.sha
    && left.message === right.message
    && left.type === right.type
    && left.date === right.date
    && left.action === right.action
    && left.ref === right.ref
}

function readSources<T extends { repository: RepositoryRef }>(path: string, schema: z.ZodType<T>): Record<string, T> {
  assertNoSymlinks(path)
  if (!existsSync(path)) return {}
  const document = parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true })
  const problem = document.errors[0] ?? document.warnings[0]
  if (problem) throw new Error(`Invalid upstream schema in ${path}: ${problem.message}`)
  const envelope = z.object({
    schema_version: z.literal(1),
    sources: z.record(z.string().regex(/^[a-f0-9]{64}$/), schema),
  }).strict().safeParse(document.toJS({ maxAliasCount: 0 }))
  if (!envelope.success) {
    throw new Error(`Invalid upstream identity format in ${path}; no data was converted: ${envelope.error.message}`)
  }
  for (const [key, source] of Object.entries(envelope.data.sources)) {
    if (sourceKey(source.repository) !== key) {
      throw new Error(`Upstream repository identity does not match its key in ${path}: ${key}`)
    }
  }
  return envelope.data.sources
}

export class UpstreamStore {
  private baseDir: string
  private yamlPath: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.yamlPath = join(baseDir, 'upstream.yaml')
  }

  listRepos(): RepositoryRef[] {
    const data = this.load()
    return Object.values(data).map(source => source.repository)
  }

  // --- Versions ---

  listVersions(repo: RepositoryRef): UpstreamVersion[] {
    const key = sourceKey(repo)
    const data = this.load()
    return data[key]?.versions ?? []
  }

  /**
   * Get the latest tracked version tag for a given upstream repo.
   * Returns null if no versions are tracked.
   */
  getLatestVersionTag(repo: RepositoryRef): string | null {
    const versions = this.listVersions(repo)
    if (versions.length === 0) return null
    // Return the last version in the array (most recently added)
    const last = versions[versions.length - 1]
    return last ? last.version : null
  }

  addVersion(
    repo: RepositoryRef,
    version: string,
    items: { title: string; type: 'feature' | 'bug' | 'chore' }[],
  ): void {
    const data = this.load()
    const repoData = this.ensureRepo(data, repo)

    const fullItems: UpstreamItem[] = items.map(item => ({
      title: item.title,
      type: item.type,
      difficulty: null,
      status: 'active',
      pr: null,
    }))

    repoData.versions.push({
      version,
      status: 'active',
      items: fullItems,
    })

    this.save(data)
  }

  updateVersionItem(
    repo: RepositoryRef,
    version: string,
    itemIndex: number,
    fields: Partial<Pick<UpstreamItem, 'status' | 'pr' | 'difficulty'>>,
  ): void {
    const key = sourceKey(repo)
    const data = this.load()
    const repoData = data[key]
    if (!repoData) return

    const ver = repoData.versions.find(v => v.version === version)
    if (!ver) return
    const item = ver.items[itemIndex]
    if (itemIndex < 0 || itemIndex >= ver.items.length || !item) return

    if (fields.status !== undefined) item.status = fields.status
    if (fields.pr !== undefined) item.pr = fields.pr
    if (fields.difficulty !== undefined) item.difficulty = fields.difficulty

    // Auto-mark version done when all items done
    if (ver.items.every(item => item.status === 'done')) {
      ver.status = 'done'
    }

    this.save(data)
  }

  // --- Daily ---

  getDaily(repo: RepositoryRef): DailyData {
    const key = sourceKey(repo)
    const data = this.load()
    return data[key]?.daily ?? { last_checked: null, commits: [] }
  }

  addDailyCommits(
    repo: RepositoryRef,
    commits: { sha: string; message: string; type: string; date: string }[],
  ): void {
    const data = this.load()
    const repoData = this.ensureRepo(data, repo)

    const existingShas = new Set(repoData.daily.commits.map(c => c.sha))

    for (const commit of commits) {
      if (existingShas.has(commit.sha)) continue
      repoData.daily.commits.push({
        sha: commit.sha,
        message: commit.message,
        type: commit.type,
        date: commit.date,
        action: null,
        ref: null,
      })
      existingShas.add(commit.sha)
    }

    repoData.daily.last_checked = todayDate()

    this.save(data)
  }

  updateDailyCommit(
    repo: RepositoryRef,
    sha: string,
    fields: Partial<Pick<DailyCommit, 'action' | 'ref'>>,
  ): void {
    const key = sourceKey(repo)
    const data = this.load()
    const repoData = data[key]
    if (!repoData) return

    const commit = repoData.daily.commits.find(c => c.sha === sha)
    if (!commit) return

    if (fields.action !== undefined) commit.action = fields.action
    if (fields.ref !== undefined) commit.ref = fields.ref

    this.save(data)
  }

  /**
   * Batch update multiple daily commits in a single file write.
   */
  updateDailyCommitBatch(
    repo: RepositoryRef,
    updates: Array<{ sha: string; fields: Partial<Pick<DailyCommit, 'action' | 'ref'>> }>,
  ): number {
    const key = sourceKey(repo)
    const data = this.load()
    const repoData = data[key]
    if (!repoData) return 0

    let count = 0
    for (const { sha, fields } of updates) {
      const commit = repoData.daily.commits.find(c => c.sha === sha)
      if (commit) {
        if (fields.action !== undefined) commit.action = fields.action
        if (fields.ref !== undefined) commit.ref = fields.ref
        count++
      }
    }

    if (count > 0) this.save(data)
    return count
  }

  /**
   * Mark all pending daily commits on or before a given date as 'synced'.
   * Used when a version sync covers those commits.
   */
  markDailyAsSynced(repo: RepositoryRef, beforeDate: string): number {
    const key = sourceKey(repo)
    const data = this.load()
    const repoData = data[key]
    if (!repoData) return 0

    let count = 0
    for (const commit of repoData.daily.commits) {
      if (commit.action === null && commit.date <= beforeDate) {
        commit.action = 'synced'
        count++
      }
    }

    if (count > 0) this.save(data)
    return count
  }

  // --- Compact ---

  /**
   * Compact daily commits for a repo: move old processed entries to upstream.archive.yaml.
   * Only moves commits that have been acted on (action !== null).
   */
  compactDaily(repo: RepositoryRef, options: { before?: string; keep?: number }): { removed: number; remaining: number } {
    const key = sourceKey(repo)
    const data = this.load()
    const repoData = data[key]
    if (!repoData) return { removed: 0, remaining: 0 }

    const commits = repoData.daily.commits
    const processed = commits.filter(c => c.action !== null)
    const pending = commits.filter(c => c.action === null)

    let keptProcessed: DailyCommit[]

    if (options.before) {
      keptProcessed = processed.filter(c => c.date >= options.before!)
    } else if (options.keep !== undefined) {
      keptProcessed = options.keep === 0 ? [] : processed.slice(-options.keep)
    } else {
      throw new Error('Exactly one of "before" or "keep" must be provided.')
    }

    // Move removed commits to archive
    const removedCommits = processed.filter(c => !keptProcessed.includes(c))
    if (removedCommits.length > 0) {
      this.appendToArchive(repo, removedCommits)
    }

    const removed = removedCommits.length
    repoData.daily.commits = [...pending, ...keptProcessed].sort((a, b) => a.date.localeCompare(b.date))
    this.save(data)
    return { removed, remaining: repoData.daily.commits.length }
  }

  getDailyStats(repo: RepositoryRef): { total: number; pending: number; processed: number; oldest: string | null } {
    const daily = this.getDaily(repo)
    const pending = daily.commits.filter(c => c.action === null).length
    const processed = daily.commits.length - pending
    const oldest = daily.commits.length > 0 ? daily.commits[0]!.date : null
    return { total: daily.commits.length, pending, processed, oldest }
  }

  // --- Archive ---

  private get archivePath(): string {
    return join(this.baseDir, 'upstream.archive.yaml')
  }

  private appendToArchive(repo: RepositoryRef, commits: DailyCommit[]): void {
    const key = sourceKey(repo)
    const archive: ArchiveFile = readSources(this.archivePath, archiveSourceSchema)
    if (!archive[key]) archive[key] = { repository: repositoryRefSchema.parse(repo), commits: [] }
    const existing = new Map<string, DailyCommit>()
    for (const commit of archive[key].commits) {
      const previous = existing.get(commit.sha)
      if (previous && !sameCommit(previous, commit)) {
        throw new Error(`Conflicting archived commit ${commit.sha} for ${JSON.stringify(repo)}.`)
      }
      existing.set(commit.sha, commit)
    }

    let changed = false
    for (const commit of commits) {
      const previous = existing.get(commit.sha)
      if (previous) {
        if (!sameCommit(previous, commit)) {
          throw new Error(`Conflicting archived commit ${commit.sha} for ${JSON.stringify(repo)}.`)
        }
        continue
      }
      archive[key].commits.push(commit)
      existing.set(commit.sha, commit)
      changed = true
    }
    if (changed) this.writeSources(this.archivePath, archive)
  }

  listArchived(repo: RepositoryRef): DailyCommit[] {
    const key = sourceKey(repo)
    return readSources(this.archivePath, archiveSourceSchema)[key]?.commits ?? []
  }

  getArchiveStats(repo: RepositoryRef): { total: number; oldest: string | null } {
    const archived = this.listArchived(repo)
    return {
      total: archived.length,
      oldest: archived.length > 0 ? archived[0]!.date : null,
    }
  }

  // --- Private ---

  private load(): UpstreamFile {
    return readSources(this.yamlPath, sourceSchema)
  }

  private save(data: UpstreamFile): void {
    this.writeSources(this.yamlPath, data)
  }

  private writeSources(path: string, sources: UpstreamFile | ArchiveFile): void {
    assertNoSymlinks(path)
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    safeWriteFileSync(path, stringify({ schema_version: 1, sources }))
  }

  private ensureRepo(data: UpstreamFile, repo: RepositoryRef): RepoData {
    const key = sourceKey(repo)
    if (!data[key]) {
      data[key] = {
        repository: repositoryRefSchema.parse(repo),
        versions: [],
        daily: { last_checked: null, commits: [] },
      }
    }
    return data[key]
  }
}
