import { parseRepo, getCompareCommits, listReleases, searchIssues } from '../clients/github.js'
import { UpstreamStore } from '../storage/upstream-store.js'
import { DAILY_COMMIT_ACTIONS, validateEnum } from '../enums.js'
import type { DailyCommitAction } from '../enums.js'
import { getContribDir } from '../utils/config.js'

function parseCommitType(message: string): string {
  const firstLine = message.split('\n')[0] ?? ''
  const match = firstLine.match(/^(\w+)[\s(:]/)
  if (!match?.[1]) return 'chore'
  const prefix = match[1].toLowerCase()
  const known = ['feat', 'fix', 'refactor', 'docs', 'style', 'perf', 'test', 'build', 'ci', 'chore', 'revert']
  return known.includes(prefix) ? prefix : 'chore'
}

function extractSearchKeywords(message: string): string | null {
  const firstLine = message.split('\n')[0] ?? ''
  const subject = firstLine.replace(/^\w+(\([^)]*\))?\s*:\s*/, '').trim()
  if (!subject) return null

  const scopeMatch = firstLine.match(/^\w+\(([^)]+)\)/)
  if (scopeMatch?.[1]) {
    return scopeMatch[1]
  }

  const words = subject
    .split(/[\s:,]+/)
    .filter(w => w.length > 2)
    .slice(0, 3)

  return words.length > 0 ? words.join(' ') : null
}

// ── Noise Detection ──────────────────────────────────────

// Universal noise — applies to any upstream repo
const NOISE_TYPES = new Set(['ci', 'build', 'style'])

const NOISE_SCOPE_PATTERNS = [
  /^deps?$/i,
]

const NOISE_MESSAGE_PATTERNS = [
  /\bbump\b/i,
  /\bupgrade\s+dep/i,
  /\bdeps?\b.*\bupdate/i,
  /\bupdate\s+dependency\b/i,
]

/**
 * Suggest whether a commit should be skipped (noise) or is relevant.
 * Only flags universally irrelevant commits (CI, deps, build).
 * Project-specific filtering (React, site, dumi, etc.) should be handled
 * by the LLM using project skills as context.
 * Returns 'skip' for noise, null for relevant commits.
 */
export function suggestAction(type: string, message: string): 'skip' | null {
  // Type-based noise
  if (NOISE_TYPES.has(type)) return 'skip'

  // Scope-based noise (works for any type: chore(deps), fix(deps), etc.)
  const firstLine = message.split('\n')[0] ?? ''
  const scopeMatch = firstLine.match(/^\w+\(([^)]+)\)/i)
  if (scopeMatch) {
    const scope = scopeMatch[1] ?? ''
    if (NOISE_SCOPE_PATTERNS.some(p => p.test(scope))) return 'skip'
  }

  // Message pattern matching
  if (NOISE_MESSAGE_PATTERNS.some(p => p.test(firstLine))) return 'skip'

  return null
}

// ── Output Helpers ──────────────────────────────────────

function actionLabel(action: string | null): string {
  if (!action) return '—'
  if (action === 'synced') return '✓ synced'
  return action
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${month}-${day}`
}

// ── Main Functions ──────────────────────────────────────

export async function upstreamDaily(
  upstreamRepo: string,
  repo?: string,
  sinceTag?: string,
): Promise<string> {
  const { owner: upOwner, name: upName } = parseRepo(upstreamRepo)
  const { owner: tgtOwner, name: tgtName } = parseRepo(repo)
  const contribDir = getContribDir(tgtOwner, tgtName)
  const store = new UpstreamStore(contribDir)

  const upstreamRepoKey = `${upOwner}/${upName}`
  let anchorTag = store.getLatestVersionTag(upstreamRepoKey)

  // ── State 1: No anchor, no sinceTag — show releases for selection ──
  if (!anchorTag && !sinceTag) {
    const releases = await listReleases(upOwner, upName)
    if (releases.length === 0) {
      throw new Error(`No releases found for ${upOwner}/${upName}`)
    }

    const lines: string[] = [
      `## Initialize Sync Anchor`,
      '',
      `No tracked versions for ${upOwner}/${upName}.`,
      '',
      '| # | Version | Date |',
      '|---|---------|------|',
    ]

    releases.forEach((release, i) => {
      const date = release.published_at ? release.published_at.slice(0, 10) : '—'
      lines.push(`| ${i + 1} | ${release.tag_name} | ${date} |`)
    })

    lines.push('')
    lines.push('Select your current aligned version:')
    lines.push(`\`upstream_daily(upstream_repo="${upOwner}/${upName}", since_tag="${releases[0]?.tag_name ?? ''}")\``)

    return lines.join('\n')
  }

  // ── State 2: No anchor, with sinceTag — initialize from releases ──
  if (!anchorTag && sinceTag) {
    const releases = await listReleases(upOwner, upName, 100)

    // Find sinceTag in releases (flexible v-prefix matching)
    const sinceTagNormalized = sinceTag.replace(/^v/, '')
    const sinceIndex = releases.findIndex((r) => {
      const tagNormalized = r.tag_name.replace(/^v/, '')
      return tagNormalized === sinceTagNormalized
    })

    if (sinceIndex === -1) {
      throw new Error(`Tag ${sinceTag} not found in releases for ${upOwner}/${upName}`)
    }

    // Releases are returned newest-first; those AFTER sinceTag are indices 0..sinceIndex-1
    const newerReleases = releases.slice(0, sinceIndex)

    // Record newer releases (oldest first so the last added becomes the anchor)
    for (const release of [...newerReleases].reverse()) {
      const version = release.tag_name.replace(/^v/, '')
      store.addVersion(upstreamRepoKey, version, [])
    }

    // If no newer releases, record the sinceTag itself as the anchor
    if (newerReleases.length === 0) {
      store.addVersion(upstreamRepoKey, sinceTagNormalized, [])
    }

    anchorTag = store.getLatestVersionTag(upstreamRepoKey)
  }

  // ── State 3: Has anchor — normal run ──
  if (!anchorTag) {
    throw new Error(`Failed to establish anchor tag for ${upOwner}/${upName}`)
  }

  // Check for new releases and record them
  const releases = await listReleases(upOwner, upName)
  const anchorNormalized = anchorTag.replace(/^v/, '')
  const anchorIndex = releases.findIndex((r) => {
    const tagNormalized = r.tag_name.replace(/^v/, '')
    return tagNormalized === anchorNormalized
  })

  if (anchorIndex > 0) {
    // There are newer releases — record them (oldest first)
    const newerReleases = releases.slice(0, anchorIndex)
    for (const release of [...newerReleases].reverse()) {
      const version = release.tag_name.replace(/^v/, '')
      store.addVersion(upstreamRepoKey, version, [])
    }
    anchorTag = store.getLatestVersionTag(upstreamRepoKey) ?? anchorTag
  }

  // Determine the full tag_name (with v prefix if releases use it)
  const anchorRelease = releases.find((r) => {
    const tagNormalized = r.tag_name.replace(/^v/, '')
    return tagNormalized === anchorTag!.replace(/^v/, '')
  })
  const compareBase = anchorRelease ? anchorRelease.tag_name : anchorTag

  // Compare anchor..HEAD
  const compareResult = await getCompareCommits(upOwner, upName, compareBase, 'HEAD')

  // Deduplicate against existing daily commits
  const existingDaily = store.getDaily(upstreamRepoKey)
  const existingShas = new Set(existingDaily.commits.map(c => c.sha))
  const newCommits = compareResult.commits.filter(c => !existingShas.has(c.sha))

  interface NewCommitEntry {
    sha: string
    message: string
    type: string
    date: string
    action: DailyCommitAction | null
    ref: string | null
  }

  const newEntries: NewCommitEntry[] = []

  for (const commit of newCommits) {
    const firstLine = commit.commit.message.split('\n')[0] ?? ''
    const type = parseCommitType(commit.commit.message)
    const date = commit.commit.author?.date ?? new Date().toISOString()

    let action: DailyCommitAction | null = null
    let ref: string | null = null

    const keyword = extractSearchKeywords(commit.commit.message)
    if (keyword) {
      try {
        const results = await searchIssues(`${keyword} repo:${tgtOwner}/${tgtName}`, 3)
        const match = results[0]
        if (match) {
          action = match.pull_request ? 'pr' : 'issue'
          ref = `#${match.number}`
        }
      }
      catch {
        // Ignore search failures
      }
    }

    newEntries.push({
      sha: commit.sha,
      message: firstLine,
      type,
      date: date.slice(0, 10),
      action,
      ref,
    })
  }

  if (newEntries.length > 0) {
    store.addDailyCommits(
      upstreamRepoKey,
      newEntries.map(e => ({
        sha: e.sha,
        message: e.message,
        type: e.type,
        date: e.date,
      })),
    )

    // Batch update commits that have auto-detected actions
    const batchUpdates = newEntries
      .filter(e => e.action)
      .map(e => ({ sha: e.sha, fields: { action: e.action!, ref: e.ref } }))
    if (batchUpdates.length > 0) {
      store.updateDailyCommitBatch(upstreamRepoKey, batchUpdates)
    }
  }

  // Render output
  const allDaily = store.getDaily(upstreamRepoKey)
  const allCommits = allDaily.commits

  // Count categories
  const pending = allCommits.filter(c => c.action === null)
  const pendingRelevant = pending.filter(c => suggestAction(c.type, c.message) === null)
  const pendingNoise = pending.filter(c => suggestAction(c.type, c.message) === 'skip')
  const linkedCount = allCommits.filter(c => c.action !== null && c.action !== 'skip' && c.action !== 'synced').length
  const skippedCount = allCommits.filter(c => c.action === 'skip').length
  const syncedCount = allCommits.filter(c => c.action === 'synced').length

  const lines: string[] = [
    `## Daily — ${upOwner}/${upName}`,
    `> Anchor: ${anchorTag} · 最后检查: ${allDaily.last_checked ?? '—'} · ${newEntries.length} new · ${linkedCount} 已关联 · ${pendingRelevant.length} 待处理${pendingNoise.length > 0 ? ` · ${pendingNoise.length} 建议skip` : ''}${skippedCount > 0 ? ` · ${skippedCount} skipped` : ''}${syncedCount > 0 ? ` · ${syncedCount} synced` : ''}`,
    '',
  ]

  // Only show pending commits by default (actionable view)
  const sorted = [...allCommits]
    .filter(c => c.action === null)
    .sort((a, b) => b.date.localeCompare(a.date))

  if (sorted.length === 0) {
    lines.push('_All commits processed. No pending items._')
  }
  else {
    lines.push('| # | SHA | Date | Type | Commit | Suggest | Action | Ref |')
    lines.push('|---|-----|------|------|--------|---------|--------|-----|')

    sorted.forEach((commit, i) => {
      const refText = commit.ref
        ? `[${commit.ref}](https://github.com/${tgtOwner}/${tgtName}/issues/${commit.ref.replace('#', '')})`
        : '—'
      const suggest = suggestAction(commit.type, commit.message) ?? '—'
      lines.push(
        `| ${i + 1} | ${commit.sha.slice(0, 7)} | ${formatDate(commit.date)} | ${commit.type} | ${commit.message} | ${suggest} | ${actionLabel(commit.action)} | ${refText} |`,
      )
    })
  }

  return lines.join('\n')
}

export function upstreamDailyAct(
  upstreamRepo: string,
  sha: string,
  action: string,
  ref?: string,
  repo?: string,
): string {
  const { owner: upOwner, name: upName } = parseRepo(upstreamRepo)
  const { owner: tgtOwner, name: tgtName } = parseRepo(repo)
  const contribDir = getContribDir(tgtOwner, tgtName)
  const store = new UpstreamStore(contribDir)

  const daily = store.getDaily(`${upOwner}/${upName}`)
  // Support matching by SHA prefix or PR number (e.g. "#57223" or "57223")
  const prMatch = sha.match(/^#?(\d{4,})$/)
  const commit = prMatch
    ? daily.commits.find(c => c.message.includes(`(#${prMatch[1]})`))
    : daily.commits.find(c => c.sha === sha || c.sha.startsWith(sha))

  if (!commit) {
    throw new Error(`Commit "${sha}" not found in daily data for ${upOwner}/${upName}. Use SHA prefix or PR number (e.g. "#57223").`)
  }

  store.updateDailyCommit(`${upOwner}/${upName}`, commit.sha, {
    action: validateEnum(DAILY_COMMIT_ACTIONS, action, 'action'),
    ref: ref ?? null,
  })

  return `Updated ${upOwner}/${upName} commit ${commit.sha.slice(0, 7)}: action → ${action}${ref ? `, ref → ${ref}` : ''}`
}

/**
 * Batch skip all commits that are suggested as noise.
 */
export function upstreamDailySkipNoise(
  upstreamRepo: string,
  repo?: string,
): string {
  const { owner: upOwner, name: upName } = parseRepo(upstreamRepo)
  const { owner: tgtOwner, name: tgtName } = parseRepo(repo)
  const contribDir = getContribDir(tgtOwner, tgtName)
  const store = new UpstreamStore(contribDir)

  const daily = store.getDaily(`${upOwner}/${upName}`)

  const updates = daily.commits
    .filter(c => c.action === null && suggestAction(c.type, c.message) === 'skip')
    .map(c => ({ sha: c.sha, fields: { action: 'skip' as const } }))

  if (updates.length === 0) {
    return `No noise commits to skip for ${upOwner}/${upName}.`
  }

  store.updateDailyCommitBatch(`${upOwner}/${upName}`, updates)

  return `Skipped **${updates.length}** noise commits for ${upOwner}/${upName}. Use \`upstream_daily\` to see remaining.`
}
