import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { safeWriteFileSync } from '../utils/fs.js'

export type { RepoRole } from '../enums.js'
import type { RepoRole, ProjectStatus } from '../enums.js'

export interface RepoConfigData {
  role: RepoRole
  org: string | null
  fork: string | null
  /** Only an explicit user decision sets this marker; legacy null stays pending. */
  upstream_confirmed?: boolean
  upstream: string | null
  /** Missing in legacy configs means active. Independent of upstream/fork mode. */
  status?: ProjectStatus
  archived_at?: string | null
}

/**
 * ProjectMode — 项目的上下游对齐关系，和 role（权限）正交。
 * 由 config.yaml 的 fork + upstream 字段自动推断。
 */
export type ProjectMode = 'none' | 'fork' | 'upstream' | 'fork+upstream'

export function inferMode(config: RepoConfigData): ProjectMode {
  const hasFork = config.fork !== null
  const hasUpstream = config.upstream !== null
  if (hasFork && hasUpstream) return 'fork+upstream'
  if (hasFork) return 'fork'
  if (hasUpstream) return 'upstream'
  return 'none'
}

export type UpstreamStatus = 'pending' | 'configured' | 'none'

export function upstreamStatus(config: RepoConfigData): UpstreamStatus {
  if (config.upstream) return 'configured'
  return config.upstream_confirmed === true ? 'none' : 'pending'
}

/** Stable machine-readable marker shared by MCP text output and the CLI. */
export function upstreamStatusMarker(config: RepoConfigData): string {
  return '<!-- contribbot:upstream-status=' + upstreamStatus(config) + ' -->'
}

export class RepoConfig {
  private baseDir: string
  private configPath: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.configPath = join(baseDir, 'config.yaml')
  }

  exists(): boolean {
    return existsSync(this.configPath)
  }

  load(): RepoConfigData | null {
    if (!this.exists()) return null
    const content = readFileSync(this.configPath, 'utf-8')
    const config = (parse(content) as RepoConfigData) ?? null
    if (config && config.status !== undefined && config.status !== 'active' && config.status !== 'archived') {
      throw new Error(`Invalid project status in ${this.configPath}`)
    }
    return config
  }

  save(config: RepoConfigData): void {
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    safeWriteFileSync(this.configPath, stringify(config))
  }

  update(fields: Partial<RepoConfigData>): RepoConfigData | null {
    const config = this.load()
    if (!config) return null
    if (fields.role !== undefined) config.role = fields.role
    if (fields.org !== undefined) config.org = fields.org
    if (fields.fork !== undefined) config.fork = fields.fork
    if (fields.upstream !== undefined) config.upstream = fields.upstream
    if (fields.upstream_confirmed !== undefined) config.upstream_confirmed = fields.upstream_confirmed
    if (fields.status !== undefined) config.status = fields.status
    if (fields.archived_at !== undefined) config.archived_at = fields.archived_at
    this.save(config)
    return config
  }
}
