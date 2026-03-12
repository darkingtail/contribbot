import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { safeWriteFileSync } from '../utils/fs.js'

export type { RepoRole } from '../enums.js'
import type { RepoRole } from '../enums.js'

export interface RepoConfigData {
  role: RepoRole
  org: string | null
  fork: string | null
  upstream: string | null
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

export class RepoConfig {
  private configPath: string

  constructor(private baseDir: string) {
    this.configPath = join(baseDir, 'config.yaml')
  }

  exists(): boolean {
    return existsSync(this.configPath)
  }

  load(): RepoConfigData | null {
    if (!this.exists()) return null
    const content = readFileSync(this.configPath, 'utf-8')
    return (parse(content) as RepoConfigData) ?? null
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
    this.save(config)
    return config
  }
}
