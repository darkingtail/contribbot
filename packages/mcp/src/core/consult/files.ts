import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export const MAX_RECORD_BYTES = 16 * 1024 * 1024

/** Consult data never shares the execution evidence/artifact namespace. */
export function consultDirectory(base: string, create = false): string {
  if (create) mkdirSync(base, { recursive: true })
  if (existsSync(base) && (!lstatSync(base).isDirectory() || lstatSync(base).isSymbolicLink())) {
    throw new Error('Consult data root must be a real directory.')
  }
  const root = join(existsSync(base) ? realpathSync(base) : base, 'consult')
  if (create && !existsSync(root)) mkdirSync(root)
  if (existsSync(root) && (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())) {
    throw new Error('Consult directory must not be a link.')
  }
  return root
}

export function readBounded(path: string, limit = MAX_RECORD_BYTES): Buffer {
  if (lstatSync(path).isSymbolicLink()) throw new Error('Consult file must not be a symbolic link.')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error('Consult file is not a bounded regular file.')
    const content = readFileSync(fd)
    if (content.length > limit) throw new Error('Consult file grew beyond its byte limit.')
    return content
  }
  finally { closeSync(fd) }
}

export function writeRecord(path: string, content: string, immutable = false): void {
  if (Buffer.byteLength(content) > MAX_RECORD_BYTES) throw new Error('Consult record size limit exceeded.')
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Consult file must not be a link.')
  const temporary = `${path}.${randomUUID()}.pending`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
  }
  finally { closeSync(fd) }
  try {
    if (!immutable) renameSync(temporary, path)
    else {
      try { linkSync(temporary, path) }
      catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
        if (!readBounded(path).equals(Buffer.from(content))) throw new Error('Immutable Consult record differs.')
      }
    }
  }
  finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
