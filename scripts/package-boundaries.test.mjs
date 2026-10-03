import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ts = createRequire(resolve(root, 'packages/mcp/package.json'))('typescript')
const packages = new Map(readdirSync(resolve(root, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name !== 'agent')
  .map(entry => {
    const directory = resolve(root, 'packages', entry.name)
    const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
    return [manifest.name, { directory, manifest }]
  }))

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    if (['__fixtures__', 'test', 'node_modules', 'dist'].includes(entry.name)) return []
    if (entry.isDirectory()) return sources(path)
    return /\.(?:ts|mjs|js)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : []
  })
}

function imports(text, file = 'fixture.ts') {
  const values = []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)) values.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) values.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return values
}

function packageForImport(specifier, file) {
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(file), specifier)
    return [...packages].find(([, value]) => {
      const path = relative(value.directory, target)
      return path !== '..' && !path.startsWith('../') && !path.startsWith('..\\')
        && !/^(?:[A-Za-z]:|\/)/.test(path)
    })?.[0]
  }
  return [...packages.keys()].find(name => specifier === name || specifier.startsWith(`${name}/`))
}

function graph(fromSources) {
  return new Map([...packages].map(([name, { directory, manifest }]) => {
    const edges = new Set(Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.devDependencies })
      .filter(dependency => packages.has(dependency)))
    if (fromSources) {
      for (const file of sources(name === 'contribbot-web' ? directory : resolve(directory, 'src'))) {
        for (const specifier of imports(readFileSync(file, 'utf8'), file)) {
          const target = packageForImport(specifier, file)
          if (target && target !== name) edges.add(target)
        }
      }
    }
    return [name, edges]
  }))
}

function dependencyPath(graph, from, forbidden, path = []) {
  if (path.includes(from)) return null
  const next = [...path, from]
  if (forbidden.has(from)) return next
  for (const target of graph.get(from) ?? []) {
    const found = dependencyPath(graph, target, forbidden, next)
    if (found) return found
  }
  return null
}

test('boundary parser covers static, type, re-export, dynamic and require imports', () => {
  assert.deepEqual(imports(`
    import type { T } from 'type-dependency';
    export { T } from 'export-dependency';
    import 'side-effect';
    await import('dynamic-dependency');
    require('require-dependency');
    const example = "import('not-an-import')";
  `), ['type-dependency', 'export-dependency', 'side-effect', 'dynamic-dependency', 'require-dependency'])
  const edges = new Map([['mcp', new Set(['adapter'])], ['adapter', new Set(['runtime'])]])
  assert.deepEqual(dependencyPath(edges, 'mcp', new Set(['runtime'])), ['mcp', 'adapter', 'runtime'])
})

for (const [name, forbidden] of [
  ['contribbot-mcp', ['contribbot-runner', 'contribbot-agent-runtime']],
  ['contribbot-core', ['contribbot-mcp', 'contribbot-runner', 'contribbot-agent-runtime']],
  ['contribbot-agent-runtime', ['contribbot-mcp', 'contribbot-core', 'contribbot-runner']],
  ['contribbot-runner', ['contribbot-mcp']],
  ['contribbot-web', ['contribbot-mcp', 'contribbot-runner', 'contribbot-agent-runtime']],
  ['contribbot-platform', ['contribbot-mcp', 'contribbot-core', 'contribbot-runner', 'contribbot-agent-runtime']],
]) {
  test(`${name} obeys the approved transitive manifest and source boundaries`, () => {
    for (const sourceGraph of [false, true]) {
      const violation = dependencyPath(graph(sourceGraph), name, new Set(forbidden))
      assert.equal(violation, null, `${sourceGraph ? 'source + manifest' : 'manifest'}: ${violation?.join(' -> ')}`)
    }
  })
}

test('Web uses only explicit Core read subpaths', () => {
  const { directory } = packages.get('contribbot-web')
  const allowed = new Set([
    'contribbot-core/repository/ref', 'contribbot-core/repository/projects',
    'contribbot-core/todo/file-read', 'contribbot-core/storage/paths',
  ])
  for (const file of sources(directory)) {
    for (const specifier of imports(readFileSync(file, 'utf8'), file)) {
      if (packageForImport(specifier, file) === 'contribbot-core') {
        assert.ok(allowed.has(specifier), `${file}: ${specifier}`)
      }
    }
  }
})

test('Core imports platform structural types, never the OS implementation', () => {
  for (const file of sources(resolve(root, 'packages/core/src'))) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const node of source.statements) {
      if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier
        || !ts.isStringLiteralLike(node.moduleSpecifier)
        || !node.moduleSpecifier.text.startsWith('contribbot-platform')) continue
      assert.equal(node.moduleSpecifier.text, 'contribbot-platform/types', file)
      assert.equal(ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly, true, file)
    }
  }
})

test('Runner tests are executable without building or importing the MCP service', () => {
  const { directory, manifest } = packages.get('contribbot-runner')
  assert.doesNotMatch(manifest.scripts.test, /contribbot-mcp/)
  for (const entry of readdirSync(resolve(directory, 'test'))) {
    if (!entry.endsWith('.mjs')) continue
    const file = resolve(directory, 'test', entry)
    for (const specifier of imports(readFileSync(file, 'utf8'), file)) {
      assert.notEqual(packageForImport(specifier, file), 'contribbot-mcp', file)
    }
  }
})

test('Runner composes domain requests without selecting native Provider mechanics', () => {
  for (const file of sources(resolve(root, 'packages/runner/src'))) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /['"](?:claude|codex)['"]/, file)
    assert.doesNotMatch(source, /\b(?:nativeBindings|advisorEnvironment|probeCodexReadonly|mkdtempSync)\b/, file)
  }
})
