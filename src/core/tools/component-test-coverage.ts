import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getComponentsDir } from '../utils/config.js'
import { markdownTable } from '../utils/format.js'

// Directories that are not components
const EXCLUDED_DIRS = new Set(['_util', 'style', 'locale', 'theme', 'version', 'config-provider'])

interface ComponentTestInfo {
  name: string
  hasTests: boolean
  testFileCount: number
  hasUnitTest: boolean
  hasSemanticTest: boolean
  hasDemoTest: boolean
}

function scanComponent(componentsDir: string, name: string, testsSubdir: string): ComponentTestInfo {
  const testsDir = join(componentsDir, name, testsSubdir)
  const hasTests = existsSync(testsDir)

  if (!hasTests) {
    return { name, hasTests: false, testFileCount: 0, hasUnitTest: false, hasSemanticTest: false, hasDemoTest: false }
  }

  const files = readdirSync(testsDir).filter(f => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))
  const hasSemanticTest = files.some(f => f.toLowerCase().includes('semantic'))
  const hasDemoTest = files.some(f => f.toLowerCase().includes('demo'))
  const hasUnitTest = files.some(f => !f.toLowerCase().includes('semantic') && !f.toLowerCase().includes('demo'))

  return {
    name,
    hasTests: true,
    testFileCount: files.length,
    hasUnitTest,
    hasSemanticTest,
    hasDemoTest,
  }
}

export async function componentTestCoverage(component?: string, projectRoot?: string, componentsDir?: string, testsSubdir = 'tests'): Promise<string> {
  const resolvedComponentsDir = componentsDir
    ? resolve(componentsDir)
    : getComponentsDir(projectRoot)

  if (!existsSync(resolvedComponentsDir)) {
    return `Error: Components directory not found at ${resolvedComponentsDir}`
  }

  let components: string[]
  if (component) {
    components = [component]
  }
  else {
    components = readdirSync(resolvedComponentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !EXCLUDED_DIRS.has(d.name))
      .map(d => d.name)
      .sort()
  }

  const results = components.map(name => scanComponent(resolvedComponentsDir, name, testsSubdir))

  const total = results.length
  const withTests = results.filter(r => r.hasTests).length
  const withUnit = results.filter(r => r.hasUnitTest).length
  const withSemantic = results.filter(r => r.hasSemanticTest).length
  const withDemo = results.filter(r => r.hasDemoTest).length

  const lines: string[] = [
    `## Component Test Coverage`,
    '',
    `**Total**: ${total} components | **With tests**: ${withTests} (${Math.round(withTests / total * 100)}%) | **Unit**: ${withUnit} | **Semantic**: ${withSemantic} | **Demo**: ${withDemo}`,
    '',
  ]

  const icon = (v: boolean) => v ? '✅' : '❌'

  const headers = ['Component', 'Tests', 'Files', 'Unit', 'Semantic', 'Demo']
  const rows = results.map(r => [
    r.name,
    icon(r.hasTests),
    String(r.testFileCount),
    icon(r.hasUnitTest),
    icon(r.hasSemanticTest),
    icon(r.hasDemoTest),
  ])

  lines.push(markdownTable(headers, rows))

  // List components without tests
  const missing = results.filter(r => !r.hasTests)
  if (missing.length > 0) {
    lines.push('')
    lines.push(`### Components without tests (${missing.length})`)
    lines.push(missing.map(r => `- ${r.name}`).join('\n'))
  }

  return lines.join('\n')
}
