import { lstatSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { RepoConfig } from '../../storage/repo-config.js'
import { assertNoSymlinks } from '../../utils/fs.js'
import { validatePathSegment } from '../../utils/config.js'
import { projectDataRoot, repositoryDisplay } from '../../utils/repository-ref.js'
import { listStoredProjects } from './project-list.js'
import { listProjectKnowledge } from './knowledge.js'

interface KnowledgeEntry {
  digest: string
  repo: string
  name: string
  description: string
}

const digestPattern = /^[a-f0-9]{64}$/

export function listAllKnowledge(): KnowledgeEntry[] {
  return (listStoredProjects() ?? []).flatMap(({ directory, config }) =>
    listProjectKnowledge(config.repository).map(entry => ({
      digest: basename(directory),
      repo: repositoryDisplay(config.repository),
      name: entry.name,
      description: entry.description,
    })),
  )
}

export function readKnowledge(digest: string, knowledgeName: string): string | null {
  if (!digestPattern.test(digest)) throw new Error('Invalid project digest in knowledge URI.')
  validatePathSegment(knowledgeName)
  const directory = join(projectDataRoot(), 'projects', 'v1', digest)
  assertNoSymlinks(directory)
  const stat = lstatSync(directory, { throwIfNoEntry: false })
  if (!stat) return null
  if (!stat.isDirectory()) throw new Error(`Invalid knowledge project directory: ${directory}`)
  if (!new RepoConfig(directory).load()) {
    throw new Error(`Missing schema v3 repository config: ${directory}`)
  }
  const docPath = join(directory, 'knowledge', knowledgeName, 'README.md')
  assertNoSymlinks(docPath)
  const docStat = lstatSync(docPath, { throwIfNoEntry: false })
  if (!docStat) return null
  if (!docStat.isFile()) throw new Error(`Invalid project knowledge document: ${docPath}`)
  return readFileSync(docPath, 'utf8')
}
