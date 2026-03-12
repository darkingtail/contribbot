import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export function getGitHubToken(): string | undefined {
  return process.env.GITHUB_TOKEN
}

export function getProjectRoot(override?: string): string {
  if (override) {
    return resolve(override)
  }

  // Walk up from cwd to find monorepo root (has pnpm-workspace.yaml)
  let dir = process.cwd()
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir
    }
    dir = dirname(dir)
  }

  return process.cwd()
}

const SAFE_SEGMENT = /^[\w][\w.\-]*$/

export function validatePathSegment(segment: string): string {
  const trimmed = segment.trim()
  if (!trimmed || !SAFE_SEGMENT.test(trimmed)) {
    throw new Error(`Invalid path segment: "${segment}"`)
  }
  return trimmed
}

export function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contribbot', validatePathSegment(owner), validatePathSegment(name))
}
