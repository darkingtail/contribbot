import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { ghApi, parseRepo } from '../clients/github.js'
import { getContribDir } from './config.js'

/**
 * If the given repo is a fork, resolve to its parent repo.
 * This ensures data is always stored under the upstream/parent owner.
 */
export async function resolveToParent(owner: string, name: string): Promise<{ owner: string, name: string, fork: string | null }> {
  try {
    const repo = await ghApi<{ fork: boolean, parent?: { full_name: string } }>(`/repos/${owner}/${name}`)
    if (repo.fork && repo.parent?.full_name) {
      const [parentOwner, parentName] = repo.parent.full_name.split('/')
      if (parentOwner && parentName) {
        return { owner: parentOwner, name: parentName, fork: `${owner}/${name}` }
      }
    }
  }
  catch { /* not a fork or API error */ }
  return { owner, name, fork: null }
}

// In-memory cache for resolved repos within a single process lifetime
const resolveCache = new Map<string, { owner: string, name: string }>()

/**
 * Resolve a repo string to the canonical owner/name for data storage.
 *
 * Resolution order (fast to slow):
 * 1. In-memory cache hit
 * 2. Config already exists at the given owner/name path (it IS the parent)
 * 3. Scan existing configs to find one that lists this repo as its fork
 * 4. GitHub API call to check if it's a fork and resolve to parent
 *
 * This ensures all data for a project lives in ONE directory,
 * regardless of whether the user passes their fork name or the parent name.
 */
export async function resolveRepo(repo?: string): Promise<{ owner: string, name: string }> {
  const parsed = parseRepo(repo)
  const key = `${parsed.owner}/${parsed.name}`

  // 1. In-memory cache
  const cached = resolveCache.get(key)
  if (cached) return cached

  // 2. Config already exists at this path — it's the canonical location
  const directDir = getContribDir(parsed.owner, parsed.name)
  const directConfig = join(directDir, 'config.yaml')
  if (existsSync(directConfig)) {
    resolveCache.set(key, parsed)
    return parsed
  }

  // 3. Scan existing contribbot dirs to find a parent that lists this repo as its fork
  const contribRoot = join(homedir(), '.contribbot')
  if (existsSync(contribRoot)) {
    try {
      for (const ownerEntry of readdirSync(contribRoot, { withFileTypes: true })) {
        if (!ownerEntry.isDirectory()) continue
        const ownerDir = join(contribRoot, ownerEntry.name)
        for (const repoEntry of readdirSync(ownerDir, { withFileTypes: true })) {
          if (!repoEntry.isDirectory()) continue
          const configPath = join(ownerDir, repoEntry.name, 'config.yaml')
          if (!existsSync(configPath)) continue
          try {
            const content = readFileSync(configPath, 'utf-8')
            const config = parse(content) as { fork?: string } | null
            if (config?.fork === key) {
              const resolved = { owner: ownerEntry.name, name: repoEntry.name }
              resolveCache.set(key, resolved)
              return resolved
            }
          }
          catch { /* skip malformed configs */ }
        }
      }
    }
    catch { /* ignore scan errors */ }
  }

  // 4. GitHub API call — check if this repo is a fork
  const resolved = await resolveToParent(parsed.owner, parsed.name)
  const result = { owner: resolved.owner, name: resolved.name }
  resolveCache.set(key, result)
  return result
}
