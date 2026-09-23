import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function workerCommand(): { executable: string; argv: string[] } {
  const worker = fileURLToPath(import.meta.resolve('contribbot-runner/worker'))
  if (worker.endsWith('.ts')) {
    const tsx = createRequire(import.meta.url).resolve('tsx')
    return {
      executable: process.execPath,
      argv: ['--conditions=contribbot-source', '--import', pathToFileURL(tsx).href, worker],
    }
  }
  return { executable: process.execPath, argv: [worker] }
}

/** Launch one exact turn; no queue scan and no shell wrapper. */
export async function launchConsultWorker(directory: string, discussionId: string, turnId: string): Promise<void> {
  const worker = workerCommand()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(worker.executable, [...worker.argv, directory, discussionId, turnId], {
      detached: true, windowsHide: true, stdio: 'ignore', shell: false,
    })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
