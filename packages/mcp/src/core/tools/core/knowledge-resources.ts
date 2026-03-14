import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { validatePathSegment } from '../../utils/config.js'
import { parseFrontmatter } from '../../utils/frontmatter.js'

interface KnowledgeEntry {
  repo: string
  name: string
  description: string
}

export function listAllKnowledge(): KnowledgeEntry[] {
  const baseDir = join(homedir(), '.contribbot')
  if (!existsSync(baseDir)) return []

  const results: KnowledgeEntry[] = []

  for (const ownerEntry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!ownerEntry.isDirectory()) continue
    const ownerDir = join(baseDir, ownerEntry.name)

    for (const repoEntry of readdirSync(ownerDir, { withFileTypes: true })) {
      if (!repoEntry.isDirectory()) continue
      const repo = `${ownerEntry.name}/${repoEntry.name}`
      const knowledgeDir = join(ownerDir, repoEntry.name, 'knowledge')
      if (!existsSync(knowledgeDir)) continue

      for (const entry of readdirSync(knowledgeDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const docPath = join(knowledgeDir, entry.name, 'README.md')
        if (!existsSync(docPath)) continue

        const content = readFileSync(docPath, 'utf-8')
        const meta = parseFrontmatter(content)
        results.push({
          repo,
          name: entry.name,
          description: meta.description || meta.name || entry.name,
        })
      }
    }
  }

  return results
}

export function readKnowledge(repo: string, knowledgeName: string): string | null {
  const parts = repo.split('/')
  const owner = parts[0] ?? ''
  const name = parts[1] ?? ''
  if (!owner || !name) return null

  validatePathSegment(owner)
  validatePathSegment(name)
  validatePathSegment(knowledgeName)

  const docPath = join(homedir(), '.contribbot', owner, name, 'knowledge', knowledgeName, 'README.md')
  if (!existsSync(docPath)) return null
  return readFileSync(docPath, 'utf-8')
}
