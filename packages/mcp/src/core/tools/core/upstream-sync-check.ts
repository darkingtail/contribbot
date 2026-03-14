import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getContribDir,
} from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { markdownTable } from '../../utils/format.js'
import { getReleaseByTag, getLatestRelease, searchCommits, parseRepo } from '../../clients/github.js'
import { UpstreamStore } from '../../storage/upstream-store.js'
import type { PRType } from '../../enums.js'

interface SyncItem {
  prNumber: number
  title: string
  type: PRType
  component: string | null
  status: 'synced' | 'not_synced' | 'partial' | 'not_applicable'
  ref: string | null
}

function extractPRsFromRelease(body: string): { number: number, title: string }[] {
  const prs: { number: number, title: string }[] = []
  const prPattern = /#(\d{4,6})/g
  const lines = body.split('\n')

  for (const line of lines) {
    const matches = [...line.matchAll(prPattern)]
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1]!
      const prNum = Number.parseInt(lastMatch[1] ?? '0', 10)
      const title = line
        .replace(/^[-*]\s*/, '')
        .replace(/\s*\(#\d+\)\s*/g, '')
        .replace(/\s*by\s+@\S+\s+in\s+.*$/i, '')
        .replace(/https:\/\/github\.com\/\S+/g, '')
        .trim()
      if (title && prNum > 0) {
        prs.push({ number: prNum, title })
      }
    }
  }

  const seen = new Set<number>()
  return prs.filter((pr) => {
    if (seen.has(pr.number)) return false
    seen.add(pr.number)
    return true
  })
}

function extractType(title: string): PRType {
  const lower = title.toLowerCase()
  if (/^feat[:(]|^feature[:(]|^add[:\s]|^\[feat\]/.test(lower)) return 'feat'
  if (/^fix[:(]|^bug[:(]|^bugfix[:(]|^hotfix[:(]|\[fix\]|\[bug\]/.test(lower)) return 'fix'
  return 'other'
}

function extractComponent(title: string): string | null {
  const match = title.match(/^(?:feat|fix|refactor|style|docs|chore|perf|test)?\s*\(?([A-Z][a-zA-Z]+)\)?[:\s]/i)
  return match?.[1] ?? null
}

function getSyncDir(owner: string, repo: string): string {
  return join(getContribDir(owner, repo), 'sync')
}

const statusIcon = (s: SyncItem['status']) => {
  switch (s) {
    case 'synced': return '✅'
    case 'not_synced': return '❌'
    case 'partial': return '🔶'
    case 'not_applicable': return '➖'
  }
}

const typeLabel = (t: PRType) => {
  switch (t) {
    case 'feat': return '🆕 Feature'
    case 'fix': return '🐛 Fix'
    case 'other': return '🔧 Other'
  }
}

function buildOutput(
  results: SyncItem[],
  upOwner: string,
  upName: string,
  tgtOwner: string,
  tgtName: string,
  releaseTag: string,
  releaseUrl: string,
  targetBranch?: string,
): string {
  const synced = results.filter(r => r.status === 'synced').length
  const notSynced = results.filter(r => r.status === 'not_synced').length
  const tgtRef = targetBranch ? `${tgtOwner}/${tgtName}@${targetBranch}` : `${tgtOwner}/${tgtName}`

  const lines: string[] = [
    `## Upstream Sync: ${upOwner}/${upName} ${releaseTag} → ${tgtRef}`,
    '',
    `**Release**: [${releaseTag}](${releaseUrl})`,
    `**Branch**: ${targetBranch ?? '(default)'}`,
    `**Total**: ${results.length} | ✅ Synced: ${synced} | ❌ Not synced: ${notSynced}`,
    '',
  ]

  const headers = ['Status', 'Type', 'PR', 'Component', 'Title', 'Ref']

  for (const type of ['feat', 'fix', 'other'] as PRType[]) {
    const group = results.filter(r => r.type === type)
    if (group.length === 0) continue

    lines.push(`### ${typeLabel(type)} (${group.length})`)
    const rows = group.map(r => [
      statusIcon(r.status),
      r.type,
      `#${r.prNumber}`,
      r.component ?? '-',
      r.title.slice(0, 45),
      r.ref ?? '-',
    ])
    lines.push(markdownTable(headers, rows))
    lines.push('')
  }

  const needSync = results.filter(r => r.status === 'not_synced')
  if (needSync.length > 0) {
    lines.push(`### Needs Sync (${needSync.length})`)
    for (const item of needSync) {
      lines.push(`- [${item.type}] ${upOwner}/${upName}#${item.prNumber}: ${item.title}`)
    }
  }

  return lines.join('\n')
}

export async function upstreamSyncCheck(
  version?: string,
  upstreamRepo?: string,
  targetRepo?: string,
  save = false,
  targetBranch?: string,
): Promise<string> {
  if (!upstreamRepo) return 'Error: upstream_repo is required. Pass "owner/name".'
  if (!targetRepo) return 'Error: target_repo is required. Pass "owner/name".'
  const { owner: upOwner, name: upName } = parseRepo(upstreamRepo)
  const { owner: tgtOwner, name: tgtName } = await resolveRepo(targetRepo)

  let release = null

  if (version) {
    for (const tag of [version, `v${version}`]) {
      release = await getReleaseByTag(upOwner, upName, tag)
      if (release) break
    }
    if (!release) {
      return `Error: Could not find ${upOwner}/${upName} release for version "${version}"`
    }
  }
  else {
    release = await getLatestRelease(upOwner, upName)
    if (!release) {
      return `Error: Could not find any release for ${upOwner}/${upName}`
    }
  }

  const releasePRs = extractPRsFromRelease(release.body ?? '')
  if (releasePRs.length === 0) {
    return `## Upstream Sync: ${upOwner}/${upName} ${release.tag_name}\n\nNo PRs found in release notes.`
  }

  const results: SyncItem[] = []

  for (const pr of releasePRs) {
    const type = extractType(pr.title)
    const component = extractComponent(pr.title)
    let status: SyncItem['status'] = 'not_synced'
    let ref: string | null = null

    try {
      const commits = await searchCommits(
        tgtOwner,
        tgtName,
        `${upName}#${pr.number} OR ${upOwner}/${upName}#${pr.number}`,
        5,
        targetBranch,
      )
      const firstCommit = commits[0]
      if (firstCommit) {
        status = 'synced'
        ref = firstCommit.sha.slice(0, 7)
      }
    }
    catch {
      // rate limit
    }

    results.push({ prNumber: pr.number, title: pr.title, type, component, status, ref })
  }

  const output = buildOutput(results, upOwner, upName, tgtOwner, tgtName, release.tag_name, release.html_url, targetBranch)

  if (save) {
    const dir = getSyncDir(tgtOwner, tgtName)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `${release.tag_name}.md`)
    writeFileSync(filePath, output, 'utf-8')

    // Auto-mark daily commits before this release date as 'synced'
    const releaseDate = release.published_at?.slice(0, 10)
    let syncedMsg = ''
    if (releaseDate) {
      const contribDir = getContribDir(tgtOwner, tgtName)
      const store = new UpstreamStore(contribDir)
      const count = store.markDailyAsSynced(`${upOwner}/${upName}`, releaseDate)
      if (count > 0) {
        syncedMsg = `\n> ✓ Marked ${count} daily commits (≤ ${releaseDate}) as synced`
      }
    }

    return `${output}\n\n> 📁 Saved to ~/.contribbot/${tgtOwner}/${tgtName}/sync/${release.tag_name}.md${syncedMsg}`
  }

  return output
}

export async function syncHistory(targetRepo?: string): Promise<string> {
  if (!targetRepo) return 'Error: repo is required. Pass "owner/name".'
  const { owner: tgtOwner, name: tgtName } = await resolveRepo(targetRepo)
  const dir = getSyncDir(tgtOwner, tgtName)

  if (!existsSync(dir)) {
    return `## Sync History — ${tgtOwner}/${tgtName}\n\n_No records yet. Run \`upstream_sync_check\` with \`save: true\`._`
  }

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse()

  if (files.length === 0) {
    return `## Sync History — ${tgtOwner}/${tgtName}\n\n_No records yet._`
  }

  const lines = [
    `## Sync History — ${tgtOwner}/${tgtName}`,
    '',
    '| Version | 备注 |',
    '| --- | --- |',
  ]

  for (const file of files) {
    const version = file.replace('.md', '')
    const content = readFileSync(join(dir, file), 'utf-8')
    const totalMatch = content.match(/\*\*Total\*\*: (\d+)/)
    const notSyncedMatch = content.match(/❌ Not synced: (\d+)/)
    const total = totalMatch?.[1] ?? '?'
    const notSynced = notSyncedMatch?.[1] ?? '?'
    lines.push(`| ${version} | ${total} PRs，${notSynced} 未对齐 |`)
  }

  return lines.join('\n')
}
