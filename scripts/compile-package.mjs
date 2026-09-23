import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
const packageIndex = args.indexOf('--package')
const modeIndex = args.indexOf('--mode')
const packageName = packageIndex >= 0 ? args[packageIndex + 1] : undefined
const mode = modeIndex >= 0 ? args[modeIndex + 1] : undefined

if (!packageName || !['typecheck', 'build'].includes(mode ?? '')) {
  throw new Error('Usage: compile-package.mjs --package <name> --mode <typecheck|build>')
}

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageDirectory = resolve(repository, 'packages', packageName)
const config = resolve(packageDirectory, mode === 'build' ? 'tsconfig.build.json' : 'tsconfig.json')
const compiler = resolve(repository, 'packages', 'mcp', 'node_modules', 'typescript', 'bin', 'tsc')
const result = spawnSync(process.execPath, [compiler, '--project', config], {
  cwd: packageDirectory,
  stdio: 'inherit',
  shell: false,
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
