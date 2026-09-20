import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { spawnSync } from 'node:child_process'
import { parse, stringify } from 'smol-toml'
import { parse as parseYaml } from 'yaml'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stat = (file) => {
  try { return fs.lstatSync(file) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
const read = (file) => stat(file) ? fs.readFileSync(file, 'utf8') : null

function skillName(directory) {
  const content = read(path.join(directory, 'SKILL.md'))
  const match = content?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  return match ? parseYaml(match[1])?.name : undefined
}

function linkedTo(destination, source) {
  if (!stat(destination)?.isSymbolicLink()) return false
  try { return fs.realpathSync(destination) === fs.realpathSync(source) }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function skillSnapshot(directory) {
  const info = stat(directory)
  if (!info) return null
  return JSON.stringify({
    parent: fs.realpathSync(path.dirname(directory)),
    device: info.dev, inode: info.ino, mode: info.mode, modified: info.mtimeMs,
    link: info.isSymbolicLink() ? fs.readlinkSync(directory) : null,
    content: read(path.join(directory, 'SKILL.md')),
  })
}

function prepareConfig(configPath, args, onlyExisting = false) {
  if (stat(configPath)?.isSymbolicLink()) {
    throw new Error(`Config is a symlink; update its owner explicitly: ${configPath}`)
  }
  const before = read(configPath)
  const config = before === null ? {} : parse(before)
  if (onlyExisting && !config.mcp_servers?.contribbot) {
    return { configPath, config, before, after: before, configChanged: false, managed: false }
  }
  const entry = config.mcp_servers?.contribbot || {}
  if ('url' in entry) throw new Error('contribbot is an HTTP MCP entry; refusing to replace it automatically.')
  const desired = { ...entry, command: process.execPath, args, enabled: true }
  const configChanged = !isDeepStrictEqual(entry, desired)
  const next = { ...config, mcp_servers: { ...config.mcp_servers, contribbot: desired } }
  const after = configChanged ? stringify(next) : before
  if (!isDeepStrictEqual(parse(after), next)) throw new Error('TOML round-trip changed configuration values.')
  return { configPath, config, before, after, configChanged, managed: true }
}

export function planSetup({
  repo = repository,
  home = os.homedir(),
  codexHome = process.env.CODEX_HOME || path.join(home, '.codex'),
} = {}) {
  repo = path.resolve(repo)
  codexHome = path.resolve(codexHome)
  const skillRoot = path.join(path.resolve(home), '.agents', 'skills')
  const legacyRoot = path.join(codexHome, 'skills')
  const configPath = path.join(codexHome, 'config.toml')
  const args = [
    path.join(repo, 'packages', 'mcp', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(repo, 'packages', 'mcp', 'src', 'mcp', 'index.ts'),
  ]
  for (const file of args) {
    if (!stat(file)?.isFile()) throw new Error(`Missing ${file}. Run pnpm install first.`)
  }
  const launcher = path.join(repo, 'skills/todo/scripts/contribbot-exec.mjs')
  const entry = path.join(repo, 'packages/mcp/src/cli/execution.ts')
  // Do not import the helper here: removal must work even if its source is missing.
  for (const file of [launcher, entry, path.join(repo, 'packages/mcp/tsconfig.json')]) {
    if (!stat(file)?.isFile()) throw new Error(`Missing execution helper file: ${file}. Restore the current source checkout.`)
  }
  const execution = {
    mode: 'source', launcher, entry,
    installed: path.join(skillRoot, 'contribbot-todo/scripts/contribbot-exec.mjs'),
  }
  // Validate semantic preservation before touching the user's configuration.
  const globalConfig = prepareConfig(configPath, args)
  const localPath = path.join(repo, '.codex', 'config.toml')
  const localConfig = localPath === configPath ? null : prepareConfig(localPath, args, true)
  const layers = [globalConfig, localConfig].filter(Boolean)
  const configs = layers.filter(item => item.managed)
  const { before, after, configChanged } = globalConfig

  const skills = fs.readdirSync(path.join(repo, 'skills'), { withFileTypes: true })
    .filter(item => item.isDirectory())
    .map(item => {
      const source = path.join(repo, 'skills', item.name)
      const name = skillName(source)
      if (name !== `contribbot:${item.name}`) throw new Error(`Unexpected skill identity: ${source}`)
      return { source, name, destination: path.join(skillRoot, `contribbot-${item.name}`) }
    })
  if (!skills.length) throw new Error('No source skills found.')

  const moves = new Set()
  const links = []
  for (const skill of skills) {
    if (!linkedTo(skill.destination, skill.source)) {
      if (stat(skill.destination)) {
        if (skillName(skill.destination) !== skill.name) {
          throw new Error(`Unrelated or unreadable skill at ${skill.destination}; leaving it untouched.`)
        }
        moves.add(skill.destination)
      }
      links.push(skill)
    }
  }
  // Discover copies by frontmatter identity, not generic directory names like "init".
  const known = new Map(skills.map(skill => [skill.name, skill]))
  const scannedRoots = new Set()
  for (const root of new Set([skillRoot, legacyRoot])) {
    if (!stat(root)) continue
    const physicalRoot = fs.realpathSync(root)
    if (scannedRoots.has(physicalRoot)) continue
    scannedRoots.add(physicalRoot)
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      if (item.name.startsWith('.') || (!item.isDirectory() && !item.isSymbolicLink())) continue
      const directory = path.join(root, item.name)
      let name
      try { name = skillName(directory) }
      catch { continue } // An unrelated malformed skill must not be modified.
      const skill = known.get(name)
      if (skill && directory !== skill.destination) moves.add(directory)
    }
  }
  for (const directory of moves) {
    // Moving a real source directory would destroy the very skill being installed.
    if (!stat(directory)?.isSymbolicLink()) {
      const real = fs.realpathSync(directory)
      const relative = path.relative(real, repo)
      const insideRepo = path.relative(repo, real)
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
        || (!insideRepo.startsWith('..') && !path.isAbsolute(insideRepo))) {
        throw new Error(`Refusing to move source directory: ${directory}`)
      }
    }
  }
  const warnings = []
  for (const { config, configPath: file } of layers) {
    for (const [name, plugin] of Object.entries(config.plugins || {})) {
      if (name.toLowerCase().includes('contribbot') && plugin.enabled !== false) {
        throw new Error(`Enabled contribbot plugin (${name}) in ${file} may duplicate the dev runtime. Disable it first.`)
      }
    }
    if (config.skills) warnings.push(`Existing [skills] settings in ${file} are preserved; check for disabled or separately registered contribbot skills.`)
  }
  return {
    repo, codexHome, configPath, before, after, configChanged, skills, configs, execution,
    moves: [...moves], links, warnings,
    snapshots: new Map([...moves].map(directory => [directory, skillSnapshot(directory)])),
    changed: configs.some(item => item.configChanged) || moves.size > 0 || links.length > 0,
  }
}

export function probeExecution(execution, { cwd = process.cwd(), timeout = 15_000 } = {}) {
  const child = spawnSync(process.execPath, [execution.launcher, 'check', '--schema'], {
    cwd, windowsHide: true, shell: false, encoding: 'utf8',
    input: '', timeout, maxBuffer: 1024 * 1024,
  })
  if (child.error || child.signal || child.status !== 0) {
    throw new Error(`Execution helper startup failed: ${child.error?.message || child.stderr || child.stdout || `exit ${child.status}, signal ${child.signal}`}`)
  }
  let schema
  try { schema = JSON.parse(child.stdout) }
  catch { throw new Error('Execution helper returned invalid discovery JSON.') }
  if (schema.type !== 'object' || schema['x-contribbot']?.action !== 'check'
    || schema['x-contribbot']?.validation !== 'structure-only'
    || !schema.required?.includes('acceptance_id')) {
    throw new Error('Execution helper returned an incompatible check schema.')
  }
  return schema
}

export function planRemove({
  repo = repository,
  home = os.homedir(),
  codexHome = process.env.CODEX_HOME || path.join(home, '.codex'),
} = {}) {
  repo = path.resolve(repo)
  codexHome = path.resolve(codexHome)
  const configs = []
  const warnings = []
  const expectedArgs = [
    path.join(repo, 'packages/mcp/node_modules/tsx/dist/cli.mjs'),
    path.join(repo, 'packages/mcp/src/mcp/index.ts'),
  ]
  for (const configPath of new Set([path.join(codexHome, 'config.toml'), path.join(repo, '.codex/config.toml')])) {
    if (stat(configPath)?.isSymbolicLink()) throw new Error(`Config is a symlink: ${configPath}`)
    const before = read(configPath)
    if (before === null) continue
    const config = parse(before)
    const entry = config.mcp_servers?.contribbot
    if (!entry) continue
    if (entry.url || !Array.isArray(entry.args) || entry.args.length !== 2
      || !entry.args.every((arg, index) => typeof arg === 'string' && path.isAbsolute(arg)
        && path.resolve(arg) === expectedArgs[index])) {
      warnings.push(`Preserved MCP not pointing to this checkout: ${configPath}`)
      continue
    }
    const next = { ...config, mcp_servers: { ...config.mcp_servers } }
    delete next.mcp_servers.contribbot
    if (!Object.keys(next.mcp_servers).length) delete next.mcp_servers
    const after = stringify(next)
    if (!isDeepStrictEqual(parse(after), next)) throw new Error('TOML round-trip changed configuration values.')
    configs.push({ configPath, before, after, configChanged: true })
  }
  const removals = []
  const root = path.join(path.resolve(home), '.agents/skills')
  if (stat(root)) {
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      if (!item.name.startsWith('contribbot-')) continue
      const destination = path.join(root, item.name)
      const source = path.join(repo, 'skills', item.name.slice('contribbot-'.length))
      // Read the link itself so uninstall also works after a source skill is deleted.
      if (stat(destination)?.isSymbolicLink()
        && path.resolve(path.dirname(destination), fs.readlinkSync(destination)) === source) {
        removals.push({ destination, source })
      }
      else warnings.push(`Preserved skill not linked to this checkout: ${destination}`)
    }
  }
  return {
    repo, codexHome, configs, warnings, removals, moves: [], links: [],
    snapshots: new Map(),
    removalSnapshots: new Map(removals.map(({ destination }) => {
      const info = fs.lstatSync(destination)
      return [destination, { inode: info.ino, device: info.dev, target: fs.readlinkSync(destination) }]
    })),
    changed: configs.length > 0 || removals.length > 0,
  }
}

export function applySetup(plan) {
  if (!plan.changed) return []
  fs.mkdirSync(plan.codexHome, { recursive: true })
  const lock = path.join(plan.codexHome, '.contribbot-dev-setup.lock')
  const lockFd = fs.openSync(lock, 'wx', 0o600)
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  const undo = []
  const backups = []
  const configBackups = []
  const tempFiles = new Set()
  const writeConfig = (configPath, content) => {
    const temp = `${configPath}.${id}.tmp`
    fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 })
    tempFiles.add(temp)
    fs.renameSync(temp, configPath)
    tempFiles.delete(temp)
  }
  const assertUnchanged = (directory) => {
    if (skillSnapshot(directory) !== plan.snapshots.get(directory)) {
      throw new Error(`Skill changed since planning; rerun setup: ${directory}`)
    }
  }
  try {
    for (const config of plan.configs) {
      if (read(config.configPath) !== config.before) throw new Error('Config changed since planning; rerun setup.')
    }
    for (const directory of plan.moves) assertUnchanged(directory)
    for (const config of plan.configs) {
      if (config.configChanged && config.before !== null) {
        const backup = path.join(path.dirname(config.configPath), 'contribbot-dev-backups', id, 'config.toml')
        fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 })
        fs.writeFileSync(backup, config.before, { flag: 'wx', mode: 0o600 })
        backups.push(backup)
        configBackups.push({ backup, before: config.before })
      }
    }
    for (const directory of plan.moves) {
      // Keep each backup on the same volume as the directory being renamed.
      assertUnchanged(directory)
      const physicalRoot = fs.realpathSync(path.dirname(directory))
      if (path.dirname(physicalRoot) === physicalRoot) throw new Error(`Cannot back up a skills root at a volume root: ${physicalRoot}`)
      const backup = path.join(path.dirname(physicalRoot), 'contribbot-dev-backups', id, path.basename(directory))
      fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 })
      if (stat(backup)) throw new Error(`Backup collision: ${backup}`)
      fs.renameSync(directory, backup)
      undo.push(() => {
        if (stat(directory)) throw new Error(`Recovery destination already exists: ${directory}`)
        fs.renameSync(backup, directory)
      })
      backups.push(backup)
    }
    for (const { source, destination } of plan.links) {
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
      undo.push(() => {
        if (!linkedTo(destination, source)) throw new Error(`Recovery link changed: ${destination}`)
        fs.unlinkSync(destination)
      })
      if (!linkedTo(destination, source)) throw new Error(`Link verification failed: ${destination}`)
    }
    for (const { source, destination } of plan.removals || []) {
      const info = stat(destination)
      const expected = plan.removalSnapshots.get(destination)
      if (!info?.isSymbolicLink() || info.ino !== expected.inode || info.dev !== expected.device
        || fs.readlinkSync(destination) !== expected.target) {
        throw new Error(`Removal link changed since planning: ${destination}`)
      }
      fs.unlinkSync(destination)
      undo.push(() => {
        if (stat(destination)) throw new Error(`Recovery destination already exists: ${destination}`)
        fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
      })
    }
    for (const config of plan.configs.filter(item => item.configChanged)) {
      if (read(config.configPath) !== config.before) throw new Error('Config changed during setup; refusing to overwrite it.')
      writeConfig(config.configPath, config.after)
      undo.push(() => {
        if (read(config.configPath) !== config.after) throw new Error(`Recovery config changed: ${config.configPath}`)
        if (config.before === null) fs.unlinkSync(config.configPath)
        else writeConfig(config.configPath, config.before)
      })
    }
    // Verify all postimages before treating the transaction as successful.
    for (const config of plan.configs) {
      const actual = read(config.configPath)
      if (actual !== config.after || !isDeepStrictEqual(parse(actual), parse(config.after))) {
        throw new Error(`Config verification failed: ${config.configPath}`)
      }
    }
    for (const { destination } of plan.removals || []) {
      if (stat(destination)) throw new Error(`Removal verification failed: ${destination}`)
    }
    // Cleanup is after verification. Cleanup failures do not undo a successful removal.
    if (plan.cleanupConfigBackups) {
      for (const { backup, before } of configBackups) {
        try {
          if (read(backup) !== before) throw new Error('Backup changed; preserved')
          fs.unlinkSync(backup)
          backups.splice(backups.indexOf(backup), 1)
        }
        catch { console.warn(`Removal verified; could not clean config backup: ${backup}`) }
      }
    }
    return backups
  }
  catch (error) {
    const failures = []
    for (const rollback of undo.reverse()) {
      try { rollback() }
      catch (failure) { failures.push(failure.message) }
    }
    if (failures.length) throw new AggregateError([error], `Setup failed; manual recovery needed: ${failures.join('; ')}. Backups: ${backups.join(', ')}`)
    throw error
  }
  finally {
    for (const temp of tempFiles) if (stat(temp)) fs.unlinkSync(temp)
    fs.closeSync(lockFd)
    fs.unlinkSync(lock)
  }
}

function main() {
  const flags = process.argv.slice(2)
  if (flags.some(flag => !['--check', '--dry-run', '--remove', '--keep-backups'].includes(flag))
    || new Set(flags).size !== flags.length
    || (flags.includes('--check') && flags.some(flag => flag !== '--check'))
    || (flags.includes('--keep-backups') && !flags.includes('--remove'))) {
    throw new Error('Usage: node scripts/dev-setup.mjs [--check | --dry-run | --remove [--dry-run] [--keep-backups]]')
  }
  const removing = flags.includes('--remove')
  const plan = removing ? planRemove() : planSetup()
  plan.cleanupConfigBackups = removing && !flags.includes('--keep-backups')
  console.log(`Repository: ${plan.repo}`)
  for (const config of plan.configs) console.log(`MCP: ${removing ? 'REMOVE contribbot' : config.configChanged ? 'UPDATE' : 'OK'} ${config.configPath}`)
  for (const skill of plan.skills || []) {
    console.log(`Skill: ${plan.links.includes(skill) ? 'LINK' : 'OK'} ${skill.destination} -> ${skill.source}`)
  }
  for (const directory of plan.moves) console.log(`Back up old skill: ${directory}`)
  for (const { destination } of plan.removals || []) console.log(`Unlink skill: ${destination}`)
  for (const warning of plan.warnings) console.warn(`Warning: ${warning}`)
  if (plan.execution) console.log(`Execution helper: SOURCE ${plan.execution.installed} -> ${plan.execution.entry}`)
  if (!removing && !flags.includes('--dry-run')) {
    probeExecution(plan.execution)
    console.log('Execution helper: startup/schema OK (not task acceptance or live MCP freshness).')
  }
  if (flags.includes('--check')) {
    console.log(plan.changed ? 'Out of date. Run pnpm dev:setup.' : 'MCP/Skill paths point to source; source execution helper starts successfully.')
    process.exitCode = plan.changed ? 1 : 0
    return
  }
  if (flags.includes('--dry-run')) return
  if (plan.configs.some(item => item.configChanged)) console.log('TOML formatting/comments will be normalized; original config is backed up.')
  for (const backup of applySetup(plan)) console.log(`Backup: ${backup}`)
  if (removing) {
    console.log('Removal verified. Only matching development entries and links were removed; other installs were preserved.')
    console.log(plan.cleanupConfigBackups ? 'Config backup cleanup attempted after verification; any retained paths are listed above. Historical backups are untouched.' : 'Config backups retained.')
    console.log('Restart Codex to unload the removed development runtime.')
    return
  }
  console.log('Ready. Reconnect MCP or restart Codex to load source changes in existing sessions.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
