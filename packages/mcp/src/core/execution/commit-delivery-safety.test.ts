import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureCandidate } from './candidate.js'
import { observeCommitDelivery } from './commit-delivery.js'

describe('commit delivery Git safety with actual Git fixtures', () => {
  let home: string
  let root: string
  const git = (...args: string[]) => execFileSync('git', [
    '--no-optional-locks', '-c', 'core.hooksPath=nonexistent-hooks', '-c', 'commit.gpgSign=false', ...args,
  ], {
    cwd: root, windowsHide: true, timeout: 10_000, encoding: 'utf8', stdio: 'pipe',
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
  }).trim()
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-commit-safety-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('XDG_CONFIG_HOME', join(home, 'xdg'))
    root = join(home, 'work')
    mkdirSync(root)
    git('init', '--quiet', '--template=', '--initial-branch=fixture')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'core.autocrlf', 'false')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/main.txt'), 'accepted\n')
    writeFileSync(join(root, '.gitattributes'), 'src/*.txt text\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'Fixture content')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    const path = resolve(home)
    const rel = relative(resolve(tmpdir()), path)
    if (!rel.startsWith('contribbot-commit-safety-') || rel.includes(sep)) throw new Error('Unsafe fixture cleanup.')
    rmSync(path, { recursive: true, force: true })
  })

  it.each(['unset', 'unspecified'])('does not mistake filter=%s for the absence of a custom driver', name => {
    const marker = join(home, 'filter-ran')
    const helper = join(home, 'filter.cjs')
    writeFileSync(helper, "require('node:fs').writeFileSync(process.argv[2],'ran');process.stdout.write('different filtered bytes\\n')\n")
    const quote = (value: string) => `"${value.replaceAll('\\', '/')}"`
    git('config', `filter.${name}.clean`, `${quote(process.execPath)} ${quote(helper)} ${quote(marker)}`)
    writeFileSync(join(root, '.gitattributes'), `src/*.txt text filter=${name}\n`)
    writeFileSync(join(root, 'src/main.txt'), 'accepted\r\n')
    // Positive control: only this fixture call may execute our harmless filter.
    expect(git('hash-object', 'src/main.txt')).not.toBe(git('rev-parse', 'HEAD:src/main.txt'))
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    const observed = observeCommitDelivery(captureCandidate(root), ['src'])
    expect(observed.endpoint).toBe('not_observed')
    expect(existsSync(marker)).toBe(false)
  }, 30_000)

  it.each([
    { attr: 'text', content: 'accepted\n', checkout: 'accepted\r\n' },
    { attr: 'ident', content: '$Id$\n', checkout: '$Id: deadbeef $\n' },
  ])('does not treat literal $attr=set as the Boolean attribute', ({ attr, content, checkout }) => {
    writeFileSync(join(root, '.gitattributes'), `src/*.txt ${attr}\n`)
    writeFileSync(join(root, 'src/main.txt'), content)
    git('add', '.')
    git('commit', '--quiet', '--allow-empty', '-m', 'Fixture builtin attribute')
    writeFileSync(join(root, '.gitattributes'), `src/*.txt ${attr}=set\n`)
    writeFileSync(join(root, 'src/main.txt'), checkout)
    expect(git('check-attr', attr, '--', 'src/main.txt')).toContain(`: ${attr}: set`)
    expect(git('hash-object', 'src/main.txt')).not.toBe(git('rev-parse', 'HEAD:src/main.txt'))
    expect(observeCommitDelivery(captureCandidate(root), ['src']).endpoint).not.toBe('present')
  }, 30_000)

  it.each(['global', 'global-macro', 'global-bom', 'info', 'nested', 'index', 'ignored'])('preserves raw %s attribute semantics during isolated conversion', kind => {
    if (kind.startsWith('global')) {
      const global = join(home, 'attributes')
      const rules = '[attr]reviewed text eol=lf\n' + (kind === 'global-macro' ? '' : 'src/*.txt reviewed\n')
      writeFileSync(global, Buffer.concat([kind === 'global-bom' ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(rules)]))
      git('config', 'core.attributesFile', global)
      writeFileSync(join(root, '.gitattributes'), kind === 'global-macro' ? 'src/*.txt reviewed\n' : '')
    }
    if (kind === 'info') {
      mkdirSync(join(root, '.git/info'), { recursive: true })
      writeFileSync(join(root, '.git/info/attributes'), 'src/*.txt text eol=lf\n')
      writeFileSync(join(root, '.gitattributes'), 'src/*.txt -text\n')
    }
    if (kind === 'nested') {
      writeFileSync(join(root, '.gitattributes'), '[attr]reviewed text eol=lf\nsrc/*.txt -text\n')
      writeFileSync(join(root, 'src/.gitattributes'), '*.txt reviewed\n')
      git('add', '--', 'src/.gitattributes')
      git('commit', '--quiet', '-m', 'Fixture nested attributes')
    }
    if (kind === 'index') rmSync(join(root, '.gitattributes'))
    if (kind === 'ignored') {
      git('rm', '--cached', '--quiet', '.gitattributes')
      writeFileSync(join(root, '.gitignore'), '.gitattributes\n')
      git('add', '.gitignore')
      git('commit', '--quiet', '-m', 'Fixture ignored but effective attributes')
    }
    writeFileSync(join(root, 'src/main.txt'), 'accepted\r\n')
    if (kind === 'index') {
      expect(git('check-attr', 'text', '--', 'src/main.txt')).toContain(': text: set')
      // hash-object does not load the source index; git add does use this fallback.
      git('add', '--renormalize', '--', 'src/main.txt')
      expect(git('rev-parse', ':src/main.txt')).toBe(git('rev-parse', 'HEAD:src/main.txt'))
    }
    else expect(git('hash-object', 'src/main.txt')).toBe(git('rev-parse', 'HEAD:src/main.txt'))
    expect(observeCommitDelivery(captureCandidate(root), ['src']).endpoint).toBe('present')
  }, 30_000)

  it.each(['assume-unchanged', 'skip-worktree'])('refuses an ambiguous attribute-file index flag: %s', flag => {
    git('update-index', `--${flag}`, '.gitattributes')
    writeFileSync(join(root, 'src/main.txt'), 'accepted\r\n')
    const observed = observeCommitDelivery(captureCandidate(root), ['src'])
    expect(observed.endpoint).toBe('not_observed')
    expect(observed.note).toContain('Attribute files with')
  }, 30_000)

  it('refuses Git conversion errors even when hash-object returns an OID and status zero', () => {
    writeFileSync(join(root, '.gitattributes'), 'src/*.txt text working-tree-encoding=unset\n')
    writeFileSync(join(root, 'src/main.txt'), 'accepted\r\n')
    const control = spawnSync('git', ['hash-object', 'src/main.txt'], {
      cwd: root, windowsHide: true, encoding: 'utf8', timeout: 10_000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    })
    expect(control.status).toBe(0)
    expect(control.stderr).toMatch(/encoding|encode|convert/i)
    expect(observeCommitDelivery(captureCandidate(root), ['src']).endpoint).toBe('not_observed')
  }, 30_000)

  it('does not fetch missing sparse-index trees during candidate recapture', () => {
    mkdirSync(join(root, 'excluded'))
    writeFileSync(join(root, 'excluded/other.txt'), 'outside\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'Fixture sparse directory')
    const missingTree = git('rev-parse', 'HEAD:excluded')
    git('sparse-checkout', 'init', '--cone', '--sparse-index')
    git('sparse-checkout', 'set', 'src')
    expect(git('ls-files', '--sparse', '--stage')).toContain('040000')
    const marker = join(home, 'remote-helper-ran')
    const helper = join(home, 'remote.cjs')
    writeFileSync(helper, "require('node:fs').writeFileSync(process.argv[2],'ran')\n")
    const escaped = (value: string) => value.replaceAll('\\', '/').replaceAll('%', '%%').replaceAll(' ', '% ')
    git('remote', 'add', 'origin', `ext::${escaped(process.execPath)} ${escaped(helper)} ${escaped(marker)}`)
    git('config', 'protocol.ext.allow', 'always')
    // The helper writes a marker and exits, never contacts a real service.
    expect(() => git('ls-remote', 'origin')).toThrow()
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    git('config', 'extensions.partialClone', 'origin')
    git('config', 'remote.origin.promisor', 'true')
    rmSync(join(root, '.git/objects', missingTree.slice(0, 2), missingTree.slice(2)))
    let result: ReturnType<typeof captureCandidate> | undefined
    let error: unknown
    try { result = captureCandidate(root) }
    catch (caught) { error = caught }
    expect({
      helperRan: existsSync(marker), error: error instanceof Error ? error.message : null,
      paths: result?.files.map(file => file.path) ?? [],
    }).toMatchObject({ helperRan: false, error: expect.any(String) })
  }, 30_000)
})
