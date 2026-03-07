import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { todayDate } from '../utils/format.js'
import { safeWriteFileSync } from '../utils/fs.js'
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
  versions: UpstreamVersion[]
  daily: DailyData
}

type UpstreamFile = Record<string, RepoData>

export class UpstreamStore {
  private yamlPath: string

  constructor(private baseDir: string) {
    this.yamlPath = join(baseDir, 'upstream.yaml')
  }

  listRepos(): string[] {
    const data = this.load()
    return Object.keys(data)
  }

  // --- Versions ---

  listVersions(repo: string): UpstreamVersion[] {
    const data = this.load()
    return data[repo]?.versions ?? []
  }

  addVersion(
    repo: string,
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
    repo: string,
    version: string,
    itemIndex: number,
    fields: Partial<Pick<UpstreamItem, 'status' | 'pr' | 'difficulty'>>,
  ): void {
    const data = this.load()
    const repoData = data[repo]
    if (!repoData) return

    const ver = repoData.versions.find(v => v.version === version)
    if (!ver) return
    const item = ver.items[itemIndex]
    if (itemIndex < 0 || itemIndex >= ver.items.length || !item) return

    Object.assign(item, fields)

    // Auto-mark version done when all items done
    if (ver.items.every(item => item.status === 'done')) {
      ver.status = 'done'
    }

    this.save(data)
  }

  // --- Daily ---

  getDaily(repo: string): DailyData {
    const data = this.load()
    return data[repo]?.daily ?? { last_checked: null, commits: [] }
  }

  addDailyCommits(
    repo: string,
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
    repo: string,
    sha: string,
    fields: Partial<Pick<DailyCommit, 'action' | 'ref'>>,
  ): void {
    const data = this.load()
    const repoData = data[repo]
    if (!repoData) return

    const commit = repoData.daily.commits.find(c => c.sha === sha)
    if (!commit) return

    Object.assign(commit, fields)

    this.save(data)
  }

  /**
   * Batch update multiple daily commits in a single file write.
   */
  updateDailyCommitBatch(
    repo: string,
    updates: Array<{ sha: string; fields: Partial<Pick<DailyCommit, 'action' | 'ref'>> }>,
  ): number {
    const data = this.load()
    const repoData = data[repo]
    if (!repoData) return 0

    let count = 0
    for (const { sha, fields } of updates) {
      const commit = repoData.daily.commits.find(c => c.sha === sha)
      if (commit) {
        Object.assign(commit, fields)
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
  markDailyAsSynced(repo: string, beforeDate: string): number {
    const data = this.load()
    const repoData = data[repo]
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

  // --- Private ---

  private load(): UpstreamFile {
    if (!existsSync(this.yamlPath)) return {}
    const content = readFileSync(this.yamlPath, 'utf-8')
    const data = parse(content) as UpstreamFile | null
    return data ?? {}
  }

  private save(data: UpstreamFile): void {
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    safeWriteFileSync(this.yamlPath, stringify(data))
  }

  private ensureRepo(data: UpstreamFile, repo: string): RepoData {
    if (!data[repo]) {
      data[repo] = {
        versions: [],
        daily: { last_checked: null, commits: [] },
      }
    }
    return data[repo]
  }
}
