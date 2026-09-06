import { ghApi, parseRepo } from '../../clients/github.js'
import { readKnowledge, listAllKnowledge } from './knowledge-resources.js'

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

function readProjectKnowledge(repo: string): GuidanceDocument[] {
  return listAllKnowledge()
    .filter(entry => entry.repo === repo)
    .map(entry => {
      const content = readKnowledge(repo, entry.name)
      return content
        ? { source: 'knowledge' as const, path: `knowledge/${entry.name}`, content: truncate(content, MAX_FILE_CHARS) }
        : null
    })
    .filter((entry): entry is GuidanceDocument => entry !== null)
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
export async function projectGuidance(repo?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const normalizedRepo = `${owner}/${name}`
  const [repositoryDocuments, knowledgeDocuments] = await Promise.all([
    readRepositoryGuidance(owner, name),
    Promise.resolve(readProjectKnowledge(normalizedRepo)),
  ])
  return renderGuidance(normalizedRepo, [...repositoryDocuments, ...knowledgeDocuments])
}

export { GUIDANCE_PATHS, renderGuidance }
