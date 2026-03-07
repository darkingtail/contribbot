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
    Object.assign(config, fields)
    this.save(config)
    return config
  }
}
