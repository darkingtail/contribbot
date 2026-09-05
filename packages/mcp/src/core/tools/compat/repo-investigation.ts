import { getCommitDetail, getCompareCommits, parseRepo } from '../../clients/github.js'
import type { CompareResult, GitHubCommitDetail, GitHubPullFile } from '../../clients/github.js'
import { markdownTable, truncate } from '../../utils/format.js'

const MAX_PATCH_CHARS = 4_000

function patchExcerpt(file: GitHubPullFile): string {
  if (!file.patch) return '_Patch unavailable (binary or omitted by GitHub)._'
  return `\`\`\`diff\n${truncate(file.patch, MAX_PATCH_CHARS)}\n\`\`\``
}

export function renderCommitDetail(repo: string, detail: GitHubCommitDetail): string {
  const files = detail.files ?? []
  const lines = [
    `## Commit — ${repo}@${detail.sha.slice(0, 7)}`,
    '',
    `**Message:** ${detail.commit.message.split('\n')[0] ?? ''}`,
    `**Author:** ${detail.author?.login ? `@${detail.author.login}` : detail.commit.author?.name ?? 'unknown'}`,
    `**Changes:** +${detail.stats.additions} / -${detail.stats.deletions} across ${files.length} files`,
    '',
    markdownTable(
      ['File', 'Status', 'Changes', 'Notes'],
      files.map(file => [file.filename, file.status, `+${file.additions}/-${file.deletions}`, file.patch ? 'patch included below' : 'patch unavailable']),
    ),
  ]

  for (const file of files) {
    lines.push('', `### ${file.filename}`, '', patchExcerpt(file))
  }
  return lines.join('\n')
}

export function renderCompareRefs(repo: string, base: string, head: string, result: CompareResult): string {
  const files = result.files ?? []
  return [
    `## Compare Refs — ${repo}`,
    '',
    `**Range:** \`${base}...${head}\``,
    `**Status:** ${result.status ?? 'unknown'} · ahead ${result.ahead_by ?? result.total_commits} · behind ${result.behind_by ?? 0}`,
    '',
    files.length
      ? markdownTable(
          ['File', 'Status', 'Changes', 'Notes'],
          files.map(file => [file.filename, file.status, `+${file.additions}/-${file.deletions}`, file.patch ? 'text diff available' : 'binary or patch omitted']),
        )
      : '_No changed files returned._',
  ].join('\n')
}

export async function commitDetail(ref: string, repo?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const detail = await getCommitDetail(owner, name, ref)
  return renderCommitDetail(`${owner}/${name}`, detail)
}

export async function compareRefs(base: string, head: string, repo?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const result = await getCompareCommits(owner, name, base, head)
  return renderCompareRefs(`${owner}/${name}`, base, head, result)
}
