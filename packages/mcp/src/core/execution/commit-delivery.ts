import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { captureCandidate, readCandidateFile } from './candidate.js'
import type { Candidate, CandidateFile } from './candidate.js'
import { attributeFingerprints, attributeTarget, captureAttributeSources, quoteGitPath } from './git-attributes.js'
import type { AttributeSource } from './git-attributes.js'

const attributes = ['text', 'eol', 'crlf', 'ident', 'working-tree-encoding', 'filter'] as const
type Attributes = Record<typeof attributes[number], string>
type FileObservation = {
  path: string; blob_oid: string | null
  comparison: 'raw' | 'builtin' | 'different' | 'unsupported'
  note: string; attributes?: Attributes
}
export interface CommitObservation {
  endpoint: 'present' | 'missing' | 'not_observed'
  note: string
  commit: {
    oid: string; tree: string | null; source: 'local_git'; observed_at: string
    git_version: string | null; files: FileObservation[]
    config: Record<string, string>; filter_drivers: string[]; limitations: string[]
    attribute_sources: ReturnType<typeof attributeFingerprints>
  }
}

function environment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
  }
}

function git(root: string, args: string[], input?: string, env = environment(), absentConfig = false): string {
  const result = spawnSync(process.platform === 'win32' ? 'git.exe' : 'git', [
    '--no-optional-locks', '--no-lazy-fetch', '--no-replace-objects',
    '-c', 'core.fsmonitor=false', ...args,
  ], { cwd: root, env, input, windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
  if (absentConfig && result.status === 1 && !result.error && !result.stderr?.length) return ''
  if (result.error || result.status !== 0 || result.signal || result.stderr?.length || !result.stdout) {
    // Do not reflect Git stderr: config errors can contain credentials or private remote URLs.
    throw new Error(`Read-only Git ${args[0]} failed or exceeded its limits; no delivery conclusion is available.`)
  }
  const bytes = result.stdout
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Non-UTF-8 Git output is not supported.')
  return text
}

function config(root: string): Record<string, string> {
  const get = (key: string, fallback: string, bool = false) =>
    git(root, ['config', ...(bool ? ['--type=bool'] : []), '--get', key], undefined, environment(), true).trim() || fallback
  const values = {
    'core.autocrlf': get('core.autocrlf', 'false').toLowerCase(),
    'core.eol': get('core.eol', 'native').toLowerCase(),
    'core.filemode': get('core.filemode', 'true', true),
    'core.checkroundtripencoding': get('core.checkroundtripencoding', 'SHIFT-JIS'),
  }
  if (!['true', 'false', 'input'].includes(values['core.autocrlf'])
    || !['lf', 'crlf', 'native'].includes(values['core.eol'])
    || !/^[a-zA-Z0-9_,. -]{1,1024}$/.test(values['core.checkroundtripencoding'])) {
    throw new Error('Unsupported builtin Git conversion configuration.')
  }
  return values
}

function readAttributes(root: string, paths: string[], env?: NodeJS.ProcessEnv, options: string[] = []): Map<string, Attributes> {
  const values = git(root, [...options, 'check-attr', '-z', '--stdin', ...attributes], `${paths.join('\0')}\0`, env).split('\0')
  if (values.pop() !== '' || values.length !== paths.length * attributes.length * 3) {
    throw new Error('Incomplete effective Git attributes.')
  }
  const result = new Map(paths.map(path => [path, {} as Attributes]))
  for (let index = 0; index < values.length; index += 3) {
    const [path, name, value] = values.slice(index, index + 3) as [string, typeof attributes[number], string]
    const item = result.get(path)
    if (!item || !attributes.includes(name) || Object.hasOwn(item, name)) throw new Error('Unexpected Git attribute entry.')
    item[name] = value
  }
  return result
}

function filterDrivers(root: string): string[] {
  const keys = git(root, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'],
    undefined, environment(), true).split('\0').filter(Boolean)
  return [...new Set(keys.map(key => {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/s.exec(key)
    if (!match) throw new Error('Unexpected filter configuration key.')
    return match[1]!
  }))].sort()
}

/** Normalize only captured bytes in private metadata, never using source filters/config/index. */
function normalize(
  files: { file: CandidateFile; bytes: Buffer; attrs: Attributes }[], settings: Record<string, string>, format: string,
  sources: AttributeSource[],
): string[] {
  const parent = realpathSync(tmpdir())
  const scratch = mkdtempSync(join(parent, 'contribbot-commit-normalize-'))
  try {
    const home = join(scratch, 'home')
    const work = join(scratch, 'work')
    mkdirSync(home)
    mkdirSync(work)
    const env: NodeJS.ProcessEnv = {
      ...environment(), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'empty-config'), GIT_ATTR_NOSYSTEM: '1',
    }
    writeFileSync(env.GIT_CONFIG_GLOBAL!, '')
    git(work, ['init', '--quiet', '--template=', '--initial-branch=observation', `--object-format=${format}`], undefined, env)
    const names = files.map(item => item.file.path)
    for (const item of files) {
      const path = attributeTarget(work, item.file.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, item.bytes)
    }
    for (const source of sources.filter(source => source.role === 'worktree' && source.bytes !== null)) {
      const path = attributeTarget(work, source.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, source.bytes!)
    }
    const global = join(home, 'attributes')
    const lowPriority = sources.filter(source => source.role === 'system' || source.role === 'global')
    // Each original file has its own BOM handling and final-line boundary.
    writeFileSync(global, Buffer.concat(lowPriority.flatMap(source => {
      const bytes = source.bytes ?? Buffer.alloc(0)
      const start = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0
      return [bytes.subarray(start), Buffer.from('\n')]
    })))
    const info = sources.find(source => source.role === 'info')!
    if (info.bytes !== null) {
      mkdirSync(join(work, '.git/info'), { recursive: true })
      writeFileSync(join(work, '.git/info/attributes'), info.bytes)
    }
    const options = [...Object.entries(settings).flatMap(([key, value]) => ['-c', `${key}=${value}`]),
      '-c', `core.attributesFile=${global}`]
    const recreated = readAttributes(work, names, env, options)
    if (files.some(item => JSON.stringify(item.attrs) !== JSON.stringify(recreated.get(item.file.path)))) {
      throw new Error('Isolated attributes do not reproduce the source observation.')
    }
    const output = git(work, [...options, 'hash-object', '--stdin-paths'], names.map(quoteGitPath).join('\n') + '\n', env).trim().split(/\r?\n/)
    const oid = format === 'sha256' ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/
    if (output.length !== files.length || output.some(value => !oid.test(value))) throw new Error('Incomplete builtin conversion observation.')
    return output
  }
  finally {
    const path = resolve(scratch)
    const rel = relative(parent, path)
    if (!rel.startsWith('contribbot-commit-normalize-') || rel.includes(sep) || realpathSync(path) !== path) {
      throw new Error('Unsafe temporary observation cleanup path.')
    }
    rmSync(path, { recursive: true, force: true })
  }
}

function observe(candidate: Candidate, scope: string[]): CommitObservation {
  const commit: CommitObservation['commit'] = {
    oid: candidate.head, tree: null, source: 'local_git', observed_at: new Date().toISOString(),
    git_version: null, files: [], config: {}, filter_drivers: [], attribute_sources: [],
    limitations: ['Ignored untracked files are outside the candidate and are not verified.', 'No remote publication or PR status is observed.'],
  }
  try {
    const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
    if (!oid.test(candidate.head)) throw new Error('Unsupported captured commit identity.')
    const root = candidate.root
    commit.git_version = git(root, ['--version']).trim()
    commit.tree = git(root, ['rev-parse', '--verify', `${candidate.head}^{tree}`]).trim()
    if (!oid.test(commit.tree)) throw new Error('Invalid captured commit tree.')
    const tree = new Map<string, { mode: string; oid: string }>()
    const inside = (path: string) => scope.some(parent => parent === '.' || path === parent || path.startsWith(`${parent}/`))
    const entries = git(root, ['ls-tree', '-r', '-z', '--full-tree', commit.tree]).split('\0')
    if (entries.pop() !== '') throw new Error('Incomplete commit tree observation.')
    if (entries.length > 50_000) throw new Error('Commit tree file count limit exceeded.')
    for (const entry of entries) {
      const tab = entry.indexOf('\t')
      const match = /^(\d{6}) (\w+) ([a-f0-9]+)$/.exec(entry.slice(0, tab))
      if (tab < 0 || !match || !oid.test(match[3]!)) throw new Error('Unsupported commit tree entry.')
      const path = entry.slice(tab + 1)
      if (!inside(path)) continue
      if (match[2] !== 'blob' || !['100644', '100755'].includes(match[1]!)) throw new Error('Non-regular commit delivery paths are unsupported.')
      tree.set(path, { mode: match[1]!, oid: match[3]! })
    }
    commit.config = config(root)
    const files = new Map(candidate.files.filter(file => inside(file.path)).map(file => [file.path, file]))
    const observations = new Map<string, FileObservation>()
    const conversions: { file: CandidateFile; bytes: Buffer; attrs: Attributes }[] = []
    let total = 0
    for (const path of new Set([...tree.keys(), ...files.keys()])) {
      const entry = tree.get(path)
      const file = files.get(path)
      const row: FileObservation = { path, blob_oid: entry?.oid ?? null, comparison: 'different', note: '' }
      commit.files.push(row)
      observations.set(path, row)
      if (!entry || !file?.digest) row.note = 'Captured file set differs from the commit (including untracked files or uncommitted deletion).'
      else if (file.index_oid !== entry.oid || file.index_mode !== entry.mode) row.note = 'Captured index differs from the commit.'
      else if (commit.config['core.filemode'] === 'true' && file.executable !== (entry.mode === '100755')) row.note = 'Captured executable mode differs from the commit.'
      else {
        const bytes = readCandidateFile(candidate, file, 64 * 1024 * 1024)
        total += bytes.length
        if (total > 256 * 1024 * 1024) throw new Error('Commit delivery byte limit exceeded.')
        const hash = createHash(candidate.head.length === 64 ? 'sha256' : 'sha1')
          .update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
        if (hash === entry.oid) {
          row.comparison = 'raw'
          row.note = 'Captured bytes match the committed blob.'
        }
        else conversions.push({ file, bytes, attrs: {} as Attributes })
      }
    }
    if (conversions.length) {
      const paths = conversions.map(item => item.file.path)
      const before = readAttributes(root, paths)
      commit.filter_drivers = filterDrivers(root)
      const supported = conversions.filter(item => {
        item.attrs = before.get(item.file.path)!
        const row = observations.get(item.file.path)!
        row.attributes = item.attrs
        if (!['unspecified', 'unset'].includes(item.attrs.filter) || commit.filter_drivers.includes(item.attrs.filter)) {
          row.comparison = 'unsupported'
          row.note = 'Raw bytes differ and a custom filter is configured. No filter was executed; use a separately confirmed manual/review delivery plan.'
          return false
        }
        return true
      })
      if (supported.length) {
        const sources = captureAttributeSources(candidate, paths, args => git(root, args))
        commit.attribute_sources = attributeFingerprints(sources)
        const hashes = normalize(supported, commit.config, candidate.head.length === 64 ? 'sha256' : 'sha1', sources)
        supported.forEach((item, index) => {
          const row = observations.get(item.file.path)!
          row.comparison = hashes[index] === row.blob_oid ? 'builtin' : 'different'
          row.note = row.comparison === 'builtin'
            ? 'Captured content matches the committed blob under the observed builtin Git conversion.'
            : 'Captured content differs from the commit, including after builtin Git conversion.'
        })
        const latest = captureAttributeSources(candidate, paths, args => git(root, args))
        if (JSON.stringify(commit.attribute_sources) !== JSON.stringify(attributeFingerprints(latest))) {
          throw new Error('Raw Git attribute sources changed during delivery observation.')
        }
      }
      if (JSON.stringify([...before]) !== JSON.stringify([...readAttributes(root, paths)])) throw new Error('Git attributes changed during delivery observation.')
      if (JSON.stringify(commit.filter_drivers) !== JSON.stringify(filterDrivers(root))) throw new Error('Git filter configuration changed during delivery observation.')
    }
    if (JSON.stringify(commit.config) !== JSON.stringify(config(root))) throw new Error('Git configuration changed during delivery observation.')
    const endpoint = commit.files.some(row => row.comparison === 'different') ? 'missing'
      : commit.files.some(row => row.comparison === 'unsupported') ? 'not_observed' : 'present'
    return {
      endpoint, commit,
      note: endpoint === 'present' ? 'Captured scoped content and index match this local commit; acceptance and remote publication are separate.'
        : endpoint === 'missing' ? 'Declared commit scope contains uncommitted differences. Commit the intended scope or revise and reconfirm the plan.'
          : 'Tool limitation: commit delivery could not be verified without executing a custom filter. This is not evidence of absence.',
    }
  }
  catch (error) {
    return { endpoint: 'not_observed', commit, note: error instanceof Error ? error.message : String(error) }
  }
}

/** A commit target covers the captured worktree AND index, not just a clean status flag. */
export function observeCommitDelivery(candidate: Candidate, scope: string[]): CommitObservation {
  const result = observe(candidate, scope)
  // Drift invalidates all acceptance, including when this delivery item is optional.
  if (captureCandidate(candidate.root).digest !== candidate.digest) {
    throw new Error('Candidate changed during commit delivery observation; yield again.')
  }
  return result
}
