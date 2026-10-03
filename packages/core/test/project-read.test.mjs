import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import test from 'node:test'
import { stringify } from 'yaml'
import { loadRepoConfig } from '../dist/repository/config.js'
import { projectDirectory } from '../dist/repository/ref.js'
import { listStoredProjects, scanStoredProjects } from '../dist/repository/projects.js'
import { readTodoItems } from '../dist/todo/file-read.js'

const repository = { platform: 'gitlab', instance: 'https://code.example.invalid/gitlab', path: 'team/ui' }
const config = {
  schema_version: 3, repository, lifecycle: { status: 'active' },
  parent: { status: 'unknown' }, tracking: { status: 'pending' },
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'core-project-read-'))
  t.after(() => {
    const target = relative(tmpdir(), root)
    assert.ok(target.startsWith('core-project-read-') && !target.includes(sep))
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

function writeConfig(root, value = config) {
  const directory = projectDirectory(value.repository, root)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'config.yaml'), stringify(value))
  return directory
}

test('Core reads config and Todo data without initializing or rewriting files', t => {
  const root = fixture(t)
  const missing = join(root, 'missing')
  assert.equal(loadRepoConfig(missing), null)
  assert.equal(listStoredProjects(missing), null)
  assert.deepEqual(scanStoredProjects(missing), { projects: [], problems: [] })
  assert.deepEqual(readTodoItems(missing), [])
  assert.equal(existsSync(missing), false)
  const directory = writeConfig(root)
  const file = join(directory, 'config.yaml')
  const before = readFileSync(file, 'utf8')
  assert.deepEqual(loadRepoConfig(directory), config)
  assert.deepEqual(scanStoredProjects(root).projects, [{ directory, config }])
  assert.deepEqual(readTodoItems(directory), [])
  assert.deepEqual(readdirSync(directory), ['config.yaml'])
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('batch scanning retains healthy siblings and strict scanning rejects bad configs', t => {
  const root = fixture(t)
  const directory = writeConfig(root)
  const bad = writeConfig(root, { ...config, repository: { ...repository, path: 'team/bad' }, extra: true })
  const missing = projectDirectory({ ...repository, path: 'team/missing' }, root)
  mkdirSync(missing)
  const scan = scanStoredProjects(root)
  assert.deepEqual(scan.projects, [{ directory, config }])
  assert.deepEqual(scan.problems.map(item => item.code).sort(), ['config_invalid', 'config_missing'])
  assert.throws(() => listStoredProjects(root), /schema v3/)
  assert.equal(JSON.parse(JSON.stringify(scan)).problems.length, 2)
  assert.ok(readFileSync(join(bad, 'config.yaml'), 'utf8').includes('extra: true'))
})

test('root corruption fails instead of becoming an empty project list', t => {
  const root = fixture(t)
  mkdirSync(join(root, 'projects', 'v1'), { recursive: true })
  writeFileSync(join(root, 'projects', 'v1', 'unexpected'), 'not a project')
  for (const read of [listStoredProjects, scanStoredProjects]) {
    assert.throws(() => read(root), /Invalid schema v3 project directory/)
  }
})

test('config identity must match digest and old schemas never get converted', t => {
  const root = fixture(t)
  const directory = writeConfig(root)
  const file = join(directory, 'config.yaml')
  for (const value of [
    { ...config, repository: { ...repository, instance: 'https://other.example.invalid' } },
    { repository: 'owner/repo', role: 'admin' },
  ]) {
    const before = stringify(value)
    writeFileSync(file, before)
    assert.throws(() => loadRepoConfig(directory), /identity does not match|Invalid schema v3/)
    assert.equal(readFileSync(file, 'utf8'), before)
  }
})

test('shared config parser rejects duplicate keys, merge keys and custom tags', t => {
  const root = fixture(t)
  const directory = writeConfig(root)
  const file = join(directory, 'config.yaml')
  for (const content of [
    `${stringify(config)}schema_version: 3\n`,
    `${stringify(config)}<<: {unexpected: true}\n`,
    stringify(config).replace('schema_version: 3', 'schema_version: !custom 3'),
  ]) {
    writeFileSync(file, content)
    assert.throws(() => loadRepoConfig(directory), /Invalid schema v3/)
    assert.equal(readFileSync(file, 'utf8'), content)
  }
})

test('config loading and scanning reject linked ancestors', t => {
  const root = fixture(t)
  const real = join(root, 'real')
  const linked = join(root, 'linked')
  const directory = writeConfig(real)
  try { symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('Symlink creation unavailable')
    throw error
  }
  assert.throws(() => loadRepoConfig(join(linked, relative(real, directory))), /symbolic link/)
  assert.throws(() => scanStoredProjects(linked), /symbolic link/)
})

test('Todo list uses existing lifecycle and duplicate-ID validation without writes', t => {
  const root = fixture(t)
  const file = join(root, 'todos.yaml')
  const states = ['idea', 'backlog', 'active', 'paused', 'done', 'cancelled']
  writeFileSync(file, stringify({ todos: states.map(status => ({ title: status, status })) }))
  assert.deepEqual(readTodoItems(root).map(item => item.status), states)
  for (const todos of [
    [{ title: 'Old state', status: 'pr_submitted' }],
    [{ id: 'same', status: 'active' }, { id: 'same', status: 'done' }],
  ]) {
    const content = stringify({ todos })
    writeFileSync(file, content)
    assert.throws(() => readTodoItems(root), /Unsupported Todo status|Duplicate todo id/)
    assert.equal(readFileSync(file, 'utf8'), content)
  }
})
