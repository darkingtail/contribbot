import { parseRepo, getRepoCommits, searchIssues } from '../clients/github.js'
import { UpstreamStore } from '../storage/upstream-store.js'
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

const NOISE_TYPES = new Set(['ci', 'build', 'style'])

const NOISE_SCOPE_PATTERNS = [
  /^deps$/i,
  /^dep$/i,
]

const NOISE_MESSAGE_PATTERNS = [
  /\bbump\b/i,
  /\bupgrade\s+dep/i,
  /\bdeps?\b.*\bupdate/i,
  /\bworkflow[_-]?run\b/i,
  /\bactions?\//i,
  /\b@types\/react\b/i,
  /\breact[- ]compiler\b/i,
  /\breact[- ]naming[- ]convention\b/i,
  /\bsponsor\b/i,
  /\bfunding\b/i,
  /\bchangelog\b/i,
  /\bpermissions\b.*\byaml\b/i,
]

/**
 * Suggest whether a commit should be skipped (noise) or is relevant.
 * Returns 'skip' for noise, null for relevant commits.
 */
export function suggestAction(type: string, message: string): 'skip' | null {
  // Type-based noise
  if (NOISE_TYPES.has(type)) return 'skip'

  // chore(deps) pattern
  if (type === 'chore') {
    const firstLine = message.split('\n')[0] ?? ''
    const scopeMatch = firstLine.match(/^chore\(([^)]+)\)/i)
    if (scopeMatch) {
      const scope = scopeMatch[1] ?? ''
      if (NOISE_SCOPE_PATTERNS.some(p => p.test(scope))) return 'skip'
    }
  }

  // docs that are clearly noise (sponsor, changelog)
  if (type === 'docs') {
    const lower = message.toLowerCase()
    if (lower.includes('sponsor') || lower.includes('changelog') || lower.includes('funding')) {
      return 'skip'
    }
  }

  // Message pattern matching
  const firstLine = message.split('\n')[0] ?? ''
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
  days?: number,
  repo?: string,
): Promise<string> {
  const effectiveDays = days ?? 7
  const { owner: upOwner, name: upName } = parseRepo(upstreamRepo)
  const { owner: tgtOwner, name: tgtName } = parseRepo(repo)
  const contribDir = getContribDir(tgtOwner, tgtName)
  const store = new UpstreamStore(contribDir)

  const perPage = Math.min(effectiveDays * 5, 100)

  const commits = await getRepoCommits(upOwner, upName, perPage)

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - effectiveDays)

  const recentCommits = commits.filter((c) => {
    const commitDate = c.commit.author?.date
    if (!commitDate) return false
    return new Date(commitDate) >= cutoffDate
  })

  const existingDaily = store.getDaily(`${upOwner}/${upName}`)
  const existingShas = new Set(existingDaily.commits.map(c => c.sha))
  const newCommits = recentCommits.filter(c => !existingShas.has(c.sha))

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
      `${upOwner}/${upName}`,
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
      store.updateDailyCommitBatch(`${upOwner}/${upName}`, batchUpdates)
    }
  }

  // Render output
  const allDaily = store.getDaily(`${upOwner}/${upName}`)
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
    `> 最后检查: ${allDaily.last_checked ?? '—'} · ${newEntries.length} new · ${linkedCount} 已关联 · ${pendingRelevant.length} 待处理${pendingNoise.length > 0 ? ` · ${pendingNoise.length} 建议skip` : ''}${skippedCount > 0 ? ` · ${skippedCount} skipped` : ''}${syncedCount > 0 ? ` · ${syncedCount} synced` : ''}`,
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
    lines.push('| # | Date | Type | Commit | Suggest | Action | Ref |')
    lines.push('|---|------|------|--------|---------|--------|-----|')

    sorted.forEach((commit, i) => {
      const refText = commit.ref
        ? `[${commit.ref}](https://github.com/${tgtOwner}/${tgtName}/issues/${commit.ref.replace('#', '')})`
        : '—'
      const suggest = suggestAction(commit.type, commit.message) ?? '—'
      lines.push(
        `| ${i + 1} | ${formatDate(commit.date)} | ${commit.type} | ${commit.message} | ${suggest} | ${actionLabel(commit.action)} | ${refText} |`,
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
  const commit = daily.commits.find(c => c.sha === sha || c.sha.startsWith(sha))

  if (!commit) {
    return `Error: Commit "${sha}" not found in daily data for ${upOwner}/${upName}.`
  }

  store.updateDailyCommit(`${upOwner}/${upName}`, commit.sha, {
    action: action as DailyCommitAction,
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
