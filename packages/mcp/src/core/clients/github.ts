import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { validatePathSegment } from '../utils/config.js'

const execFileAsync = promisify(execFile)

// Auth mode: 'gh-cli' uses local `gh` auth, 'token' uses GITHUB_TOKEN env var
function getAuthMode(): 'gh-cli' | 'token' {
  return process.env.GITHUB_TOKEN ? 'token' : 'gh-cli'
}

// --- gh CLI backend ---

async function ghApiCli<T>(path: string, params: Record<string, string | number> = {}, extraArgs: string[] = [], method?: string, body?: Record<string, unknown>): Promise<T> {
  const searchParams = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  )
  const url = searchParams.toString() ? `${path}?${searchParams}` : path
  const args = ['api', url]
  if (method) args.push('--method', method)
  if (body) args.push('--input', '-')
  args.push(...extraArgs)

  if (body) {
    return new Promise<T>((resolve, reject) => {
      const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('gh command timed out after 30s'))
      }, 30_000)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(new Error(`gh exited with code ${code}: ${stderr}`))
          return
        }
        if (!stdout.trim()) {
          resolve(null as T)
          return
        }
        try {
          resolve(JSON.parse(stdout) as T)
        }
        catch {
          reject(new Error(`Failed to parse gh output: ${stdout}`))
        }
      })
      child.stdin.write(JSON.stringify(body))
      child.stdin.end()
    })
  }

  const { stdout } = await execFileAsync('gh', args, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })
  if (!stdout.trim()) return null as T
  return JSON.parse(stdout) as T
}

// --- Token (fetch) backend ---

async function ghApiToken<T>(path: string, params: Record<string, string | number> = {}, extraHeaders: Record<string, string> = {}, method: string = 'GET', body?: Record<string, unknown>): Promise<T> {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN environment variable is required for token auth mode')
  const searchParams = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  )
  const url = `https://api.github.com${path}${searchParams.toString() ? `?${searchParams}` : ''}`
  const headers: Record<string, string> = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'contribbot',
    ...extraHeaders,
  }
  const fetchOpts: RequestInit = { method, headers }
  if (body) {
    headers['Content-Type'] = 'application/json'
    fetchOpts.body = JSON.stringify(body)
  }
  const res = await fetch(url, { ...fetchOpts, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub API error ${res.status}: ${text}`)
  }
  if (res.status === 204) return null as T
  return res.json() as Promise<T>
}

// --- Unified dispatcher ---

export async function ghApi<T>(path: string, params: Record<string, string | number> = {}, extra: { args?: string[], headers?: Record<string, string>, method?: string, body?: Record<string, unknown> } = {}): Promise<T> {
  if (getAuthMode() === 'token') {
    return ghApiToken<T>(path, params, extra.headers, extra.method, extra.body)
  }
  return ghApiCli<T>(path, params, extra.args ?? [], extra.method, extra.body)
}

// --- Exported helpers ---

export function parseRepo(repo?: string): { owner: string, name: string } {
  if (!repo) throw new Error('repo is required. Pass owner/name.')
  const parts = repo.split('/')
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { owner: validatePathSegment(parts[0]), name: validatePathSegment(parts[1]) }
  }
  throw new Error('repo is required. Pass owner/name.')
}

// GitHub REST API response types (minimal)
export interface GitHubIssue {
  number: number
  title: string
  state: string
  user: { login: string } | null
  labels: Array<{ name: string } | string>
  pull_request?: unknown
  created_at: string
  updated_at: string
  body: string | null
  assignees: Array<{ login: string }>
  milestone: { title: string } | null
  html_url: string
}

export interface GitHubPull {
  number: number
  title: string
  state: string
  merged: boolean
  draft: boolean
  user: { login: string } | null
  labels: Array<{ name: string }>
  created_at: string
  updated_at: string
  head: { ref: string, sha: string }
  base: { ref: string }
  additions: number
  deletions: number
  requested_reviewers: Array<{ login: string }>
}

interface GitHubCommit {
  sha: string
  author: { login: string } | null
  commit: {
    message: string
    author: { name: string, date: string } | null
  }
}

export interface GitHubRelease {
  tag_name: string
  html_url: string
  body: string | null
  published_at: string | null
}

export interface GitHubComment {
  id: number
  user: { login: string } | null
  body: string
  created_at: string
  html_url?: string
}

interface GitHubPullFile {
  filename: string
  status: string
  additions: number
  deletions: number
}

interface GitHubReview {
  user: { login: string } | null
  state: string
  submitted_at: string | null
}

interface GitHubCheckRuns {
  check_runs: Array<{
    name: string
    status: string
    conclusion: string | null
  }>
}

interface GitHubSearchCommits {
  items: Array<{ sha: string }>
}

export async function getRepoIssues(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open', perPage = 30): Promise<GitHubIssue[]> {
  const data = await ghApi<GitHubIssue[] | null>(`/repos/${owner}/${repo}/issues`, { state, per_page: perPage })
  return (data ?? []).filter(issue => !issue.pull_request)
}

export async function getRepoPulls(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open', perPage = 30): Promise<GitHubPull[]> {
  return (await ghApi<GitHubPull[] | null>(`/repos/${owner}/${repo}/pulls`, { state, per_page: perPage })) ?? []
}

export async function getRepoCommits(owner: string, repo: string, perPage = 10): Promise<GitHubCommit[]> {
  return (await ghApi<GitHubCommit[] | null>(`/repos/${owner}/${repo}/commits`, { per_page: perPage })) ?? []
}

export async function getLatestRelease(owner: string, repo: string): Promise<GitHubRelease | null> {
  try {
    return await ghApi<GitHubRelease>(`/repos/${owner}/${repo}/releases/latest`)
  }
  catch {
    return null
  }
}

export async function getReleaseByTag(owner: string, repo: string, tag: string): Promise<GitHubRelease | null> {
  try {
    return await ghApi<GitHubRelease>(`/repos/${owner}/${repo}/releases/tags/${tag}`)
  }
  catch {
    return null
  }
}

export interface CompareResult {
  commits: Array<{
    sha: string
    commit: { message: string, author: { name: string, date: string } | null }
    author: { login: string } | null
  }>
  total_commits: number
}

export async function getCompareCommits(
  owner: string, repo: string, base: string, head: string = 'HEAD',
): Promise<CompareResult> {
  const data = await ghApi<CompareResult | null>(
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  )
  return data ?? { commits: [], total_commits: 0 }
}

export async function listReleases(
  owner: string, repo: string, perPage = 20,
): Promise<GitHubRelease[]> {
  return (await ghApi<GitHubRelease[] | null>(`/repos/${owner}/${repo}/releases`, { per_page: perPage })) ?? []
}

export async function listTags(
  owner: string, repo: string, perPage = 20,
): Promise<Array<{ name: string }>> {
  return (await ghApi<Array<{ name: string }> | null>(`/repos/${owner}/${repo}/tags`, { per_page: perPage })) ?? []
}

export async function getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue> {
  return ghApi<GitHubIssue>(`/repos/${owner}/${repo}/issues/${issueNumber}`)
}

export async function getIssueComments(owner: string, repo: string, issueNumber: number): Promise<GitHubComment[]> {
  return (await ghApi<GitHubComment[] | null>(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`)) ?? []
}

export async function getIssueTimeline(owner: string, repo: string, issueNumber: number): Promise<unknown[]> {
  return (await ghApi<unknown[] | null>(`/repos/${owner}/${repo}/issues/${issueNumber}/timeline`)) ?? []
}

export async function getPull(owner: string, repo: string, pullNumber: number): Promise<GitHubPull> {
  return ghApi<GitHubPull>(`/repos/${owner}/${repo}/pulls/${pullNumber}`)
}

export async function getPullFiles(owner: string, repo: string, pullNumber: number): Promise<GitHubPullFile[]> {
  return (await ghApi<GitHubPullFile[] | null>(`/repos/${owner}/${repo}/pulls/${pullNumber}/files`)) ?? []
}

export async function getPullReviews(owner: string, repo: string, pullNumber: number): Promise<GitHubReview[]> {
  return (await ghApi<GitHubReview[] | null>(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`)) ?? []
}

export async function getPullChecks(owner: string, repo: string, ref: string): Promise<GitHubCheckRuns> {
  return ghApi<GitHubCheckRuns>(`/repos/${owner}/${repo}/commits/${ref}/check-runs`)
}

export async function searchCommits(owner: string, repo: string, query: string, perPage = 30, branch?: string): Promise<Array<{ sha: string }>> {
  try {
    const branchQ = branch ? ` branch:${branch}` : ''
    const data = await ghApi<GitHubSearchCommits>(
      `/search/commits`,
      { q: `${query} repo:${owner}/${repo}${branchQ}`, per_page: perPage },
      {
        args: ['-H', 'Accept: application/vnd.github.cloak-preview+json'],
        headers: { Accept: 'application/vnd.github.cloak-preview+json' },
      },
    )
    return data.items
  }
  catch {
    return []
  }
}

interface GitHubSearchIssuesResult {
  total_count: number
  items: Array<{
    number: number
    title: string
    state: string
    html_url: string
    created_at: string
    updated_at: string
    pull_request?: unknown
    labels: Array<{ name: string }>
    assignees: Array<{ login: string }>
    user: { login: string } | null
  }>
}

export async function searchIssues(query: string, perPage = 30): Promise<GitHubSearchIssuesResult['items']> {
  try {
    const data = await ghApi<GitHubSearchIssuesResult>(
      `/search/issues`,
      { q: query, per_page: perPage, sort: 'updated' },
    )
    return data.items
  }
  catch {
    return []
  }
}

export async function getCurrentUser(): Promise<{ login: string, name: string | null } | null> {
  try {
    return await ghApi<{ login: string, name: string | null }>('/user')
  }
  catch {
    return null
  }
}

export async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  if (getAuthMode() === 'token') {
    const token = process.env.GITHUB_TOKEN
    if (!token) throw new Error('GITHUB_TOKEN environment variable is required for token auth mode')
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'contribbot',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`GitHub GraphQL error ${res.status}: ${text}`)
    }
    const json = await res.json() as { data: T, errors?: unknown[] }
    if (json.errors) throw new Error(JSON.stringify(json.errors))
    return json.data
  }

  // gh CLI graphql
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [key, val] of Object.entries(variables)) {
    args.push('-F', `${key}=${val}`)
  }
  const { stdout } = await execFileAsync('gh', args, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })
  return (JSON.parse(stdout) as { data: T }).data
}

// --- Write helper types ---

export interface GitHubReviewComment {
  id: number
  pull_request_review_id: number
  user: { login: string } | null
  body: string
  path: string
  line: number | null
  side: string
  diff_hunk: string
  created_at: string
  html_url: string
}

// --- Write helpers ---

export async function createIssue(owner: string, repo: string, title: string, body?: string, labels?: string[]): Promise<GitHubIssue> {
  const payload: Record<string, unknown> = { title }
  if (body) payload.body = body
  if (labels?.length) payload.labels = labels
  return ghApi<GitHubIssue>(`/repos/${owner}/${repo}/issues`, {}, { method: 'POST', body: payload })
}

export async function closeIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue> {
  return ghApi<GitHubIssue>(`/repos/${owner}/${repo}/issues/${issueNumber}`, {}, { method: 'PATCH', body: { state: 'closed' } })
}

export async function createComment(owner: string, repo: string, issueNumber: number, body: string): Promise<GitHubComment> {
  return ghApi<GitHubComment>(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {}, { method: 'POST', body: { body } })
}

export async function createPull(owner: string, repo: string, title: string, head: string, base: string, body?: string, draft?: boolean): Promise<GitHubPull> {
  const payload: Record<string, unknown> = { title, head, base }
  if (body) payload.body = body
  if (draft !== undefined) payload.draft = draft
  return ghApi<GitHubPull>(`/repos/${owner}/${repo}/pulls`, {}, { method: 'POST', body: payload })
}

export async function updatePull(owner: string, repo: string, prNumber: number, fields: Record<string, unknown>): Promise<GitHubPull> {
  return ghApi<GitHubPull>(`/repos/${owner}/${repo}/pulls/${prNumber}`, {}, { method: 'PATCH', body: fields })
}

export async function getPullReviewComments(owner: string, repo: string, prNumber: number): Promise<GitHubReviewComment[]> {
  return (await ghApi<GitHubReviewComment[] | null>(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`, { per_page: 100 })) ?? []
}

export async function getRepoDefaultBranch(owner: string, repo: string): Promise<{ branch: string; sha: string }> {
  const data = await ghApi<{ default_branch: string }>(`/repos/${owner}/${repo}`)
  const branch = data.default_branch
  const ref = await ghApi<{ object: { sha: string } }>(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)
  return { branch, sha: ref.object.sha }
}

export async function createBranch(owner: string, repo: string, branchName: string, sha: string): Promise<void> {
  await ghApi(`/repos/${owner}/${repo}/git/refs`, {}, { method: 'POST', body: { ref: `refs/heads/${branchName}`, sha } })
}

export async function replyToReviewComment(owner: string, repo: string, prNumber: number, commentId: number, body: string): Promise<GitHubComment> {
  return ghApi<GitHubComment>(`/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`, {}, { method: 'POST', body: { body } })
}
