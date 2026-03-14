import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getContribDir, validatePathSegment } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { parseFrontmatter } from '../../utils/frontmatter.js'

function getKnowledgeDir(owner: string, name: string): string {
  return join(getContribDir(owner, name), 'knowledge')
}

function getKnowledgePath(owner: string, repo: string, knowledgeName: string): string {
  return join(getKnowledgeDir(owner, repo), validatePathSegment(knowledgeName), 'README.md')
}

export async function knowledgeList(repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const dir = getKnowledgeDir(owner, name)

  if (!existsSync(dir)) {
    return `## Knowledge — ${owner}/${name}\n\n_No knowledge yet. Use \`knowledge_write\` to create one._`
  }

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map((e) => {
      const docPath = join(dir, e.name, 'README.md')
      if (!existsSync(docPath)) return null
      const content = readFileSync(docPath, 'utf-8')
      const meta = parseFrontmatter(content)
      return { dir: e.name, name: meta.name || e.name, description: meta.description }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)

  if (entries.length === 0) {
    return `## Knowledge — ${owner}/${name}\n\n_No knowledge found._`
  }

  const lines = [
    `## Knowledge — ${owner}/${name} (${entries.length})`,
    '',
    '| Name | Description |',
    '| --- | --- |',
    ...entries.map(e => `| \`${e.dir}\` | ${e.description || '—'} |`),
  ]

  return lines.join('\n')
}

export async function knowledgeRead(knowledgeName: string, repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const path = getKnowledgePath(owner, name, knowledgeName)

  if (!existsSync(path)) {
    return `Error: Knowledge "${knowledgeName}" not found. Use \`knowledge_list\` to see available entries.`
  }

  return readFileSync(path, 'utf-8')
}

export async function knowledgeWrite(knowledgeName: string, content: string, repo?: string): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const path = getKnowledgePath(owner, name, knowledgeName)
  const dir = join(getKnowledgeDir(owner, name), knowledgeName)

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileSync(path, content, 'utf-8')
  return `Knowledge "${knowledgeName}" written to ~/.contribbot/${owner}/${name}/knowledge/${knowledgeName}/README.md`
}
