import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'
import { buildPacket, scopeAllows } from '../dist/consult/packet.js'
import { digest, packetSchema } from '../dist/consult/contracts.js'
import { consultDirectory, readBounded, writeRecord } from '../dist/consult/files.js'

let workspace
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', ...args], {
  cwd: workspace, stdio: 'pipe', windowsHide: true,
})

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'contribbot-core-packet-'))
  git('init', '--quiet')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'test@example.invalid')
  mkdirSync(join(workspace, 'src'))
  writeFileSync(join(workspace, 'src/a.ts'), 'export const value = 1\n')
  writeFileSync(join(workspace, '.gitignore'), 'ignored.txt\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'fixture')
})

afterEach(() => rmSync(workspace, { recursive: true, force: true }))

test('packages tracked HEAD content separately from the working-tree diff', () => {
  writeFileSync(join(workspace, 'src/a.ts'), 'export const value = 2\n')
  const packet = buildPacket({ workspace, question: 'Review this', files: [{ path: 'src/a.ts', category: 'tracked' }] })
  assert.match(packet.body, /value = 1/)
  assert.doesNotMatch(packet.body, /value = 2/)
  assert.equal(packet.digest, digest(packet.body))
  assert.equal(packet.manifest[1].source, `git:${packet.head}:src/a.ts`)

  const diff = buildPacket({ workspace, question: 'Review changes', files: [{ path: 'src/a.ts', category: 'diff' }] })
  assert.match(diff.body, /\+export const value = 2/)
  assert.equal(scopeAllows({ categories: ['question', 'tracked'], paths: ['src'] }, diff), false)
})

test('preserves packet bytes and digests produced before the Core extraction', () => {
  const legacy = JSON.parse(readFileSync(new URL('./fixtures/legacy-packet.json', import.meta.url), 'utf8'))
  const parsed = packetSchema.parse(legacy)
  assert.equal(digest(parsed.body), parsed.digest)

  const current = buildPacket({
    workspace,
    question: 'Review this',
    context: [{ source: 'decision:d1', text: 'Use the shared Core boundary.' }],
  }, [{ source: 'history:h1', text: 'Historical note', priority: 2 }])

  assert.equal(current.body, parsed.body)
  assert.deepEqual(current.manifest, parsed.manifest)
  assert.equal(current.digest, parsed.digest)
  assert.deepEqual(current.omitted, parsed.omitted)
})

test('keeps Consult records bounded, atomic and immutable', () => {
  const root = consultDirectory(join(workspace, 'records'), true)
  const record = join(root, 'turn.yaml')
  writeRecord(record, 'version: 1\n')
  assert.equal(readBounded(record).toString('utf8'), 'version: 1\n')
  assert.throws(() => writeRecord(record, 'version: 2\n', true), /differs/i)
  writeRecord(record, 'version: 1\n', true)
  assert.equal(readBounded(record).toString('utf8'), 'version: 1\n')
})

test('rejects sensitive material, path escapes, and category mismatches', () => {
  writeFileSync(join(workspace, 'extra.txt'), 'untracked')
  writeFileSync(join(workspace, 'ignored.txt'), 'ignored')
  writeFileSync(join(workspace, '.env'), 'private')

  assert.throws(() => buildPacket({ workspace, question: 'q', files: [{ path: 'extra.txt', category: 'tracked' }] }), /tracked/)
  assert.throws(() => buildPacket({ workspace, question: 'q', files: [{ path: 'ignored.txt', category: 'untracked' }] }), /category/)
  for (const path of ['../outside', '.git/config', '.env', 'C:/outside.txt', 'src/../.env']) {
    assert.throws(() => buildPacket({ workspace, question: 'q', files: [{ path, category: 'untracked' }] }))
  }
  assert.throws(() => buildPacket({ workspace, question: `Do not send ${'sk-'.concat('a'.repeat(30))}` }), /credential/)
})

test('does not follow a directory symlink into another directory', t => {
  try {
    symlinkSync(join(workspace, 'src'), join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return t.skip('Symlink creation is unavailable on this host.')
    throw error
  }
  assert.throws(() => buildPacket({
    workspace, question: 'q', files: [{ path: 'linked/a.ts', category: 'untracked' }],
  }), /symbolic/)
})

test('keeps required context strict and reports omitted low-priority history', () => {
  assert.throws(() => buildPacket({ workspace, question: 'q'.repeat(128 * 1024) }), /limit/)
  const packet = buildPacket({ workspace, question: 'q' }, [
    { source: 'decision:d1', text: 'Confirmed decision', priority: 0 },
    { source: 'history:huge', text: 'a'.repeat(128 * 1024), priority: 3 },
  ])
  assert.match(packet.body, /Confirmed decision/)
  assert.deepEqual(packet.omitted, ['history:huge'])
})
