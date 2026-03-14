import { ghApi, getCurrentUser, parseRepo } from '../../clients/github.js'
import { RepoConfig } from '../../storage/repo-config.js'
import type { RepoConfigData, RepoRole } from '../../storage/repo-config.js'
import { getContribDir } from '../../utils/config.js'
import { resolveToParent } from '../../utils/resolve-repo.js'

/**
 * Auto-detect repo config by querying GitHub API.
 */
async function detectConfig(owner: string, name: string): Promise<RepoConfigData> {
  const user = await getCurrentUser()
  const login = user?.login ?? 'unknown'

  // 1. Check owner type (org or user)
  let org: string | null = null
  try {
    const ownerInfo = await ghApi<{ type: string }>(`/users/${owner}`)
    if (ownerInfo.type === 'Organization') {
      org = owner
    }
  }
  catch { /* ignore */ }

  // 2. Check permissions (GitHub standard: admin > maintain > write > triage > read)
  let role: RepoRole = 'read'
  try {
    const repo = await ghApi<{ permissions: { admin: boolean, maintain: boolean, push: boolean, triage: boolean } }>(`/repos/${owner}/${name}`)
    if (repo.permissions.admin) {
      role = 'admin'
    }
    else if (repo.permissions.maintain) {
      role = 'maintain'
    }
    else if (repo.permissions.push) {
      role = 'write'
    }
    else if (repo.permissions.triage) {
      role = 'triage'
    }
  }
  catch { /* ignore */ }

  // 3. Check fork
  let fork: string | null = null
  try {
    const forkRepo = await ghApi<{ fork: boolean, parent?: { full_name: string } }>(`/repos/${login}/${name}`)
    if (forkRepo.fork && forkRepo.parent?.full_name === `${owner}/${name}`) {
      fork = `${login}/${name}`
    }
  }
  catch { /* no fork */ }

  return { role, org, fork, upstream: null }
}

/**
 * Get or initialize repo config. Auto-detects on first access.
 * If the repo is a fork, automatically resolves to parent repo.
 */
export async function getOrInitConfig(repo?: string): Promise<{ config: RepoConfigData, owner: string, name: string }> {
  const parsed = parseRepo(repo)
  const resolved = await resolveToParent(parsed.owner, parsed.name)
  const { owner, name } = resolved
  const configStore = new RepoConfig(getContribDir(owner, name))

  let config = configStore.load()
  if (!config) {
    config = await detectConfig(owner, name)
    // If we resolved from a fork, record the fork field
    if (resolved.fork) {
      config.fork = resolved.fork
    }
    configStore.save(config)
  }

  return { config, owner, name }
}

/**
 * View or update repo config.
 */
export async function repoConfig(repo?: string, upstream?: string): Promise<string> {
  const parsed = parseRepo(repo)
  const resolved = await resolveToParent(parsed.owner, parsed.name)
  const { owner, name } = resolved
  const configStore = new RepoConfig(getContribDir(owner, name))

  // If setting upstream, update and return
  if (upstream !== undefined) {
    let config = configStore.load()
    if (!config) {
      config = await detectConfig(owner, name)
      if (resolved.fork) config.fork = resolved.fork
    }
    config.upstream = upstream || null
    configStore.save(config)
    return `Updated **${owner}/${name}** upstream → \`${upstream || 'null'}\``
  }

  // View: auto-init if needed
  const { config } = await getOrInitConfig(repo)

  const lines = [
    `## Config — ${owner}/${name}`,
    '',
  ]

  if (resolved.fork) {
    lines.push(`> Resolved from fork \`${resolved.fork}\` → parent \`${owner}/${name}\``, '')
  }

  lines.push(
    '| Field | Value |',
    '|-------|-------|',
    `| role | \`${config.role}\` |`,
    `| org | ${config.org ? `\`${config.org}\`` : '—'} |`,
    `| fork | ${config.fork ? `[${config.fork}](https://github.com/${config.fork})` : '—'} |`,
    `| upstream | ${config.upstream ? `[${config.upstream}](https://github.com/${config.upstream})` : '—'} |`,
    '',
    `> Config path: \`~/.contribbot/${owner}/${name}/config.yaml\``,
  )

  return lines.join('\n')
}
