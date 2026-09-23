import fs from 'node:fs'
import path from 'node:path'
import { createRequire, register as registerModule } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

try {
  const repo = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), '..')
  const packagePath = path.join(repo, 'packages/mcp/package.json')
  if (JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).name !== 'contribbot'
    || JSON.parse(fs.readFileSync(packagePath, 'utf8')).name !== 'contribbot-mcp') {
    throw new Error('MCP bootstrap is not inside a contribbot source checkout.')
  }
  const entry = path.join(repo, 'packages/mcp/src/mcp/index.ts')
  const tsconfig = path.join(repo, 'packages/mcp/tsconfig.json')
  const hook = path.join(repo, 'scripts/source-condition.mjs')
  for (const file of [entry, tsconfig, hook, path.join(repo, 'packages/mcp/node_modules/tsx/package.json')]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`Missing development source or dependency: ${file}. Restore the checkout and run pnpm install.`)
    }
  }
  registerModule(pathToFileURL(hook))
  const api = createRequire(packagePath).resolve('tsx/esm/api')
  const { register } = await import(pathToFileURL(api).href)
  register({ tsconfig })
  process.argv[1] = entry
  await import(pathToFileURL(entry).href)
}
catch (error) {
  // stdout belongs exclusively to MCP JSON-RPC.
  console.error(`[contribbot] Source MCP startup failed; no dist fallback: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
