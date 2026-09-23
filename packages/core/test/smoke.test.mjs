import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
const source = await readFile(resolve(directory, 'src/index.ts'), 'utf8')

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.isFile() && path.endsWith('.ts')) files.push(path)
  }
  return files
}

test('core package is present as a private wiring boundary', () => {
  assert.equal(packageJson.name, 'contribbot-core')
  assert.equal(packageJson.private, true)
  assert.match(source, /PACKAGE_BOUNDARY/)
  assert.match(packageJson.scripts.build, /compile-package/)
})

test('core exposes separate pure Todo and Consult port contracts', async () => {
  const todoPort = await readFile(resolve(directory, 'src/todo/read-port.ts'), 'utf8')
  const consultPort = await readFile(resolve(directory, 'src/consult/transaction-port.ts'), 'utf8')

  assert.match(source, /\.\/todo\/read-port\.js/)
  assert.match(source, /\.\/consult\/transaction-port\.js/)
  assert.match(todoPort, /interface TodoReadPort/)
  assert.match(consultPort, /interface SynchronousTransactionPort/)
  assert.doesNotMatch(`${todoPort}\n${consultPort}`, /from ['"]node:/)
  assert.doesNotMatch(todoPort, /\b(?:write|update|save|delete|archive|complete|cancel)\s*\(/)
})

test('core cannot acquire dependencies on MCP or runtime wiring packages', async () => {
  const packageDependencies = JSON.stringify(packageJson.dependencies ?? {})
  assert.doesNotMatch(packageDependencies, /contribbot-(?:mcp|runner|agent-runtime)/)
  for (const path of await sourceFiles(resolve(directory, 'src'))) {
    const contents = await readFile(path, 'utf8')
    assert.doesNotMatch(contents, /contribbot-(?:mcp|runner|agent-runtime)/, path)
  }
})

test('core exposes domain recovery but cannot orchestrate an advisor', async () => {
  const core = await import('../dist/index.js')
  assert.equal(core.runConsultTurn, undefined)
  assert.equal(typeof core.recoverConsultTurn, 'function')
  assert.deepEqual(core.failedResult('before dispatch').unresolved, [])
  assert.match(core.failedResult('after dispatch', '2026-09-23T00:00:00.000Z').unresolved[0], /Dispatch started/)
})

test('core exposes a read-only Todo projection without creating or mutating storage', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const yaml = await import('yaml')
  const core = await import('../dist/index.js')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contribbot-core-todo-read-'))
  try {
    fs.writeFileSync(path.join(directory, 'todos.yaml'), yaml.stringify({ todos: [{
      id: 't-active', status: 'active', lifecycle_revision: 3,
      executions: [{ id: 'execution-1', goal: 'goal', phase: 'execute', next: 'next',
        closed_at: null, opened_at: '2026-09-23T00:00:00.000Z' }],
    }] }))
    const before = fs.readFileSync(path.join(directory, 'todos.yaml'))
    expectModel(core.readTodoModel(directory, 't-active'), {
      id: 't-active', lifecycleRevision: 3, status: 'active', pendingTransition: false,
      execution: { id: 'execution-1', hasActiveControl: false, confirmedPlan: null },
    })
    assert.equal(core.readTodoModel(directory, 'missing'), null)
    assert.deepEqual(fs.readFileSync(path.join(directory, 'todos.yaml')), before)
  }
  finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('core Todo projection reads archived records and rejects unsupported lifecycle values', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const yaml = await import('yaml')
  const core = await import('../dist/index.js')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contribbot-core-todo-archive-'))
  try {
    fs.writeFileSync(path.join(directory, 'todos.archive.yaml'), yaml.stringify({ todos: [{
      id: 't-archived', status: 'done', archived: '2026-09-23', executions: [],
    }] }))
    assert.equal(core.readTodoModel(directory, 't-archived')?.status, 'done')
    fs.writeFileSync(path.join(directory, 'todos.yaml'), yaml.stringify({ todos: [{ id: 't-bad', status: 'pr_submitted' }] }))
    assert.throws(() => core.readTodoModel(directory, 't-bad'), /Unsupported Todo status|Invalid enum value/i)
  }
  finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

function expectModel(actual, expected) {
  assert.deepEqual(actual, expected)
}
