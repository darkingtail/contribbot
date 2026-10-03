import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RepoConfig } from '../../storage/repo-config.js'
import { validatePathSegment } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { parseFrontmatter } from '../../utils/frontmatter.js'
import { assertNoSymlinks } from '../../utils/fs.js'
import { projectDirectory, repositoryDisplay, type RepositoryInput, type RepositoryRef } from '../../utils/repository-ref.js'

export function getKnowledgeDir(repository: RepositoryRef): string {
  return join(projectDirectory(repository), 'knowledge')
}

export function getKnowledgePath(repository: RepositoryRef, knowledgeName: string): string {
  return join(getKnowledgeDir(repository), validatePathSegment(knowledgeName), 'README.md')
}

export function knowledgeExists(repository: RepositoryRef, knowledgeName: string): boolean {
  const path = getKnowledgePath(repository, knowledgeName)
  assertNoSymlinks(path)
  return existsSync(path)
}

export function assertKnowledgeProject(repository: RepositoryRef): void {
  if (!new RepoConfig(projectDirectory(repository)).load()) {
    throw new Error(`Knowledge project ${repositoryDisplay(repository)} is not initialized.`)
  }
}

export function listProjectKnowledge(repository: RepositoryRef): Array<{ name: string, description: string }> {
  const dir = getKnowledgeDir(repository)
  assertNoSymlinks(dir)
  if (!existsSync(dir)) return []
  assertKnowledgeProject(repository)
  if (!lstatSync(dir).isDirectory()) throw new Error(`Invalid project knowledge directory: ${dir}`)

  const entries = readdirSync(dir, { withFileTypes: true })
  if (entries.some(e => e.isSymbolicLink())) throw new Error(`Knowledge directory contains a symbolic link: ${dir}`)
  return entries
    .filter(e => e.isDirectory())
    .map((e) => {
      const docPath = getKnowledgePath(repository, e.name)
      assertNoSymlinks(docPath)
      if (!existsSync(docPath)) return null
      if (!lstatSync(docPath).isFile()) throw new Error(`Invalid project knowledge document: ${docPath}`)
      const content = readFileSync(docPath, 'utf-8')
      const meta = parseFrontmatter(content)
      return { name: e.name, description: meta.description || meta.name || e.name }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
}

export async function knowledgeList(repo?: RepositoryInput): Promise<string> {
  const { repository } = await resolveRepo(repo)
  assertKnowledgeProject(repository)
  const dir = getKnowledgeDir(repository)
  const label = repositoryDisplay(repository)

  assertNoSymlinks(dir)
  if (!existsSync(dir)) {
    return `## Knowledge — ${label}\n\n_No knowledge yet. Use \`knowledge_write\` to create one._`
  }

  const entries = listProjectKnowledge(repository)

  if (entries.length === 0) {
    return `## Knowledge — ${label}\n\n_No knowledge found._`
  }

  const lines = [
    `## Knowledge — ${label} (${entries.length})`,
    '',
    '| Name | Description |',
    '| --- | --- |',
    ...entries.map(e => `| \`${e.name}\` | ${e.description || '—'} |`),
  ]

  return lines.join('\n')
}

export async function knowledgeRead(knowledgeName: string, repo?: RepositoryInput): Promise<string> {
  const { repository } = await resolveRepo(repo)
  assertKnowledgeProject(repository)
  const path = getKnowledgePath(repository, knowledgeName)
  assertNoSymlinks(path)

  if (!existsSync(path)) {
    return `Error: Knowledge "${knowledgeName}" not found. Use \`knowledge_list\` to see available entries.`
  }

  return readFileSync(path, 'utf-8')
}

export async function knowledgeWrite(knowledgeName: string, content: string, repo?: RepositoryInput): Promise<string> {
  const { repository } = await resolveRepo(repo)
  assertKnowledgeProject(repository)
  const path = getKnowledgePath(repository, knowledgeName)
  const dir = join(getKnowledgeDir(repository), validatePathSegment(knowledgeName))

  assertNoSymlinks(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  assertNoSymlinks(path)
  writeFileSync(path, content, 'utf-8')
  return `Knowledge "${knowledgeName}" written to ${path}`
}
