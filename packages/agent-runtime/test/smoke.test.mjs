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

test('agent runtime package is present as a private wiring boundary', () => {
  assert.equal(packageJson.name, 'contribbot-agent-runtime')
  assert.equal(packageJson.private, true)
  assert.match(source, /PACKAGE_BOUNDARY/)
  assert.match(packageJson.scripts.build, /compile-package/)
})

test('agent runtime has no domain-package dependency or source import', async () => {
  assert.doesNotMatch(JSON.stringify(packageJson.dependencies ?? {}), /contribbot-(?:mcp|core)/)
  for (const path of await sourceFiles(resolve(directory, 'src'))) {
    const contents = await readFile(path, 'utf8')
    assert.doesNotMatch(contents, /contribbot-(?:mcp|core)/, path)
  }
})
