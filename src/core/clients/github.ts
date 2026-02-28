import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DEFAULT_REPO_NAME, DEFAULT_REPO_OWNER } from '../utils/config.js'

const execFileAsync = promisify(execFile)

// Auth mode: 'gh-cli' uses local `gh` auth, 'token' uses GITHUB_TOKEN env var
function getAuthMode(): 'gh-cli' | 'token' {
  return process.env.GITHUB_TOKEN ? 'token' : 'gh-cli'
}

// --- gh CLI backend ---

async function ghApiCli<T>(path: string, params: Record<string, string | number> = {}, extraArgs: string[] = []): Promise<T> {
  const searchParams = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  )
  const url = searchParams.toString() ? `${path}?${searchParams}` : path
  const { stdout } = await execFileAsync('gh', ['api', url, ...extraArgs])
  return JSON.parse(stdout) as T
}

// --- Token (fetch) backend ---

async function ghApiToken<T>(path: string, params: Record<string, string | number> = {}, extraHeaders: Record<string, string> = {}): Promise<T> {
  const token = process.env.GITHUB_TOKEN!
  const searchParams = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  )
  const url = `https://api.github.com${path}${searchParams.toString() ? `?${searchParams}` : ''}`
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'antdv-next-agent',
      ...extraHeaders,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub API error ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// --- Unified dispatcher ---

export async function ghApi<T>(path: string, params: Record<string, string | number> = {}, extra: { args?: string[], headers?: Record<string, string> } = {}): Promise<T> {
  if (getAuthMode() === 'token') {
    return ghApiToken<T>(path, params, extra.headers)
  }
  return ghApiCli<T>(path, params, extra.args ?? [])
}

// --- Exported helpers ---

export function parseRepo(repo?: string): { owner: string, name: string } {
  if (!repo) return { owner: DEFAULT_REPO_OWNER, name: DEFAULT_REPO_NAME }
  const parts = repo.split('/')
  if (parts.length === 2) return { owner: parts[0], name: parts[1] }
  return { owner: DEFAULT_REPO_OWNER, name: repo }
}

// GitHub REST API response types (minimal)
interface GitHubIssue {
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

interface GitHubPull {
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

interface GitHubRelease {
  tag_name: string
  html_url: string
  body: string | null
  published_at: string | null
}

interface GitHubComment {
  id: number
  user: { login: string } | null
  body: string
  created_at: string
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
  const data = await ghApi<GitHubIssue[]>(`/repos/${owner}/${repo}/issues`, { state, per_page: perPage })
  return data.filter(issue => !issue.pull_request)
}

export async function getRepoPulls(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open', perPage = 30): Promise<GitHubPull[]> {
  return ghApi<GitHubPull[]>(`/repos/${owner}/${repo}/pulls`, { state, per_page: perPage })
}

export async function getRepoCommits(owner: string, repo: string, perPage = 10): Promise<GitHubCommit[]> {
  return ghApi<GitHubCommit[]>(`/repos/${owner}/${repo}/commits`, { per_page: perPage })
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

export async function getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue> {
  return ghApi<GitHubIssue>(`/repos/${owner}/${repo}/issues/${issueNumber}`)
}

export async function getIssueComments(owner: string, repo: string, issueNumber: number): Promise<GitHubComment[]> {
  return ghApi<GitHubComment[]>(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`)
}

export async function getIssueTimeline(owner: string, repo: string, issueNumber: number): Promise<unknown[]> {
  return ghApi<unknown[]>(`/repos/${owner}/${repo}/issues/${issueNumber}/timeline`)
}

export async function getPull(owner: string, repo: string, pullNumber: number): Promise<GitHubPull> {
  return ghApi<GitHubPull>(`/repos/${owner}/${repo}/pulls/${pullNumber}`)
}

export async function getPullFiles(owner: string, repo: string, pullNumber: number): Promise<GitHubPullFile[]> {
  return ghApi<GitHubPullFile[]>(`/repos/${owner}/${repo}/pulls/${pullNumber}/files`)
}

export async function getPullReviews(owner: string, repo: string, pullNumber: number): Promise<GitHubReview[]> {
  return ghApi<GitHubReview[]>(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`)
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
    const token = process.env.GITHUB_TOKEN!
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'contrib',
      },
      body: JSON.stringify({ query, variables }),
    })
    const json = await res.json() as { data: T, errors?: unknown[] }
    if (json.errors) throw new Error(JSON.stringify(json.errors))
    return json.data
  }

  // gh CLI graphql
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [key, val] of Object.entries(variables)) {
    args.push('-F', `${key}=${val}`)
  }
  const { stdout } = await execFileAsync('gh', args)
  return (JSON.parse(stdout) as { data: T }).data
}
