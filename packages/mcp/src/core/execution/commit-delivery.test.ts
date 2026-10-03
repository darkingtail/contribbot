import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoStore } from '../storage/todo-store.js'
import * as candidates from './candidate.js'
import { observeCommitDelivery } from './commit-delivery.js'
import { runLocalCommand } from './local.js'
import { planDigest } from './workflow.js'
import { fixtureProjectDirectory, fixtureRepository, saveFixtureProjectConfig } from './__fixtures__/repository.js'

const plan = () => ({
  goal: 'Commit the accepted source', completion_scope: 'task', remaining_scope: [], non_goals: [], scope: ['src'], risk: 'normal',
  steps: [{ id: 'implement', title: 'Implement', scope: ['src'], depends_on: [], acceptance_ids: ['review'] }],
  acceptance: [{ id: 'review', description: 'Inspect the accepted content', kind: 'manual', required: true, independent: false }],
  deliverables: [{ id: 'commit', description: 'Current captured commit contains this source', required: true, acceptance_ids: ['review'],
    target: { kind: 'commit', scope: ['src'] } }],
})

describe('explicit commit delivery contract', () => {
  it('accepts a scoped current-commit requirement without an invented future SHA', () => {
    expect(() => planDigest(plan())).not.toThrow()
    const narrower = plan()
    narrower.deliverables[0]!.target.scope = ['src/main.txt']
    expect(planDigest(narrower)).not.toBe(planDigest(plan()))
  })

  it('rejects empty, duplicate, out-of-plan and magic scopes without extending old targets', () => {
    for (const scope of [[], ['src', 'src'], ['elsewhere'], ['src/*'], ['../outside']]) {
      const invalid = plan()
      invalid.deliverables[0]!.target.scope = scope
      expect(() => planDigest(invalid)).toThrow()
    }
    const future = plan()
    Object.assign(future.deliverables[0]!.target, { sha: 'f'.repeat(40) })
    expect(() => planDigest(future)).toThrow()
  })
})

describe('actual local commit delivery', () => {
  let home: string
  let workspace: string
  let store: TodoStore
  let todoId: string
  let executionId: string
  let serial: number
  const state = () => store.get(0)!.executions[0]!.workflow!
  const local = (action: string, payload: Record<string, unknown> = {}) => runLocalCommand({
    action, repo: fixtureRepository('fixture/commit'), data_root: join(home, 'data'), todo_id: todoId, execution_id: executionId, ...payload,
  })
  const mutation = () => ({ request_id: `fixture-${++serial}`, expected_revision: state()?.revision ?? 0 })
  const git = (...args: string[]) => execFileSync('git', [
    '--no-optional-locks', '-c', 'core.hooksPath=nonexistent-hooks', '-c', 'commit.gpgSign=false', ...args,
  ], { cwd: workspace, windowsHide: true, stdio: 'pipe', encoding: 'utf8' }).trim()
  const capture = () => local('yield', {
    ...mutation(), actor: 'builder', observed_operations: state().operations.map(item => item.id), note: 'Fixture writers stopped.',
  })
  const report = () => local('report', {
    ...mutation(), operation_id: `report-${serial}`, acceptance_id: 'review', actor: 'fixture-user',
    source: 'user', outcome: 'passed', observed_at: new Date().toISOString(),
    plan_id: state().plan_id, attempt_id: state().attempt_id, epoch: state().epoch, candidate: state().yield!.candidate,
    locator: 'fixture:user-accepts-content', summary: 'Scripted content observation, not proof of commit delivery.',
  })
  async function prepare(input = plan()) {
    await local('apply', { ...mutation(), command: { action: 'propose_plan', plan_id: 'plan', plan: input } })
    await local('apply', { ...mutation(), command: {
      action: 'confirm_plan', plan_id: 'plan', digest: state().plans[0]!.digest, confirmation: 'fixture:explicit-commit-scope',
    } })
    await local('bind', { ...mutation(), workspace, attempt_id: 'attempt', owner: 'builder' })
    await capture()
    await report()
  }
  function initialize(options: { crlf?: boolean; attributes?: string; content?: Buffer; format?: 'sha1' | 'sha256' } = {}) {
    git('init', '--quiet', '--template=', '--initial-branch=fixture', `--object-format=${options.format ?? 'sha1'}`)
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'core.autocrlf', options.crlf ? 'true' : 'false')
    git('remote', 'add', 'origin', 'https://github.com/fixture/commit.git')
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src/main.txt'), options.content ?? 'accepted\n')
    if (options.attributes) writeFileSync(join(workspace, '.gitattributes'), options.attributes)
    git('add', '.')
    git('commit', '--quiet', '-m', 'Fixture commit')
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-commit-delivery-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('XDG_CONFIG_HOME', join(home, 'xdg'))
    workspace = join(home, 'workspace')
    mkdirSync(workspace)
    const directory = fixtureProjectDirectory(join(home, 'data'), 'fixture/commit')
    saveFixtureProjectConfig(directory, 'fixture/commit')
    store = new TodoStore(directory)
    todoId = store.add({ ref: 'commit', title: 'Commit accepted content', type: 'feature' }).id!
    executionId = store.activateExecution(0).execution.id
    serial = 0
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('observes the exact captured commit and ignores unrelated dirty files without mutating Git state', async () => {
    initialize()
    writeFileSync(join(workspace, 'unrelated.txt'), 'Outside delivery scope')
    await prepare()
    const index = readFileSync(join(workspace, '.git/index'))
    const config = readFileSync(join(workspace, '.git/config'))
    const result = await local('inspect')
    expect(result.readiness).toMatchObject({
      ready: true, gaps: [],
      deliveries: [{ endpoint: 'present', commit: { oid: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), source: 'local_git' } }],
    })
    expect(readFileSync(join(workspace, '.git/index'))).toEqual(index)
    expect(readFileSync(join(workspace, '.git/config'))).toEqual(config)
    const context = await local('context')
    expect(context).toMatchObject({ readiness: null, workspace_observation: 'not_observed', delivery_requirements: { items: plan().deliverables } })
    const record = readFileSync((context.document_projection as { path: string }).path, 'utf8')
    expect(record).toContain('commit: src')
  }, 30_000)

  it.each(['unstaged', 'staged', 'untracked', 'deleted', 'staged-only', 'mode', 'assume-unchanged'])(
    'does not call %s scoped content committed merely because a content report passed', async kind => {
      initialize()
      if (kind === 'untracked') writeFileSync(join(workspace, 'src/new.txt'), 'Not committed')
      else if (kind === 'deleted') rmSync(join(workspace, 'src/main.txt'))
      else if (kind === 'mode') git('update-index', '--chmod=+x', 'src/main.txt')
      else {
        if (kind === 'assume-unchanged') git('update-index', '--assume-unchanged', 'src/main.txt')
        writeFileSync(join(workspace, 'src/main.txt'), 'Uncommitted candidate\n')
        if (kind === 'staged' || kind === 'staged-only') git('add', 'src/main.txt')
        if (kind === 'staged-only') writeFileSync(join(workspace, 'src/main.txt'), 'accepted\n')
      }
      await prepare()
      expect((await local('inspect')).readiness).toMatchObject({
        ready: false, gaps: ['delivery:commit'], deliveries: [{ endpoint: 'missing' }],
      })
      await expect(local('close', {
        closure_id: 'no-waiver', expected_revision: state().revision, mode: 'with_gaps', acknowledged_gaps: ['delivery:commit'],
        decision: 'fixture:finish', note: 'Commit endpoint remains required', target: { kind: 'local' },
      })).rejects.toThrow(/delivery:commit/)
      expect(store.get(0)!.status).toBe('active')
    }, 30_000,
  )

  it.each(['sha1', 'sha256'] as const)('supports ordinary CRLF checkout with %s object identities', async format => {
    initialize({ crlf: true, content: Buffer.from('accepted\r\n'), format })
    await prepare()
    expect((await local('inspect')).readiness).toMatchObject({
      ready: true, deliveries: [{ endpoint: 'present', commit: { oid: git('rev-parse', 'HEAD'), source: 'local_git' } }],
    })
  }, 30_000)

  it('uses builtin attributes for UTF-16LE/EOL conversion without copying the source configuration', async () => {
    initialize({
      attributes: 'src/*.txt text working-tree-encoding=UTF-16LE eol=lf\n',
      content: Buffer.from('accepted\r\n', 'utf16le'),
    })
    await prepare()
    expect((await local('inspect')).readiness).toMatchObject({ ready: true, deliveries: [{ endpoint: 'present' }] })
  }, 30_000)

  it.each([false, true])('never executes a configured clean filter (changes bytes=%s)', async changesBytes => {
    initialize()
    const marker = join(home, 'filter-ran')
    const filter = join(home, 'filter.cjs')
    writeFileSync(filter, [
      "const fs=require('node:fs');fs.writeFileSync(process.argv[2],'ran');",
      `const input=fs.readFileSync(0);process.stdout.write(${changesBytes ? "input.toString().replace('accepted','filtered')" : 'input'});`,
    ].join(''))
    const quote = (value: string) => `"${value.replaceAll('\\', '/')}"`
    git('config', 'filter.fixture.clean', `${quote(process.execPath)} ${quote(filter)} ${quote(marker)}`)
    writeFileSync(join(workspace, '.gitattributes'), 'src/*.txt filter=fixture\n')
    // Force Git to run the fixture filter at setup, never during product verification.
    writeFileSync(join(workspace, 'src/main.txt'), 'accepted filter input\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'Fixture filtered commit')
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    await prepare()
    const inspected = await local('inspect')
    expect(inspected.readiness).toMatchObject({
      ready: !changesBytes,
      deliveries: [{ endpoint: changesBytes ? 'not_observed' : 'present' }],
    })
    expect(existsSync(marker)).toBe(false)
  }, 30_000)

  it('accepts a committed deletion and makes old pre-commit acceptance stale', async () => {
    initialize()
    await prepare()
    git('rm', '--quiet', 'src/main.txt')
    git('commit', '--quiet', '-m', 'Fixture deletion')
    await capture()
    expect((await local('inspect')).readiness).toMatchObject({
      ready: false, gaps: ['acceptance:review'], deliveries: [{ endpoint: 'present' }],
    })
    await report()
    expect((await local('inspect')).readiness).toMatchObject({ ready: true })
    const closed = await local('close', {
      closure_id: 'committed', expected_revision: state().revision, mode: 'verified', acknowledged_gaps: [],
      decision: 'fixture:accepts-whole-task', note: 'Actual committed deletion', target: { kind: 'local' },
    })
    expect(closed.todo).toMatchObject({ status: 'done' })
    expect(store.listArchived()).toEqual([])
  }, 30_000)

  it('does not interpret literal file names as Git pathspec patterns', async () => {
    initialize({ crlf: true })
    writeFileSync(join(workspace, 'src/[literal].txt'), 'value\r\n')
    git('add', '--', 'src')
    git('commit', '--quiet', '-m', 'Fixture literal filename')
    await prepare()
    expect((await local('inspect')).readiness).toMatchObject({ ready: true })
  }, 30_000)

  it('does not confuse text=auto with unspecified when autocrlf is disabled', async () => {
    initialize({ attributes: 'src/*.txt text=auto\n', content: Buffer.from('accepted\r\n') })
    await prepare()
    expect((await local('inspect')).readiness).toMatchObject({
      ready: true, deliveries: [{ commit: { files: [{ comparison: 'builtin' }] } }],
    })
  }, 30_000)

  it('keeps an exact raw blob match when current text=auto would normalize it differently', async () => {
    initialize({ attributes: 'src/*.txt -text\n', content: Buffer.from('accepted\r\n') })
    writeFileSync(join(workspace, '.gitattributes'), 'src/*.txt text=auto\n')
    await prepare()
    expect((await local('inspect')).readiness).toMatchObject({
      ready: true, deliveries: [{ commit: { files: [{ comparison: 'raw' }] } }],
    })
  }, 30_000)

  it('observes effective info attributes and builtin ident conversion', async () => {
    initialize({ attributes: 'src/*.txt ident\n', content: Buffer.from('$Id$\n') })
    const blob = git('rev-parse', 'HEAD:src/main.txt')
    mkdirSync(join(workspace, '.git/info'), { recursive: true })
    writeFileSync(join(workspace, '.git/info/attributes'), 'src/*.txt ident\n')
    writeFileSync(join(workspace, 'src/main.txt'), `$Id: ${blob} $\n`)
    await prepare()
    expect((await local('inspect')).readiness).toMatchObject({
      ready: true, deliveries: [{ commit: { files: [{ comparison: 'builtin', attributes: { ident: 'set' } }] } }],
    })
  }, 30_000)

  it('does not let replace refs substitute another tree for the captured commit', async () => {
    initialize()
    const original = git('rev-parse', 'HEAD')
    writeFileSync(join(workspace, 'src/main.txt'), 'Replacement tree contents\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'Fixture replacement')
    const replacement = git('rev-parse', 'HEAD')
    git('update-ref', 'HEAD', original)
    git('replace', original, replacement)
    await prepare()
    expect((await local('inspect')).readiness).toMatchObject({
      ready: false, deliveries: [{ endpoint: 'missing', commit: { oid: original } }],
    })
  }, 30_000)

  it('does not lazy-fetch a missing promised tree or run a configured remote helper', () => {
    initialize()
    const snapshot = candidates.captureCandidate(workspace)
    const tree = git('rev-parse', 'HEAD^{tree}')
    const marker = join(home, 'remote-helper-ran')
    const helper = join(home, 'remote.cjs')
    writeFileSync(helper, "require('node:fs').writeFileSync(process.argv[2], 'ran')\n")
    git('config', 'extensions.partialClone', 'origin')
    git('config', 'remote.origin.promisor', 'true')
    git('config', 'protocol.ext.allow', 'always')
    git('config', 'remote.origin.url', `ext::${process.execPath} ${helper} ${marker}`)
    rmSync(join(workspace, '.git/objects', tree.slice(0, 2), tree.slice(2)))
    expect(observeCommitDelivery(snapshot, ['src'])).toMatchObject({ endpoint: 'not_observed' })
    expect(existsSync(marker)).toBe(false)
  }, 30_000)

  it('invalidates acceptance on actual mid-observation drift even for an optional commit endpoint', async () => {
    initialize()
    const input = plan()
    input.deliverables[0]!.required = false
    await prepare(input)
    const captureActual = candidates.captureCandidate
    let calls = 0
    vi.spyOn(candidates, 'captureCandidate').mockImplementation((root, limits) => {
      if (++calls === 2) writeFileSync(join(workspace, 'src/main.txt'), 'Changed during observation\n')
      return captureActual(root, limits)
    })
    await expect(local('inspect')).rejects.toThrow(/Candidate changed during commit delivery/)
  }, 30_000)

  it('does not turn an optional missing commit endpoint into a completion requirement', async () => {
    initialize()
    writeFileSync(join(workspace, 'src/main.txt'), 'Optional uncommitted contents\n')
    const input = plan()
    input.deliverables[0]!.required = false
    await prepare(input)
    expect((await local('inspect')).readiness).toMatchObject({
      ready: true, gaps: [], deliveries: [{ required: false, endpoint: 'missing' }],
    })
    await local('close', {
      closure_id: 'optional-commit', expected_revision: state().revision, mode: 'verified', acknowledged_gaps: [],
      decision: 'fixture:accepts-whole-task', note: 'Commit was not required', target: { kind: 'local' },
    })
    expect(store.get(0)!.status).toBe('done')
  }, 30_000)

  it('can safely stop without completing the required commit delivery', async () => {
    initialize()
    writeFileSync(join(workspace, 'src/main.txt'), 'Uncommitted contents retained\n')
    await prepare()
    await local('apply', { ...mutation(), command: {
      action: 'request_control', control_id: 'cancel', kind: 'cancel',
      decision: 'fixture:stop-incomplete-task', note: 'Retain unfinished work without committing.',
    } })
    await local('close', {
      closure_id: 'stopped-commit', expected_revision: state().revision, mode: 'stopped', acknowledged_gaps: [],
      decision: 'fixture:stop-incomplete-task', note: 'Do not commit or delete the unfinished work', target: { kind: 'local' },
    })
    expect(store.get(0)!.status).toBe('cancelled')
    expect(readFileSync(join(workspace, 'src/main.txt'), 'utf8')).toBe('Uncommitted contents retained\n')
  }, 30_000)
})
