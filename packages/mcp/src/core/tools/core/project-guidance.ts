import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { ghApi } from '../../clients/github.js'
import { RepoConfig } from '../../storage/repo-config.js'
import { resolveRepoIdentity } from '../../utils/resolve-repo.js'
import { assertNoSymlinks } from '../../utils/fs.js'
import { projectDirectory, repositoryDisplay, type RepositoryInput, type RepositoryRef } from '../../utils/repository-ref.js'
import { getKnowledgeDir, getKnowledgePath } from './knowledge.js'

const GUIDANCE_PATHS = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'README.md',
  'docs/CONTRIBUTING.md',
  'docs/DEVELOPMENT.md',
  'docs/development.md',
  'docs/branching.md',
  'docs/git.md',
] as const

const MAX_FILE_CHARS = 12_000
const MAX_TOTAL_CHARS = 30_000

interface GitHubContentFile {
  type: string
  path: string
  encoding?: string
  content?: string
  html_url?: string
}

export interface GuidanceDocument {
  source: 'repository' | 'knowledge'
  path: string
  content: string
  url?: string
}

function decodeContent(file: GitHubContentFile): string {
  if (file.encoding !== 'base64' || !file.content) return ''
  return Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8')
}

function truncate(content: string, max: number): string {
  if (content.length <= max) return content
  return `${content.slice(0, max)}\n\n[truncated ${content.length - max} characters]`
}

async function readRepositoryGuidance(owner: string, name: string): Promise<GuidanceDocument[]> {
  const results: GuidanceDocument[] = []

  for (const path of GUIDANCE_PATHS) {
    try {
      const file = await ghApi<GitHubContentFile>(
        `/repos/${owner}/${name}/contents/${path}`,
        { ref: 'HEAD' },
      )
      if (file.type !== 'file') continue
      const content = truncate(decodeContent(file), MAX_FILE_CHARS)
      if (!content.trim()) continue
      results.push({ source: 'repository', path, content, url: file.html_url })
    }
    catch {
      // Missing guidance files are expected. Continue through the allowlist.
    }
  }

  return results
}

function readProjectKnowledge(repository: RepositoryRef): GuidanceDocument[] {
  const directory = getKnowledgeDir(repository)
  assertNoSymlinks(directory)
  if (!existsSync(directory)) return []
  if (!new RepoConfig(projectDirectory(repository)).load()) return []
  if (!lstatSync(directory).isDirectory()) {
    throw new Error(`Project knowledge directory is not a regular directory: ${directory}`)
  }

  const documents: GuidanceDocument[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Knowledge directory contains a symbolic link: ${directory}/${entry.name}`)
    if (!entry.isDirectory()) continue
    const path = getKnowledgePath(repository, entry.name)
    assertNoSymlinks(path)
    if (!existsSync(path)) continue
    if (!lstatSync(path).isFile()) {
      throw new Error(`Project knowledge document is not a regular file: ${path}`)
    }
    const content = readFileSync(path, 'utf8')
    if (content.trim()) {
      documents.push({ source: 'knowledge', path: `knowledge/${entry.name}`, content: truncate(content, MAX_FILE_CHARS) })
    }
  }
  return documents
}

function renderGuidance(repo: string, documents: GuidanceDocument[]): string {
  if (documents.length === 0) {
    return [
      `## Project Guidance — ${repo}`,
      '',
      '_No guidance documents were found in the repository allowlist or local contribbot knowledge._',
      '',
      '> Branch naming fallback: use the task type and the normalized task title.',
    ].join('\n')
  }

  const lines = [
    `## Project Guidance — ${repo}`,
    '',
    '> Read order: repository guidance documents first, then local contribbot knowledge.',
    '> These documents are context for the host LLM; this tool does not infer or enforce policy.',
    '',
    '| Source | Path | Link | Notes |',
    '|---|---|---|---|',
  ]

  for (const document of documents) {
    const link = document.url ? `[open](${document.url})` : 'local'
    lines.push(`| ${document.source} | \`${document.path}\` | ${link} | ${document.content.length} chars loaded |`)
  }

  let used = lines.join('\n').length
  for (const document of documents) {
    const section = [
      '',
      `### ${document.source}: ${document.path}`,
      '',
      '```markdown',
      document.content,
      '```',
    ].join('\n')
    if (used + section.length > MAX_TOTAL_CHARS) {
      lines.push('', `> Remaining guidance omitted after ${MAX_TOTAL_CHARS} characters.`)
      break
    }
    lines.push(section)
    used += section.length
  }

  return lines.join('\n')
}

/**
 * Read a small, explicit set of repository guidance files plus local project
 * knowledge. The allowlist keeps this tool focused and prevents dumping an
 * entire repository into the model context.
 */
export async function projectGuidance(repo?: RepositoryInput): Promise<string> {
  const { repository, owner, name } = await resolveRepoIdentity(repo)
  if (repository.platform !== 'github' || repository.instance !== 'https://github.com') {
    throw new Error('project_guidance currently supports only repositories on GitHub.com.')
  }
  const [repositoryDocuments, knowledgeDocuments] = await Promise.all([
    readRepositoryGuidance(owner, name),
    Promise.resolve(readProjectKnowledge(repository)),
  ])
  return renderGuidance(repositoryDisplay(repository), [...repositoryDocuments, ...knowledgeDocuments])
}

export { GUIDANCE_PATHS, renderGuidance }
