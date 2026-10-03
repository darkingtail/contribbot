import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RepoConfig } from '../../storage/repo-config.js'
import { resolveRepo, resolveRepoIdentity } from '../../utils/resolve-repo.js'
import { assertForkSyncAccess } from '../../utils/repository-access.js'
import type { RepositoryInput } from '../../utils/repository-ref.js'

const execFileAsync = promisify(execFile)

/**
 * Sync fork's default branch with upstream using `gh repo sync`.
 * The managed repository is the sync destination; the parent is verified at call time.
 */
export async function syncFork(repo: RepositoryInput, branch?: string): Promise<string> {
  const { repository } = await resolveRepoIdentity(repo)
  if (repository.platform !== 'github' || repository.instance !== 'https://github.com') {
    throw new Error('sync_fork supports GitHub.com repositories only; no remote changes were attempted.')
  }
  const { directory } = await resolveRepo(repository)
  const config = new RepoConfig(directory).load()
  if (!config) throw new Error('Project is not initialized. Use project_init first.')

  if (config.parent.status === 'unknown') {
    throw new Error(`Parent relationship is unknown for ${repository.path}; refresh and verify it before sync_fork. No remote changes were attempted.`)
  }
  if (config.parent.status === 'none') {
    return `Confirmed no parent for **${repository.path}**. Nothing to sync.`
  }
  await assertForkSyncAccess(config)

  const args = ['repo', 'sync', repository.path]
  if (branch) {
    args.push('--branch', branch)
  }

  try {
    const { stdout, stderr } = await execFileAsync('gh', args)
    const output = (stdout || stderr || '').trim()

    const msg = `Synced **${repository.path}** ← ${config.parent.repository.path}${branch ? ` (branch: ${branch})` : ''}`
    return output ? `${msg}\n\n${output}` : msg
  }
  catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Failed to sync ${repository.path}: ${msg}`
  }
}
