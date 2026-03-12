import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getContribDir, validatePathSegment } from '../utils/config.js'
import { resolveRepo } from '../utils/resolve-repo.js'
import { parseFrontmatter } from '../utils/frontmatter.js'

function getSkillsDir(owner: string, name: string): string {
  return join(getContribDir(owner, name), 'skills')
}

function getSkillPath(owner: string, repo: string, skillName: string): string {
  return join(getSkillsDir(owner, repo), validatePathSegment(skillName), 'SKILL.md')
}

export async function skillList(repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const dir = getSkillsDir(owner, name)

  if (!existsSync(dir)) {
    return `## Skills — ${owner}/${name}\n\n_No skills yet. Use \`skill_write\` to create one._`
  }

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map((e) => {
      const skillPath = join(dir, e.name, 'SKILL.md')
      if (!existsSync(skillPath)) return null
      const content = readFileSync(skillPath, 'utf-8')
      const meta = parseFrontmatter(content)
      return { dir: e.name, name: meta.name || e.name, description: meta.description }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)

  if (entries.length === 0) {
    return `## Skills — ${owner}/${name}\n\n_No skills found._`
  }

  const lines = [
    `## Skills — ${owner}/${name} (${entries.length})`,
    '',
    '| Skill | Description |',
    '| --- | --- |',
    ...entries.map(e => `| \`${e.dir}\` | ${e.description || '—'} |`),
  ]

  return lines.join('\n')
}

export async function skillRead(skillName: string, repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const path = getSkillPath(owner, name, skillName)

  if (!existsSync(path)) {
    return `Error: Skill "${skillName}" not found. Use \`skill_list\` to see available skills.`
  }

  return readFileSync(path, 'utf-8')
}

export async function skillWrite(skillName: string, content: string, repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const path = getSkillPath(owner, name, skillName)
  const dir = join(getSkillsDir(owner, name), skillName)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileSync(path, content, 'utf-8')
  return `Skill "${skillName}" written to ~/.contribbot/${owner}/${name}/skills/${skillName}/SKILL.md`
}
