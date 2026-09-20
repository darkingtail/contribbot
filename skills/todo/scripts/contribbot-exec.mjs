import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function resolveSourceExecution(launcher = fileURLToPath(import.meta.url)) {
  const realLauncher = fs.realpathSync(launcher)
  const repo = path.resolve(path.dirname(realLauncher), '../../..')
  const packagePath = path.join(repo, 'packages/mcp/package.json')
  try {
    const rootPackage = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
    const mcpPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
    if (rootPackage.name !== 'contribbot' || mcpPackage.name !== 'contribbot-mcp') throw new Error('Package mismatch')
  }
  catch {
    throw new Error('Execution helper is not inside a contribbot source checkout. Use a source-linked todo Skill for development, or an explicitly installed compatible published CLI. No fallback was executed.')
  }
  const entry = path.join(repo, 'packages/mcp/src/cli/execution.ts')
  const tsconfig = path.join(repo, 'packages/mcp/tsconfig.json')
  for (const [label, file] of [['source entry', entry], ['source tsconfig', tsconfig]]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`Missing execution ${label}: ${file}. Restore the current checkout; dist is never used.`)
    }
  }
  let api
  try {
    if (!fs.statSync(path.join(repo, 'packages/mcp/node_modules/tsx/package.json')).isFile()) throw new Error('Missing local tsx')
    api = createRequire(packagePath).resolve('tsx/esm/api')
  }
  catch {
    throw new Error(`Execution helper dependencies unavailable in ${repo}. Run pnpm install in that checkout. No dist, PATH or network fallback was executed.`)
  }
  return { mode: 'source', repo, launcher: realLauncher, entry, tsconfig, api }
}

async function main() {
  try {
    const runtime = resolveSourceExecution()
    // Keep the same process, cwd, stdin and literal arguments as the execution CLI.
    const { register } = await import(pathToFileURL(runtime.api).href)
    register({ tsconfig: runtime.tsconfig })
    process.argv[1] = runtime.entry
    await import(pathToFileURL(runtime.entry).href)
  }
  catch (error) {
    console.log(JSON.stringify({
      schema_version: 1,
      error: { code: 'dev_execution_unavailable', message: error instanceof Error ? error.message : String(error) },
    }))
    process.exitCode = 1
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  await main()
}
