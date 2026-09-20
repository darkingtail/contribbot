import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const stat = (file) => {
  try { return fs.lstatSync(file) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
const identity = info => [info.dev, info.ino, info.mode]
const sameIdentity = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Home injection is for isolated tests, not a CLI path override.
export function planReset({ home = os.homedir() } = {}) {
  home = fs.realpathSync(path.resolve(home))
  if (home === path.parse(home).root) throw new Error('Refusing filesystem-root home.')
  const target = path.join(home, '.contribbot')
  const entries = []
  let files = 0
  let bytes = 0
  const root = stat(target)
  function visit(file) {
    const info = fs.lstatSync(file)
    const relative = path.relative(target, file)
    if (info.isSymbolicLink()) throw new Error(`Refusing symlink/junction: ${file}`)
    if (!info.isDirectory() && !info.isFile()) throw new Error(`Refusing special file: ${file}`)
    if (info.dev !== root.dev) throw new Error(`Refusing mounted filesystem: ${file}`)
    if (relative && path.basename(file).toLowerCase() === '.git') {
      throw new Error(`Refusing embedded Git repository/worktree: ${file}. Preserve or relocate it first.`)
    }
    if (info.isDirectory() && stat(path.join(file, 'HEAD'))?.isFile()
      && stat(path.join(file, 'objects'))?.isDirectory() && stat(path.join(file, 'refs'))?.isDirectory()) {
      throw new Error(`Refusing possible bare Git repository: ${file}. Preserve or relocate it first.`)
    }
    entries.push({
      relative, kind: info.isDirectory() ? 'directory' : 'file', identity: identity(info),
      size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs,
    })
    if (info.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name))
    }
    else { files++; bytes += info.size }
  }
  if (root) {
    if (root.isSymbolicLink()) throw new Error(`Refusing symlink/junction: ${target}`)
    if (!root.isDirectory()) throw new Error(`Expected a directory: ${target}`)
    // Resolve the exact absolute deletion boundary before any destructive operation.
    if (fs.realpathSync(target) !== target || path.dirname(target) !== home) {
      throw new Error(`Unexpected resolved target: ${target}`)
    }
    visit(target)
  }
  const signature = createHash('sha256').update(JSON.stringify({ home, target, entries })).digest('hex')
  return { home, target, exists: Boolean(root), files, bytes, entries, signature }
}

export function applyReset(plan) {
  const current = planReset({ home: plan.home })
  if (current.target !== plan.target) throw new Error('Reset target changed; refusing.')
  if (current.signature !== plan.signature) throw new Error('Data changed since preview; inspect again.')
  if (!current.exists) return { removed: false }

  const directories = new Map(current.entries.filter(e => e.kind === 'directory')
    .map(e => [e.relative, e]))
  function checkDirectory(relative) {
    const file = path.join(current.target, relative)
    const info = stat(file)
    const expected = directories.get(relative)
    if (!info?.isDirectory() || info.isSymbolicLink() || !sameIdentity(identity(info), expected?.identity)) {
      throw new Error(`Directory identity changed: ${file}`)
    }
  }
  function checkParents(relative) {
    if (fs.realpathSync(current.home) !== current.home) throw new Error('Home identity changed.')
    checkDirectory('')
    const parts = relative.split(path.sep)
    for (let i = 1; i < parts.length; i++) checkDirectory(parts.slice(0, i).join(path.sep))
  }

  try {
    // No shell commands or recursive rm: remove only inventoried files, then empty directories.
    // Unexpected additions make rmdir fail rather than being silently deleted.
    for (const entry of current.entries.filter(e => e.kind === 'file')) {
      checkParents(entry.relative)
      const file = path.join(current.target, entry.relative)
      const info = stat(file)
      if (!info?.isFile() || !sameIdentity(identity(info), entry.identity)
        || info.size !== entry.size || info.mtimeMs !== entry.mtime || info.ctimeMs !== entry.ctime) {
        throw new Error(`File changed: ${file}`)
      }
      fs.unlinkSync(file)
    }
    for (const entry of [...directories.values()].reverse()) {
      checkParents(entry.relative)
      checkDirectory(entry.relative)
      fs.rmdirSync(path.join(current.target, entry.relative))
    }
    if (stat(current.target)) throw new Error('Data directory was recreated by another process.')
  }
  catch (error) {
    throw new Error(`Reset stopped; some inventoried files may already be removed. No new backup was made. ${error.message}`, { cause: error })
  }
  return { removed: true }
}

export function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--dry-run', '--yes', '--help'])
  if (args.some(arg => !allowed.has(arg)) || (args.includes('--yes') && args.includes('--dry-run'))) {
    throw new Error('Usage: pnpm data:reset [--dry-run | --yes]. Arbitrary target paths are not accepted.')
  }
  if (args.includes('--help')) {
    console.log('pnpm data:reset: preview ~/.contribbot deletion; --yes permanently deletes it without a new backup.')
    console.log('Stop MCP, Web and patrol processes first. Existing .contribbot-backups and host configuration are preserved.')
    return
  }
  const plan = planReset()
  console.log(`Target: ${plan.target}`)
  console.log(`Files: ${plan.files}; bytes: ${plan.bytes}`)
  if (!plan.exists) { console.log('NOTHING TO RESET'); return }
  console.log('No new backup. Stop MCP, Web and patrol writers first; earlier backups do not contain newer data.')
  if (!args.includes('--yes')) {
    console.log('PREVIEW ONLY. Run pnpm data:reset --yes to permanently remove this data directory.')
    return
  }
  applyReset(plan)
  console.log(`REMOVED: ${plan.target}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
