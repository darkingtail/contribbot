import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { CandidateReference } from './contracts.js'

export interface CandidateFile {
  path: string
  index_mode: string | null
  index_oid: string | null
  executable: boolean
  digest: string | null
}

export interface Candidate {
  version: 1
  root: string
  git_dir: string
  common_dir: string
  head: string
  digest: string
  files: CandidateFile[]
}

export interface CandidateLimits {
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
}

export function verifyCandidateManifest(value: unknown, expected: CandidateReference): void {
  if (!value || typeof value !== 'object') throw new Error('Candidate manifest must be an object.')
  const manifest = value as Candidate
  const { digest, ...body } = manifest
  const reference = { digest, root: manifest.root, git_dir: manifest.git_dir, common_dir: manifest.common_dir }
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !isDeepStrictEqual(reference, expected)
    || createHash('sha256').update(JSON.stringify(body)).digest('hex') !== digest) {
    throw new Error('Candidate manifest does not support the recorded observation.')
  }
}

function git(root: string, args: string[]): string {
  // A caller's GIT_INDEX_FILE/GIT_DIR must not redirect inspection to another checkout.
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0',
  }
  const result = spawnSync(process.platform === 'win32' ? 'git.exe' : 'git', [
    '--no-optional-locks', '--no-lazy-fetch', '--no-replace-objects', '-c', 'core.fsmonitor=false', ...args,
  ], { cwd: root, env, windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  // ls-files may emit incomplete sparse-index output and errors with status zero.
  if (result.error || result.status !== 0 || result.signal || result.stderr?.length || !result.stdout) {
    throw new Error(`Candidate Git ${args[0]} could not read complete local metadata without side effects.`)
  }
  const bytes = result.stdout
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Unsupported non-UTF-8 Git output.')
  return text
}

function line(root: string, args: string[]): string {
  return git(root, args).replace(/\r?\n$/, '')
}

function identity(path: string): string {
  const resolved = realpathSync(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Inspect physical Git identity without scanning or hashing worktree files. */
export function inspectWorkspaceIdentity(workspace: string): Pick<Candidate, 'root' | 'git_dir' | 'common_dir'> {
  const root = identity(workspace)
  if (identity(line(root, ['rev-parse', '--show-toplevel'])) !== root) throw new Error('Workspace must be a Git repository root.')
  return {
    root,
    git_dir: identity(line(root, ['rev-parse', '--absolute-git-dir'])),
    common_dir: identity(resolve(root, line(root, ['rev-parse', '--git-common-dir']))),
  }
}

function missing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mode === b.mode && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

function validateFilePath(root: string, path: string): string | null {
  if (!path || path.includes('\0') || isAbsolute(path) || path.split('/').some(part => part === '..' || part === '.')) {
    throw new Error(`Unsafe candidate path: ${JSON.stringify(path)}`)
  }
  const absolute = resolve(root, path)
  const rel = relative(root, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Candidate path escaped workspace.')
  let current = root
  for (const segment of path.split('/')) {
    current = join(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Unsupported symbolic link or junction: ${path}`)
    }
    catch (error) {
      if (missing(error)) return null
      throw error
    }
  }
  return absolute
}

function sample(root: string, limits: Required<CandidateLimits>): Omit<Candidate, 'digest'> {
  const gitDir = identity(line(root, ['rev-parse', '--absolute-git-dir']))
  const commonDir = identity(resolve(root, line(root, ['rev-parse', '--git-common-dir'])))
  const head = line(root, ['rev-parse', '--verify', 'HEAD'])
  const entries = new Map<string, { mode: string | null; oid: string | null }>()
  for (const entry of git(root, ['ls-files', '--stage', '-z', '--full-name']).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t')
    const match = /^(\d{6}) ([a-f0-9]+) ([0-3])$/.exec(entry.slice(0, tab))
    if (tab < 0 || !match) throw new Error('Unsupported Git index entry.')
    const [, mode, oid, stage] = match
    if (stage !== '0') throw new Error('Cannot capture an unmerged index.')
    if (mode === '120000') throw new Error('Unsupported symbolic link in Git index.')
    if (mode === '160000') throw new Error('Unsupported submodule in Git index.')
    if (mode !== '100644' && mode !== '100755') throw new Error(`Unsupported index mode: ${mode}`)
    entries.set(entry.slice(tab + 1), { mode, oid: oid! })
  }
  for (const path of git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--full-name']).split('\0').filter(Boolean)) {
    entries.set(path, { mode: null, oid: null })
  }
  if (entries.size > limits.maxFiles) throw new Error('Candidate file count limit exceeded.')

  let total = 0
  const files: CandidateFile[] = []
  for (const [path, index] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const absolute = validateFilePath(root, path)
    if (absolute === null) {
      if (index.mode === null) throw new Error('Candidate changed during capture: untracked file disappeared.')
      files.push({ path, index_mode: index.mode, index_oid: index.oid, executable: false, digest: null })
      continue
    }
    const before = lstatSync(absolute, { bigint: true })
    if (!before.isFile()) throw new Error(`Unsupported non-regular candidate file: ${path}`)
    if (before.size > BigInt(limits.maxFileBytes)) throw new Error(`Candidate file size limit exceeded: ${path}`)
    const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const hash = createHash('sha256')
    let size = 0
    try {
      if (!sameFile(before, fstatSync(fd, { bigint: true }))) throw new Error('Candidate changed while opening a file.')
      const buffer = Buffer.alloc(64 * 1024)
      for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) {
        total += read
        size += read
        if (size > limits.maxFileBytes || total > limits.maxTotalBytes) throw new Error('Candidate byte limit exceeded.')
        hash.update(buffer.subarray(0, read))
      }
      if (!sameFile(before, fstatSync(fd, { bigint: true })) || !sameFile(before, lstatSync(absolute, { bigint: true }))) {
        throw new Error('Candidate changed during file capture.')
      }
    }
    finally { closeSync(fd) }
    files.push({
      path, index_mode: index.mode, index_oid: index.oid,
      executable: process.platform === 'win32' ? index.mode === '100755' : (before.mode & 0o111n) !== 0n,
      digest: hash.digest('hex'),
    })
  }
  return { version: 1, root: identity(root), git_dir: gitDir, common_dir: commonDir, head, files }
}

export function captureCandidate(workspace: string, limits: CandidateLimits = {}): Candidate {
  const resolvedLimits = {
    maxFiles: limits.maxFiles ?? 50_000,
    maxFileBytes: limits.maxFileBytes ?? 64 * 1024 * 1024,
    maxTotalBytes: limits.maxTotalBytes ?? 256 * 1024 * 1024,
  }
  if (Object.values(resolvedLimits).some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('Candidate limits must be positive safe integers.')
  }
  const root = identity(workspace)
  if (identity(line(root, ['rev-parse', '--show-toplevel'])) !== root) throw new Error('Workspace must be a Git repository root.')
  const first = sample(root, resolvedLimits)
  const second = sample(root, resolvedLimits)
  const serialized = JSON.stringify(first)
  if (serialized !== JSON.stringify(second)) throw new Error('Candidate changed during capture; yield writes and retry.')
  return { ...first, digest: createHash('sha256').update(serialized).digest('hex') }
}

/** Read bounded bytes only if they still belong to the exact captured regular file. */
export function readCandidateFile(candidate: Candidate, file: CandidateFile, maxBytes = 16 * 1024 * 1024): Buffer {
  const absolute = validateFilePath(candidate.root, file.path)
  if (!absolute || !file.digest) throw new Error('Candidate content is absent.')
  const before = lstatSync(absolute, { bigint: true })
  if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error('Delegated file exceeds the bounded content limit.')
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!sameFile(before, fstatSync(fd, { bigint: true }))) throw new Error('Candidate file changed before reading.')
    const chunks: Buffer[] = []
    const buffer = Buffer.alloc(64 * 1024)
    let total = 0
    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) {
      total += read
      if (total > maxBytes) throw new Error('Delegated file exceeds the bounded content limit.')
      chunks.push(Buffer.from(buffer.subarray(0, read)))
    }
    const content = Buffer.concat(chunks)
    if (validateFilePath(candidate.root, file.path) !== absolute
      || !sameFile(before, fstatSync(fd, { bigint: true })) || !sameFile(before, lstatSync(absolute, { bigint: true }))
      || createHash('sha256').update(content).digest('hex') !== file.digest) throw new Error('Candidate file changed during reading.')
    return content
  }
  finally { closeSync(fd) }
}
