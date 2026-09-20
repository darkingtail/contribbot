import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { buildPacket, scopeAllows } from './packet.js'
import { digest } from './contracts.js'

let workspace: string
const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgSign=false', ...args],
  { cwd: workspace, stdio: 'pipe', windowsHide: true })
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'consult-packet-'))
  git('init', '--quiet')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'test@example.invalid')
  mkdirSync(join(workspace, 'src'))
  writeFileSync(join(workspace, 'src/a.ts'), 'export const value = 1\n')
  writeFileSync(join(workspace, '.gitignore'), 'ignored.txt\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'fixture')
}, 15_000)
afterEach(() => { rmSync(workspace, { recursive: true, force: true }) })

it('sends committed tracked text by default, records exact provenance, and separates working-tree changes', () => {
  writeFileSync(join(workspace, 'src/a.ts'), 'export const value = 2\n')
  const packet = buildPacket({ workspace, question: 'Review this', files: [{ path: 'src/a.ts', category: 'tracked' }] })
  expect(packet.body).toContain('value = 1')
  expect(packet.body).not.toContain('value = 2')
  expect(packet.digest).toBe(digest(packet.body))
  expect(packet.manifest[1]?.source).toBe(`git:${packet.head}:src/a.ts`)
  const diff = buildPacket({ workspace, question: 'Review changes', files: [{ path: 'src/a.ts', category: 'diff' }] })
  expect(diff.body).toContain('+export const value = 2')
  expect(scopeAllows({ categories: ['question', 'tracked'], paths: ['src'] }, diff)).toBe(false)
})

it('distinguishes ignored/untracked files and denies secrets and path escapes regardless of requested category', () => {
  writeFileSync(join(workspace, 'extra.txt'), 'untracked')
  writeFileSync(join(workspace, 'ignored.txt'), 'ignored')
  writeFileSync(join(workspace, '.env'), 'private')
  expect(() => buildPacket({ workspace, question: 'q', files: [{ path: 'extra.txt', category: 'tracked' }] })).toThrow(/tracked/)
  expect(() => buildPacket({ workspace, question: 'q', files: [{ path: 'ignored.txt', category: 'untracked' }] })).toThrow(/category/)
  for (const path of ['../outside', '.git/config', '.env', 'C:/outside.txt', 'src/../.env']) {
    expect(() => buildPacket({ workspace, question: 'q', files: [{ path, category: 'untracked' }] })).toThrow()
  }
  expect(() => buildPacket({ workspace, question: `Do not send ${'sk-'.concat('a'.repeat(30))}` })).toThrow(/credential/)
})

it('does not follow a directory symlink into another directory', () => {
  symlinkSync(join(workspace, 'src'), join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => buildPacket({
    workspace, question: 'q', files: [{ path: 'linked/a.ts', category: 'untracked' }],
  })).toThrow(/symbolic/)
})

it('never silently truncates required context and reports omission of ordinary history', () => {
  expect(() => buildPacket({ workspace, question: 'q'.repeat(128 * 1024) })).toThrow(/limit/)
  const packet = buildPacket({ workspace, question: 'q' }, [
    { source: 'decision:d1', text: 'Confirmed decision', priority: 0 },
    { source: 'history:huge', text: 'a'.repeat(128 * 1024), priority: 3 },
  ])
  expect(packet.body).toContain('Confirmed decision')
  expect(packet.omitted).toEqual(['history:huge'])
})
