import { closeSync, existsSync, mkdirSync, openSync, readdirSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { stringify } from 'yaml'
import { assertDirectoryIdentity, loadRepoConfig, parseConfig, repoConfigSchema, type RepoConfigData } from 'contribbot-core/repository/config'
import { assertNoSymlinks, safeWriteFileSync } from '../utils/fs.js'
import { repositoryIdentityKey } from '../utils/repository-ref.js'

export * from 'contribbot-core/repository/config'

export class RepoConfig {
  private baseDir: string
  private configPath: string

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir)
    this.configPath = join(this.baseDir, 'config.yaml')
  }

  private assertSafePath(): void {
    assertNoSymlinks(this.configPath)
  }

  private withLock<T>(operation: () => T): T {
    this.assertSafePath()
    mkdirSync(this.baseDir, { recursive: true })
    this.assertSafePath()
    const lock = join(this.baseDir, '.config.lock')
    const fd = openSync(lock, 'wx')
    try { return operation() }
    finally {
      closeSync(fd)
      unlinkSync(lock)
    }
  }

  exists(): boolean {
    this.assertSafePath()
    return existsSync(this.configPath)
  }

  load(): RepoConfigData | null {
    return loadRepoConfig(this.baseDir)
  }

  save(config: RepoConfigData): void {
    const validated = parseConfig(config, this.configPath)
    assertDirectoryIdentity(this.baseDir, validated)
    this.withLock(() => {
      if (this.exists()) throw new Error(`Repository config already exists: ${this.configPath}`)
      if (readdirSync(this.baseDir).some(entry => entry !== '.config.lock')) {
        throw new Error(`Project directory ${this.baseDir} contains data without a valid config; initialization stopped.`)
      }
      safeWriteFileSync(this.configPath, stringify(validated))
    })
  }

  update(fields: Partial<RepoConfigData>, expected?: RepoConfigData): RepoConfigData | null {
    return this.withLock(() => {
      const config = this.load()
      if (!config) return null
      if (expected && !isDeepStrictEqual(repoConfigSchema.parse(expected), config)) {
        throw new Error('Repository config changed since it was read.')
      }
      const next = parseConfig({ ...config, ...fields }, this.configPath)
      if (repositoryIdentityKey(next.repository) !== repositoryIdentityKey(config.repository)) {
        throw new Error('Changing repository identity requires an explicit migration.')
      }
      assertDirectoryIdentity(this.baseDir, next)
      safeWriteFileSync(this.configPath, stringify(next))
      return next
    })
  }
}
