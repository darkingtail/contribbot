import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getProjectRoot } from '../utils/config.js'
import { markdownTable } from '../utils/format.js'
import { getBatchLatestVersions } from '../clients/npm-registry.js'

interface VcDep {
  name: string
  catalogRange: string
  npmLatest: string | null
  hasUpdate: boolean
}

function parseWorkspaceVcCatalog(rootDir: string): Map<string, string> {
  const wsPath = join(rootDir, 'pnpm-workspace.yaml')
  if (!existsSync(wsPath)) return new Map()

  const content = readFileSync(wsPath, 'utf-8')
  const deps = new Map<string, string>()

  // Simple YAML parsing for catalog:vc section
  const lines = content.split('\n')
  let inVcSection = false

  for (const line of lines) {
    // Detect vc: section under catalogs:
    if (/^\s{2}vc:/.test(line)) {
      inVcSection = true
      continue
    }
    // Exit vc section when indentation decreases
    if (inVcSection && /^\s{0,2}\S/.test(line) && !/^\s{4}/.test(line)) {
      inVcSection = false
      continue
    }
    if (inVcSection) {
      const match = line.match(/^\s+'(@v-c\/[^']+)':\s*(.+)/)
      if (match) {
        deps.set(match[1], match[2].trim())
      }
    }
  }

  return deps
}

function stripRange(version: string): string {
  return version.replace(/^[\^~>=<]+/, '')
}

function isNewer(latest: string, current: string): boolean {
  const latestParts = latest.split('.').map(Number)
  const currentParts = stripRange(current).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((latestParts[i] ?? 0) > (currentParts[i] ?? 0)) return true
    if ((latestParts[i] ?? 0) < (currentParts[i] ?? 0)) return false
  }
  return false
}

export async function vcDependencyStatus(component?: string, projectRoot?: string): Promise<string> {
  const rootDir = getProjectRoot(projectRoot)
  const vcDeps = parseWorkspaceVcCatalog(rootDir)

  if (vcDeps.size === 0) {
    return 'Error: Could not find @v-c/* dependencies in pnpm-workspace.yaml'
  }

  let entries = Array.from(vcDeps.entries())
  if (component) {
    entries = entries.filter(([name]) => name.includes(component))
  }

  const names = entries.map(([name]) => name)
  const latestVersions = await getBatchLatestVersions(names)

  const results: VcDep[] = entries.map(([name, range]) => {
    const npmLatest = latestVersions.get(name) ?? null
    const hasUpdate = npmLatest !== null && isNewer(npmLatest, range)
    return { name, catalogRange: range, npmLatest, hasUpdate }
  })

  const updatable = results.filter(r => r.hasUpdate)

  const lines: string[] = [
    `## @v-c/* Dependency Status`,
    '',
    `**Total**: ${results.length} packages | **Updates available**: ${updatable.length}`,
    '',
  ]

  const headers = ['Package', 'Catalog Range', 'npm Latest', 'Status']
  const rows = results.map(r => [
    r.name,
    r.catalogRange,
    r.npmLatest ?? 'N/A',
    r.hasUpdate ? '⬆️ Update' : '✅ OK',
  ])

  lines.push(markdownTable(headers, rows))

  if (updatable.length > 0) {
    lines.push('')
    lines.push(`### Packages with available updates`)
    for (const dep of updatable) {
      lines.push(`- **${dep.name}**: ${dep.catalogRange} → ${dep.npmLatest}`)
    }
  }

  return lines.join('\n')
}
