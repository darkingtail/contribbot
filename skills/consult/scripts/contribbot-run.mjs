import fs from 'node:fs'
import path from 'node:path'
import { createRequire, register as registerModule } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function resolveSourceRunner(launcher = fileURLToPath(import.meta.url)) {
  const realLauncher = fs.realpathSync(launcher)
  const repo = path.resolve(path.dirname(realLauncher), '../../..')
  const packagePath = path.join(repo, 'packages/runner/package.json')
  try {
    const rootPackage = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
    const runnerPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
    if (rootPackage.name !== 'contribbot' || runnerPackage.name !== 'contribbot-runner') throw new Error('Package mismatch')
  }
  catch {
    throw new Error('Runner helper is not inside a contribbot source checkout. Use a source-linked Consult Skill. No fallback was executed.')
  }
  const entry = path.join(repo, 'packages/runner/src/cli.ts')
  const tsconfig = path.join(repo, 'packages/runner/tsconfig.json')
  const sourceHook = path.join(repo, 'scripts/source-condition.mjs')
  for (const [label, file] of [['source entry', entry], ['source tsconfig', tsconfig], ['source resolver', sourceHook]]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`Missing Runner ${label}: ${file}. Restore the current checkout; dist is never used.`)
    }
  }
  let api
  try {
    if (!fs.statSync(path.join(repo, 'packages/runner/node_modules/tsx/package.json')).isFile()) throw new Error('Missing local tsx')
    api = createRequire(packagePath).resolve('tsx/esm/api')
  }
  catch {
    throw new Error(`Runner helper dependencies unavailable in ${repo}. Run pnpm install in that checkout. No dist, PATH or network fallback was executed.`)
  }
  return { mode: 'source', repo, launcher: realLauncher, entry, tsconfig, api, sourceHook }
}

async function main() {
  try {
    const runtime = resolveSourceRunner()
    registerModule(pathToFileURL(runtime.sourceHook))
    const { register } = await import(pathToFileURL(runtime.api).href)
    register({ tsconfig: runtime.tsconfig })
    process.argv[1] = runtime.entry
    await import(pathToFileURL(runtime.entry).href)
  }
  catch (error) {
    console.log(JSON.stringify({
      schema_version: 1,
      error: { code: 'dev_runner_unavailable', message: error instanceof Error ? error.message : String(error) },
    }))
    process.exitCode = 1
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  await main()
}
