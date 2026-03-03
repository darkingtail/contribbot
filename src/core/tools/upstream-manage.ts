import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseRepo } from '../clients/github.js'
import { UpstreamStore } from '../storage/upstream-store.js'
import { RecordFiles } from '../storage/record-files.js'

function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contrib', owner, name)
}

function difficultyLabel(d: string | null): string {
  if (d === 'easy') return '🟢 easy'
  if (d === 'medium') return '🟡 medium'
  if (d === 'hard') return '🔴 hard'
  return '—'
}

function statusIcon(s: string): string {
  if (s === 'done') return '✅'
  if (s === 'pr_submitted') return '🔵'
  return '⬜'
}

export function upstreamList(repo?: string, upstreamRepo?: string): string {
  const { owner, name } = parseRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new UpstreamStore(contribDir)

  const allRepos = store.listRepos()

  if (allRepos.length === 0) {
    return `## Upstream\n\n_No upstream data yet. Use \`upstream_sync_check\` to import versions._`
  }

  const reposToShow = upstreamRepo
    ? allRepos.filter(r => r === upstreamRepo)
    : allRepos

  if (reposToShow.length === 0) {
    return `## Upstream\n\n_No data for "${upstreamRepo}"._`
  }

  const sections: string[] = []

  for (const upRepo of reposToShow) {
    const versions = store.listVersions(upRepo)
    const daily = store.getDaily(upRepo)

    const activeVersions = versions.filter(v => v.status === 'active')
    const doneVersions = versions.filter(v => v.status === 'done')

    const pendingCommits = daily.commits.filter(c => c.action === null)
    const processedCommits = daily.commits.filter(c => c.action !== null)

    const summaryParts: string[] = []
    summaryParts.push(`Versions: ${activeVersions.length} active · ${doneVersions.length} done`)
    if (daily.last_checked) {
      summaryParts.push(`Daily: 最后检查 ${daily.last_checked}`)
    }

    const lines: string[] = [
      `## Upstream — ${upRepo}`,
      `> ${summaryParts.join(' | ')}`,
      '',
    ]

    // Version sync table
    if (versions.length > 0) {
      lines.push('### 版本同步')
      lines.push('| Version | Status | Items | Progress |')
      lines.push('|---------|--------|-------|----------|')

      for (const ver of versions) {
        const doneItems = ver.items.filter(i => i.status === 'done').length
        const totalItems = ver.items.length
        const versionLink = `[${ver.version}](https://github.com/${upRepo}/releases/tag/${ver.version})`
        lines.push(`| ${versionLink} | ${ver.status} | ${totalItems} item${totalItems !== 1 ? 's' : ''} | ${doneItems}/${totalItems} done |`)
      }

      lines.push('')
    }

    // Daily commits summary
    if (daily.commits.length > 0) {
      lines.push('### 每日 Commits')
      lines.push(`> ${pendingCommits.length} 待处理 · ${processedCommits.length} 已处理 · 共 ${daily.commits.length} 条`)
      lines.push('')
    }

    sections.push(lines.join('\n'))
  }

  return sections.join('\n---\n\n')
}

export async function upstreamDetail(
  upstreamRepo: string,
  version: string,
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const contribDir = getContribDir(owner, name)

  // Try reading record file first
  const records = new RecordFiles(contribDir)
  const recordContent = records.readRecord(`${upstreamRepo}@${version}`)
  if (recordContent) {
    return recordContent
  }

  // No record file — render from UpstreamStore
  const store = new UpstreamStore(contribDir)
  const versions = store.listVersions(upstreamRepo)
  const ver = versions.find(v => v.version === version)

  if (!ver) {
    return `Error: Version "${version}" not found for ${upstreamRepo}. Use \`upstream_list\` to see available versions.`
  }

  const lines: string[] = [
    `# ${upstreamRepo}@${version}`,
    '',
    `> Status: ${ver.status} · ${ver.items.length} items`,
    '',
    '| # | Title | Type | Difficulty | Status | PR |',
    '|---|-------|------|------------|--------|----|',
  ]

  ver.items.forEach((item, i) => {
    const prText = item.pr
      ? `[#${item.pr}](https://github.com/${upstreamRepo}/pull/${item.pr})`
      : '—'
    lines.push(
      `| ${i + 1} | ${item.title} | ${item.type} | ${difficultyLabel(item.difficulty)} | ${statusIcon(item.status)} ${item.status} | ${prText} |`,
    )
  })

  return lines.join('\n')
}

export function upstreamUpdate(
  upstreamRepo: string,
  version: string,
  itemIndex: number,
  fields: { status?: string; pr?: number; difficulty?: string },
  repo?: string,
): string {
  const { owner, name } = parseRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new UpstreamStore(contribDir)

  // Validate version exists
  const versions = store.listVersions(upstreamRepo)
  const ver = versions.find(v => v.version === version)

  if (!ver) {
    return `Error: Version "${version}" not found for ${upstreamRepo}.`
  }

  // Convert 1-based index to 0-based
  const idx = itemIndex - 1
  if (idx < 0 || idx >= ver.items.length) {
    return `Error: Item index ${itemIndex} out of range (1-${ver.items.length}).`
  }

  const item = ver.items[idx]
  const changes: string[] = []

  const updateFields: { status?: 'active' | 'pr_submitted' | 'done'; pr?: number; difficulty?: 'easy' | 'medium' | 'hard' | null } = {}

  if (fields.status) {
    updateFields.status = fields.status as 'active' | 'pr_submitted' | 'done'
    changes.push(`status → ${fields.status}`)
  }

  if (fields.pr !== undefined) {
    updateFields.pr = fields.pr
    changes.push(`PR → #${fields.pr}`)

    // Auto-set status to pr_submitted if not explicitly provided
    if (!fields.status) {
      updateFields.status = 'pr_submitted'
      changes.push(`status → pr_submitted`)
    }
  }

  if (fields.difficulty) {
    updateFields.difficulty = fields.difficulty as 'easy' | 'medium' | 'hard'
    changes.push(`difficulty → ${fields.difficulty}`)
  }

  if (changes.length === 0) {
    return `No changes specified for item #${itemIndex}: **${item.title}**`
  }

  store.updateVersionItem(upstreamRepo, version, idx, updateFields)

  return `Updated ${upstreamRepo}@${version} #${itemIndex} **${item.title}**: ${changes.join(', ')}`
}
