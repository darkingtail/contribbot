import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseRepo, getRepoCommits, searchIssues } from '../clients/github.js'
import { UpstreamStore } from '../storage/upstream-store.js'

function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contrib', owner, name)
}

function parseCommitType(message: string): string {
  const firstLine = message.split('\n')[0]
  const match = firstLine.match(/^(\w+)[\s(:]/)
  if (!match) return 'chore'
  const prefix = match[1].toLowerCase()
  const known = ['feat', 'fix', 'refactor', 'docs', 'style', 'perf', 'test', 'build', 'ci', 'chore', 'revert']
  return known.includes(prefix) ? prefix : 'chore'
}

function extractSubject(message: string): string {
  const firstLine = message.split('\n')[0]
  // Remove conventional commit prefix like "feat(scope): " or "fix: "
  return firstLine.replace(/^\w+(\([^)]*\))?\s*:\s*/, '').trim()
}

function extractSearchKeywords(message: string): string | null {
  const subject = extractSubject(message)
  if (!subject) return null

  // Try to extract component/scope name from conventional commit
  const firstLine = message.split('\n')[0]
  const scopeMatch = firstLine.match(/^\w+\(([^)]+)\)/)
  if (scopeMatch) {
    return scopeMatch[1]
  }

  // Take first few significant words from subject
  const words = subject
    .split(/[\s:,]+/)
    .filter(w => w.length > 2)
    .slice(0, 3)

  return words.length > 0 ? words.join(' ') : null
}

function actionLabel(action: string | null): string {
  if (!action) return '—'
  return action
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${month}-${day}`
}

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

  // Calculate perPage from days (roughly 5 commits/day, max 100)
  const perPage = Math.min(effectiveDays * 5, 100)

  // Fetch recent commits from upstream
  const commits = await getRepoCommits(upOwner, upName, perPage)

  // Filter by date
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - effectiveDays)

  const recentCommits = commits.filter((c) => {
    const commitDate = c.commit.author?.date
    if (!commitDate) return false
    return new Date(commitDate) >= cutoffDate
  })

  // Deduplicate against existing daily commits
  const existingDaily = store.getDaily(`${upOwner}/${upName}`)
  const existingShas = new Set(existingDaily.commits.map(c => c.sha))
  const newCommits = recentCommits.filter(c => !existingShas.has(c.sha))

  // For new commits, try auto-detection of related issues/PRs in target repo
  interface NewCommitEntry {
    sha: string
    message: string
    type: string
    date: string
    action: 'issue' | 'pr' | null
    ref: string | null
  }

  const newEntries: NewCommitEntry[] = []

  for (const commit of newCommits) {
    const firstLine = commit.commit.message.split('\n')[0]
    const type = parseCommitType(commit.commit.message)
    const date = commit.commit.author?.date ?? new Date().toISOString()

    let action: 'issue' | 'pr' | null = null
    let ref: string | null = null

    // Best-effort: search for related issue/PR in target repo
    const keyword = extractSearchKeywords(commit.commit.message)
    if (keyword) {
      try {
        const results = await searchIssues(`${keyword} repo:${tgtOwner}/${tgtName}`, 3)
        if (results.length > 0) {
          const match = results[0]
          action = match.pull_request ? 'pr' : 'issue'
          ref = `#${match.number}`
        }
      }
      catch {
        // Ignore search failures — best-effort
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

  // Persist new commits
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

    // Update action/ref for auto-detected ones
    for (const entry of newEntries) {
      if (entry.action) {
        store.updateDailyCommit(`${upOwner}/${upName}`, entry.sha, {
          action: entry.action,
          ref: entry.ref,
        })
      }
    }
  }

  // Render output — combine existing + new
  const allDaily = store.getDaily(`${upOwner}/${upName}`)
  const allCommits = allDaily.commits

  const linkedCount = allCommits.filter(c => c.action !== null && c.action !== 'skip').length
  const pendingCount = allCommits.filter(c => c.action === null).length

  const lines: string[] = [
    `## Daily — ${upOwner}/${upName}`,
    `> 最后检查: ${allDaily.last_checked ?? '—'} · ${newEntries.length} new · ${linkedCount} 已关联 · ${pendingCount} 待处理`,
    '',
    '| # | Date | Type | Commit | Action | Ref |',
    '|---|------|------|--------|--------|-----|',
  ]

  // Show commits sorted by date descending
  const sorted = [...allCommits].sort((a, b) => b.date.localeCompare(a.date))

  sorted.forEach((commit, i) => {
    const refText = commit.ref
      ? `[${commit.ref}](https://github.com/${tgtOwner}/${tgtName}/issues/${commit.ref.replace('#', '')})`
      : '—'
    lines.push(
      `| ${i + 1} | ${formatDate(commit.date)} | ${commit.type} | ${commit.message} | ${actionLabel(commit.action)} | ${refText} |`,
    )
  })

  return lines.join('\n')
}

export function upstreamDailyAct(
  upstreamRepo: string,
  sha: string,
  action: string,
  ref?: string,
  repo?: string,
): string {
  const validActions = ['skip', 'todo', 'issue', 'pr']
  if (!validActions.includes(action)) {
    return `Error: Invalid action "${action}". Must be one of: ${validActions.join(', ')}`
  }

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
    action: action as 'skip' | 'todo' | 'issue' | 'pr',
    ref: ref ?? null,
  })

  return `Updated ${upOwner}/${upName} commit ${commit.sha.slice(0, 7)}: action → ${action}${ref ? `, ref → ${ref}` : ''}`
}
