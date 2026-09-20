import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  MAX_PACKET_BYTES, digest, packetInputSchema,
} from './contracts.js'
import type { Packet, PacketInput, Scope } from './contracts.js'
import { readBounded } from './files.js'

export function normalizedPath(path: string): string {
  const result = path.replace(/\\/g, '/')
  if (isAbsolute(path) || /^[a-z]:/i.test(result) || result.includes('\0')
    || result.split('/').some(part => !part || part === '..' || part === '.')
    || /[:*?[\]]/.test(result)) throw new Error('Material paths must be literal workspace-relative paths.')
  return result
}

export function denySensitivePath(path: string): void {
  const parts = path.toLowerCase().split('/')
  if (parts.some(part => part === '.git' || part === '.ssh' || part === '.aws'
    || part === '.env' || part.startsWith('.env.') || part === '.npmrc' || part === '.netrc'
    || /^(?:credentials?|secrets?|auth)(?:\.|$)/.test(part)
    || /^(?:id_rsa|id_ed25519)/.test(part) || /\.(?:pem|p12|pfx|key)$/.test(part))) {
    throw new Error(`Sensitive or Git-internal material is excluded: ${path}`)
  }
}

export function assertNoCredentials(text: string): void {
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text)
    || /\b(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|sk-[a-zA-Z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/.test(text)
    || /(?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?(?!process\.|os\.|env\b|\$\{|<|example\b|placeholder\b|null\b|undefined\b|false\b)[a-zA-Z0-9+/=_-]{16,}/i.test(text)) {
    throw new Error('Potential credential material detected; redact it before consultation.')
  }
}

export function workspaceFile(workspace: string, path: string, allowMissing = false): string {
  const root = realpathSync(workspace)
  const normalized = normalizedPath(path)
  denySensitivePath(normalized)
  let location = root
  for (const part of normalized.split('/')) {
    location = join(location, part)
    if (existsSync(location) && lstatSync(location).isSymbolicLink()) {
      throw new Error('Consult materials must not traverse symbolic links.')
    }
  }
  const resolved = allowMissing && !existsSync(location) ? location : realpathSync(location)
  const rel = relative(root, resolved)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Material escapes workspace.')
  return resolved
}

function git(workspace: string, args: string[], maxBuffer = MAX_PACKET_BYTES): Buffer {
  return execFileSync('git', ['--no-pager', ...(args[0] === 'check-ignore' ? [] : ['--literal-pathspecs']),
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=',
    '-c', 'diff.external=', ...args], {
    cwd: workspace, windowsHide: true, shell: false, maxBuffer, timeout: 10_000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function scopeAllows(scope: Scope, packet: Pick<Packet, 'manifest'>): boolean {
  return packet.manifest.every(entry => scope.categories.includes(entry.category)
    && (entry.path === null || scope.paths.some(raw => {
      const path = raw === '.' ? '.' : normalizedPath(raw)
      return path === '.' || entry.path === path || entry.path!.startsWith(`${path}/`)
    })))
}

export interface HistoryItem { source: string; text: string; priority: number }

export function buildPacket(raw: PacketInput, history: HistoryItem[] = []): Packet {
  const input = packetInputSchema.parse(raw)
  const workspace = realpathSync(resolve(input.workspace))
  if (!lstatSync(workspace).isDirectory()) throw new Error('Consult workspace must be a directory.')
  const manifest: Packet['manifest'] = []
  const bodies: string[] = []
  const omitted: string[] = []
  let bytes = 0
  const add = (category: Packet['manifest'][number]['category'], path: string | null, source: string,
    text: string, optional = false, notes: string[] = []) => {
    assertNoCredentials(text)
    const section = JSON.stringify({ category, path, source, text })
    const size = Buffer.byteLength(section) + 1
    if (bytes + size > MAX_PACKET_BYTES) {
      if (!optional) throw new Error('Context exceeds the packet byte limit. Narrow the selected material.')
      omitted.push(source)
      return
    }
    bytes += size
    bodies.push(section)
    manifest.push({ category, path, source, sha256: digest(text), bytes: Buffer.byteLength(text), notes })
  }
  add('question', null, 'current-question', input.question)
  for (const item of history.filter(item => item.priority <= 1)) add('history', null, item.source, item.text)
  for (const item of input.context) add('context', null, item.source, item.text)
  let head: string | null = null
  if (input.files.length) {
    const top = realpathSync(git(workspace, ['rev-parse', '--show-toplevel']).toString('utf8').trim())
    if (top !== workspace) throw new Error('Material workspace must be the Git root.')
    head = git(workspace, ['rev-parse', 'HEAD']).toString('utf8').trim()
  }
  const seen = new Set<string>()
  for (const file of input.files) {
    const path = normalizedPath(file.path)
    denySensitivePath(path)
    if (seen.has(`${file.category}:${path}`)) throw new Error('Duplicate material selection.')
    seen.add(`${file.category}:${path}`)
    // Validate the existing path before reading either its HEAD blob or local content.
    const location = workspaceFile(workspace, path, file.category === 'tracked' || file.category === 'diff')
    const tracked = git(workspace, ['ls-files', '-z', '--', path], MAX_PACKET_BYTES).toString('utf8').split('\0').includes(path)
    let ignored = false
    try { ignored = git(workspace, ['check-ignore', '--no-index', '--', path]).length > 0 }
    catch (error) {
      if (!(error && typeof error === 'object' && 'status' in error && error.status === 1)) throw error
    }
    let content: Buffer
    let source: string
    if (file.category === 'tracked') {
      if (!tracked) throw new Error('Requested tracked material is not tracked.')
      const entry = git(workspace, ['ls-tree', '-z', 'HEAD', '--', path]).toString('utf8')
      if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(entry)) throw new Error('Tracked material must be a regular committed file, not a link or submodule.')
      // A default tracked selection sends committed content, never an unapproved working-tree change.
      content = git(workspace, ['show', `${head}:${path}`])
      source = `git:${head}:${path}`
    }
    else if (file.category === 'diff') {
      if (!tracked) throw new Error('Diff selection requires a tracked file.')
      content = git(workspace, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', 'HEAD', '--', path])
      source = `working-tree-diff:${head}:${path}`
    }
    else {
      if (tracked || (file.category === 'ignored') !== ignored) throw new Error('Material category does not match Git status.')
      content = readBounded(location, MAX_PACKET_BYTES)
      source = `working-tree:${path}`
    }
    const text = content.toString('utf8')
    if (text.includes('\0') || !Buffer.from(text).equals(content)) throw new Error('Only lossless UTF-8 text can be packaged.')
    add(file.category, path, source, text, false,
      file.category === 'tracked' ? ['Committed HEAD content; working-tree changes excluded.'] : ['Expanded material scope.'])
  }
  for (const item of history.filter(item => item.priority > 1).sort((a, b) => a.priority - b.priority)) {
    add('history', null, item.source, item.text, true)
  }
  const body = bodies.join('\n')
  return { workspace, head, manifest, body, digest: digest(body), omitted }
}
