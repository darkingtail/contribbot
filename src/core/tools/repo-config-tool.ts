import { homedir } from 'node:os'
import { join } from 'node:path'
import { ghApi, getCurrentUser, parseRepo } from '../clients/github.js'
import { RepoConfig } from '../storage/repo-config.js'
import type { RepoConfigData, RepoRole } from '../storage/repo-config.js'

function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contribbot', owner, name)
}

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

  // 2. Check permissions
  let role: RepoRole = 'external'
  try {
    const repo = await ghApi<{ permissions: { admin: boolean, push: boolean } }>(`/repos/${owner}/${name}`)
    if (repo.permissions.admin) {
      role = 'owner'
    }
    else if (repo.permissions.push) {
      role = 'collaborator'
    }
    else if (org) {
      // Check org membership
      try {
        await ghApi<unknown>(`/orgs/${org}/members/${login}`)
        role = 'org_member'
      }
      catch { /* not a member */ }
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
 */
export async function getOrInitConfig(repo?: string): Promise<{ config: RepoConfigData, owner: string, name: string }> {
  const { owner, name } = parseRepo(repo)
  const configStore = new RepoConfig(getContribDir(owner, name))

  let config = configStore.load()
  if (!config) {
    config = await detectConfig(owner, name)
    configStore.save(config)
  }

  return { config, owner, name }
}

/**
 * View or update repo config.
 */
export async function repoConfig(repo?: string, upstream?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const configStore = new RepoConfig(getContribDir(owner, name))

  // If setting upstream, update and return
  if (upstream !== undefined) {
    let config = configStore.load()
    if (!config) {
      config = await detectConfig(owner, name)
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
    '| Field | Value |',
    '|-------|-------|',
    `| role | \`${config.role}\` |`,
    `| org | ${config.org ? `\`${config.org}\`` : '—'} |`,
    `| fork | ${config.fork ? `[${config.fork}](https://github.com/${config.fork})` : '—'} |`,
    `| upstream | ${config.upstream ? `[${config.upstream}](https://github.com/${config.upstream})` : '—'} |`,
    '',
    `> Config path: \`~/.contrib/${owner}/${name}/config.yaml\``,
  ]

  return lines.join('\n')
}
