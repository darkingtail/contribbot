import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureCandidate } from './candidate.js'

describe('candidate capture against real Git repositories', () => {
  let root: string
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'core.hooksPath=nonexistent-hooks',
    '-c', 'commit.gpgSign=false',
    ...args,
  ], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'contribbot candidate-'))
    git('init', '--quiet', '--initial-branch=fixture')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'core.autocrlf', 'false')
    writeFileSync(join(root, '.gitignore'), 'ignored/\n')
    writeFileSync(join(root, 'source.txt'), 'original\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'fixture baseline')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  it('is stable and read-only on an unchanged checkout', () => {
    const before = git('status', '--porcelain=v1')
    const candidate = captureCandidate(root)
    expect(candidate.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(candidate.head).toBe(git('rev-parse', 'HEAD'))
    expect(captureCandidate(root)).toEqual(candidate)
    expect(git('status', '--porcelain=v1')).toBe(before)
    expect(candidate.files.find(file => file.path === 'source.txt')?.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(candidate)).not.toContain('original\n')
  })

  it('includes unstaged content, additions and deletion without changing HEAD', () => {
    const initial = captureCandidate(root)
    writeFileSync(join(root, 'source.txt'), 'changed\n')
    const modified = captureCandidate(root)
    expect(modified.head).toBe(initial.head)
    expect(modified.digest).not.toBe(initial.digest)
    writeFileSync(join(root, 'new file.txt'), 'new\n')
    const added = captureCandidate(root)
    expect(added.digest).not.toBe(modified.digest)
    expect(added.files.find(file => file.path === 'new file.txt')?.index_mode).toBeNull()
    rmSync(join(root, 'source.txt'))
    const deleted = captureCandidate(root)
    expect(deleted.digest).not.toBe(added.digest)
    expect(deleted.files.find(file => file.path === 'source.txt')?.digest).toBeNull()
  })

  it('includes staged content, index changes and executable mode', () => {
    const initial = captureCandidate(root)
    writeFileSync(join(root, 'source.txt'), 'staged\n')
    git('add', 'source.txt')
    writeFileSync(join(root, 'source.txt'), 'original\n')
    expect(captureCandidate(root).digest).not.toBe(initial.digest)
    const staged = captureCandidate(root)
    git('update-index', '--chmod=+x', 'source.txt')
    expect(captureCandidate(root).digest).not.toBe(staged.digest)
  })

  it('uses NUL-delimited paths, including non-ASCII names', () => {
    writeFileSync(join(root, '测试 文档.txt'), 'content')
    if (process.platform !== 'win32') writeFileSync(join(root, 'line\n"quote".txt'), 'content')
    const names = captureCandidate(root).files.map(file => file.path)
    expect(names).toContain('测试 文档.txt')
    if (process.platform !== 'win32') expect(names).toContain('line\n"quote".txt')
  })

  it('excludes ignored output but still includes ignored tracked files', () => {
    const initial = captureCandidate(root)
    mkdirSync(join(root, 'ignored'))
    writeFileSync(join(root, 'ignored', 'output'), 'untracked output')
    expect(captureCandidate(root).digest).toBe(initial.digest)
    git('add', '--force', 'ignored/output')
    const tracked = captureCandidate(root)
    writeFileSync(join(root, 'ignored', 'output'), 'changed tracked output')
    expect(captureCandidate(root).digest).not.toBe(tracked.digest)
  })

  it('rejects non-root paths, symlinked directories and nonrepositories', () => {
    mkdirSync(join(root, 'nested'))
    expect(() => captureCandidate(join(root, 'nested'))).toThrow(/root/i)
    const external = mkdtempSync(join(tmpdir(), 'contribbot outside-'))
    try {
      expect(() => captureCandidate(external)).toThrow()
      writeFileSync(join(external, 'secret'), 'outside')
      symlinkSync(external, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => captureCandidate(root)).toThrow(/symbolic|symlink|junction/i)
    }
    finally {
      rmSync(join(root, 'link'), { force: true, recursive: true })
      rmSync(external, { recursive: true, force: true })
    }
  })

  it('rejects gitlink entries even when the submodule is not checked out', () => {
    git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD')},submodule`)
    expect(() => captureCandidate(root)).toThrow(/submodule/i)
  })

  it('rejects unmerged index stages', () => {
    const oid = git('rev-parse', 'HEAD:source.txt')
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: root,
      input: `0 ${'0'.repeat(40)}\tsource.txt\n100644 ${oid} 1\tsource.txt\n100644 ${oid} 2\tsource.txt\n`,
      windowsHide: true,
    })
    expect(() => captureCandidate(root)).toThrow(/unmerged/i)
  })

  it('bounds files and bytes instead of silently hashing partial content', () => {
    expect(() => captureCandidate(root, { maxFiles: 1 })).toThrow(/limit/i)
    expect(() => captureCandidate(root, { maxFileBytes: 1 })).toThrow(/limit/i)
    expect(() => captureCandidate(root, { maxTotalBytes: 1 })).toThrow(/limit/i)
  })

  it.skipIf(process.platform === 'win32')('captures unstaged executable bit changes', () => {
    const initial = captureCandidate(root)
    chmodSync(join(root, 'source.txt'), 0o755)
    expect(captureCandidate(root).digest).not.toBe(initial.digest)
  })

  it('does not include the contents of a deleted file in its manifest', () => {
    const original = readFileSync(join(root, 'source.txt'), 'utf8')
    rmSync(join(root, 'source.txt'))
    const candidate = captureCandidate(root)
    expect(JSON.stringify(candidate)).not.toContain(original)
    expect(candidate.files.find(file => file.path === 'source.txt')?.digest).toBeNull()
  })

  it('ignores ambient Git redirection and configuration injection', () => {
    const expected = captureCandidate(root)
    vi.stubEnv('GIT_DIR', join(root, 'not-the-git-directory'))
    vi.stubEnv('GIT_WORK_TREE', join(root, 'another-worktree'))
    vi.stubEnv('GIT_INDEX_FILE', join(root, 'another-index'))
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.bare')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true')
    expect(captureCandidate(root)).toEqual(expected)
  })

  it('rejects symlink index modes even when the checkout contains an ordinary file', () => {
    const oid = git('rev-parse', 'HEAD:source.txt')
    git('update-index', '--add', '--cacheinfo', `120000,${oid},source.txt`)
    expect(() => captureCandidate(root)).toThrow(/symbolic/i)
  })

  it('distinguishes linked worktree HEAD/index identity from the common directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'contribbot-worktree-'))
    try {
      git('worktree', 'add', '--detach', outside, 'HEAD')
      const primary = captureCandidate(root)
      const linked = captureCandidate(outside)
      expect(linked.common_dir).toBe(primary.common_dir)
      expect(linked.git_dir).not.toBe(primary.git_dir)
      expect(linked.head).toBe(primary.head)
      expect(linked.digest).not.toBe(primary.digest)
      writeFileSync(join(outside, 'source.txt'), 'linked worktree changes')
      expect(captureCandidate(root)).toEqual(primary)
      expect(captureCandidate(outside).digest).not.toBe(linked.digest)
    }
    finally { rmSync(outside, { recursive: true, force: true }) }
  }, 15_000)
})
