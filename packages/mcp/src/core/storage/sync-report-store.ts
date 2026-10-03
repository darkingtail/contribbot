import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument, stringify } from 'yaml'
import { z } from 'zod'
import { assertNoSymlinks, safeWriteFileSync } from '../utils/fs.js'
import { repositoryDigest, repositoryRefSchema, type RepositoryRef } from '../utils/repository-ref.js'

const digestPattern = /^[a-f0-9]{64}$/
const reportHeaderSchema = z.object({
  schema_version: z.literal(1),
  source: repositoryRefSchema,
  version: z.string().min(1),
  target_branch: z.string().nullable(),
}).strict()

export interface SyncReport {
  source: RepositoryRef
  version: string
  targetBranch: string | null
  content: string
  path: string
}

function reportKey(version: string, targetBranch: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify(['release-sync-v1', version, targetBranch]), 'utf8')
    .digest('hex')
}

function readReport(path: string, sourceKey: string, key: string): SyncReport {
  assertNoSymlinks(path)
  const raw = readFileSync(path, 'utf8')
  const end = raw.startsWith('---\n') ? raw.indexOf('\n---\n', 4) : -1
  if (end === -1) throw new Error(`Invalid sync report frontmatter in ${path}.`)
  const document = parseDocument(raw.slice(4, end), { uniqueKeys: true })
  const problem = document.errors[0] ?? document.warnings[0]
  if (problem) throw new Error(`Invalid sync report in ${path}: ${problem.message}`)
  const header = reportHeaderSchema.safeParse(document.toJS({ maxAliasCount: 0 }))
  if (!header.success) throw new Error(`Invalid sync report in ${path}: ${header.error.message}`)
  const { source, version, target_branch: targetBranch } = header.data
  if (repositoryDigest(source) !== sourceKey || reportKey(version, targetBranch) !== key) {
    throw new Error(`Sync report identity or key mismatch in ${path}.`)
  }
  return { source, version, targetBranch, content: raw.slice(end + '\n---\n'.length), path }
}

export class SyncReportStore {
  private readonly root: string
  private readonly releases: string

  constructor(baseDir: string) {
    this.root = join(baseDir, 'sync')
    this.releases = join(this.root, 'releases', 'v1')
  }

  save(sourceInput: RepositoryRef, version: string, targetBranch: string | null, content: string): string {
    const source = repositoryRefSchema.parse(sourceInput)
    if (!version) throw new Error('Release version is required.')
    const sourceKey = repositoryDigest(source)
    const key = reportKey(version, targetBranch)
    const path = join(this.releases, sourceKey, `${key}.md`)
    assertNoSymlinks(path)
    if (existsSync(path)) readReport(path, sourceKey, key)
    mkdirSync(join(this.releases, sourceKey), { recursive: true })
    assertNoSymlinks(path)
    const header = stringify({ schema_version: 1, source, version, target_branch: targetBranch }).trimEnd()
    safeWriteFileSync(path, `---\n${header}\n---\n${content}`)
    return path
  }

  list(): { reports: SyncReport[]; legacyCount: number } {
    assertNoSymlinks(this.root)
    if (!existsSync(this.root)) return { reports: [], legacyCount: 0 }
    const legacyCount = readdirSync(this.root).filter(name => name.endsWith('.md')).length
    if (!existsSync(this.releases)) return { reports: [], legacyCount }
    assertNoSymlinks(this.releases)

    const reports: SyncReport[] = []
    for (const source of readdirSync(this.releases, { withFileTypes: true })) {
      const sourceDir = join(this.releases, source.name)
      assertNoSymlinks(sourceDir)
      if (!source.isDirectory() || !digestPattern.test(source.name)) {
        throw new Error(`Invalid sync report source directory: ${sourceDir}`)
      }
      for (const file of readdirSync(sourceDir, { withFileTypes: true })) {
        const path = join(sourceDir, file.name)
        assertNoSymlinks(path)
        const key = file.name.endsWith('.md') ? file.name.slice(0, -3) : ''
        if (!file.isFile() || !digestPattern.test(key)) {
          throw new Error(`Invalid sync report file: ${path}`)
        }
        reports.push(readReport(path, source.name, key))
      }
    }
    return { reports, legacyCount }
  }
}
