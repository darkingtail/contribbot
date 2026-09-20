import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Candidate } from './candidate.js'

export interface AttributeSource {
  role: 'system' | 'global' | 'info' | 'worktree'
  path: string
  origin: 'file' | 'index' | 'absent'
  bytes: Buffer | null
}

const maxFile = 1024 * 1024
const maxTotal = 8 * 1024 * 1024
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

function readMetadata(path: string): Buffer | null {
  let before: BigIntStats
  let physical: string
  try {
    before = lstatSync(path, { bigint: true })
    physical = realpathSync(path)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Cannot read Git attribute metadata.')
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxFile)) {
    throw new Error('Git attribute metadata must be a bounded regular file.')
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!sameFile(before, fstatSync(fd, { bigint: true }))) throw new Error('Git attribute metadata changed before reading.')
    const content = Buffer.alloc(maxFile + 1)
    let size = 0
    while (size <= maxFile) {
      const count = readSync(fd, content, size, content.length - size, null)
      if (!count) break
      size += count
    }
    if (size > maxFile) throw new Error('Git attribute metadata exceeds the byte limit.')
    if (realpathSync(path) !== physical || !sameFile(before, fstatSync(fd, { bigint: true }))
      || !sameFile(before, lstatSync(path, { bigint: true }))) throw new Error('Git attribute metadata changed during reading.')
    return Buffer.from(content.subarray(0, size))
  }
  finally { closeSync(fd) }
}

export function attributeTarget(workspace: string, path: string): string {
  const absolute = resolve(workspace, path)
  const rel = relative(workspace, absolute)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)
    || rel.replaceAll('\\', '/').split('/').some(part => part.toLowerCase() === '.git')) {
    throw new Error('Unsafe relative Git attribute path.')
  }
  return absolute
}

export function attributeFingerprints(sources: AttributeSource[]) {
  return sources.map(({ role, path, origin, bytes }) => ({
    role, path, origin, digest: bytes === null ? null : createHash('sha256').update(bytes).digest('hex'),
  }))
}

/** Copy data, not an attribute parser: Git retains Boolean, literal and macro semantics. */
export function captureAttributeSources(candidate: Candidate, paths: string[], git: (args: string[]) => string): AttributeSource[] {
  const line = (args: string[]) => git(args).replace(/\r?\n$/, '')
  const sources: AttributeSource[] = []
  let total = 0
  const add = (role: AttributeSource['role'], path: string, physical: string, index?: string | null) => {
    let bytes = readMetadata(physical)
    let origin: AttributeSource['origin'] = bytes === null ? 'absent' : 'file'
    if (bytes === null && index) {
      bytes = Buffer.from(git(['cat-file', 'blob', index]), 'utf8')
      origin = 'index'
      const oid = createHash(index.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
      if (oid !== index) throw new Error('Index attribute blob does not match its captured identity.')
    }
    total += bytes?.length ?? 0
    if ((bytes?.length ?? 0) > maxFile || total > maxTotal) throw new Error('Git attribute metadata byte limit exceeded.')
    sources.push({ role, path, origin, bytes })
  }
  for (const [role, variable] of [['system', 'GIT_ATTR_SYSTEM'], ['global', 'GIT_ATTR_GLOBAL']] as const) {
    const path = line(['var', variable])
    if (!path) throw new Error('Git does not expose an effective attribute source path.')
    add(role, role, resolve(candidate.root, path))
  }
  add('info', 'info', resolve(candidate.root, line(['rev-parse', '--git-path', 'info/attributes'])))
  const names = new Set<string>(['.gitattributes'])
  for (const path of paths) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) names.add(`${parts.slice(0, index).join('/')}/.gitattributes`)
  }
  if (names.size > 10_000) throw new Error('Git attribute file count limit exceeded.')
  const flags = git(['ls-files', '-v', '-z', '--full-name']).split('\0').filter(Boolean)
  for (const entry of flags) {
    if (names.has(entry.slice(2)) && (entry[0] === 'S' || /[a-z]/.test(entry[0]!))) {
      throw new Error('Attribute files with skip-worktree or assume-unchanged require an explicit unambiguous observation.')
    }
  }
  const files = new Map(candidate.files.map(file => [file.path, file]))
  for (const path of [...names].sort()) add('worktree', path, attributeTarget(candidate.root, path), files.get(path)?.index_oid)
  return sources
}

/** Git stdin-paths uses C quoting, not shell or JSON quoting. */
export function quoteGitPath(path: string): string {
  return `"${[...Buffer.from(path, 'utf8')].map(byte => byte >= 32 && byte < 127 && byte !== 34 && byte !== 92
    ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, '0')}`).join('')}"`
}
