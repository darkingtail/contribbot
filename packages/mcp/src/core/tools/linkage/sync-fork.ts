import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getOrInitConfig } from '../core/repo-config-tool.js'

const execFileAsync = promisify(execFile)

/**
 * Sync fork's default branch with upstream using `gh repo sync`.
 * Reads fork from config.yaml automatically.
 */
export async function syncFork(repo?: string, branch?: string): Promise<string> {
  const { config, owner, name } = await getOrInitConfig(repo)

  if (!config.fork) {
    return `No fork configured for **${owner}/${name}**. Nothing to sync.`
  }

  const args = ['repo', 'sync', config.fork]
  if (branch) {
    args.push('--branch', branch)
  }

  try {
    const { stdout, stderr } = await execFileAsync('gh', args)
    const output = (stdout || stderr || '').trim()

    const msg = `Synced **${config.fork}** ← ${owner}/${name}${branch ? ` (branch: ${branch})` : ''}`
    return output ? `${msg}\n\n${output}` : msg
  }
  catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return `Failed to sync ${config.fork}: ${msg}`
  }
}
