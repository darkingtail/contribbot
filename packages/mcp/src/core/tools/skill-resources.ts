import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { validatePathSegment } from '../utils/config.js'
import { parseFrontmatter } from '../utils/frontmatter.js'

interface SkillEntry {
  repo: string
  name: string
  description: string
}

export function listAllSkills(): SkillEntry[] {
  const baseDir = join(homedir(), '.contribbot')
  if (!existsSync(baseDir)) return []

  const results: SkillEntry[] = []

  for (const ownerEntry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!ownerEntry.isDirectory()) continue
    const ownerDir = join(baseDir, ownerEntry.name)

    for (const repoEntry of readdirSync(ownerDir, { withFileTypes: true })) {
      if (!repoEntry.isDirectory()) continue
      const repo = `${ownerEntry.name}/${repoEntry.name}`
      const skillsDir = join(ownerDir, repoEntry.name, 'skills')
      if (!existsSync(skillsDir)) continue

      for (const skillEntry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!skillEntry.isDirectory()) continue
        const skillPath = join(skillsDir, skillEntry.name, 'SKILL.md')
        if (!existsSync(skillPath)) continue

        const content = readFileSync(skillPath, 'utf-8')
        const meta = parseFrontmatter(content)
        results.push({
          repo,
          name: skillEntry.name,
          description: meta.description || meta.name || skillEntry.name,
        })
      }
    }
  }

  return results
}

export function readSkill(repo: string, skillName: string): string | null {
  const parts = repo.split('/')
  const owner = parts[0] ?? ''
  const name = parts[1] ?? ''
  if (!owner || !name) return null

  validatePathSegment(owner)
  validatePathSegment(name)
  validatePathSegment(skillName)

  const skillPath = join(homedir(), '.contribbot', owner, name, 'skills', skillName, 'SKILL.md')
  if (!existsSync(skillPath)) return null
  return readFileSync(skillPath, 'utf-8')
}
