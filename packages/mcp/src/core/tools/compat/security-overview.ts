import { ghApi, parseRepo } from '../../clients/github.js'
import { markdownTable } from '../../utils/format.js'

interface DependabotAlert {
  number: number
  state: string
  severity: string
  dependency: { package: { name: string }, manifest_path: string }
  security_advisory: { summary: string }
  html_url: string
}

interface CodeScanAlert {
  number: number
  state: string
  rule: { severity: string, description: string }
  most_recent_instance: { location: { path: string } }
  html_url: string
}

export async function securityOverview(repo?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const [dependabotResult, codeScanResult] = await Promise.allSettled([
    ghApi<DependabotAlert[]>(`/repos/${owner}/${name}/dependabot/alerts`, { state: 'open', per_page: 30 }),
    ghApi<CodeScanAlert[]>(`/repos/${owner}/${name}/code-scanning/alerts`, { state: 'open', per_page: 30 }),
  ])

  const lines = [
    `## Security Overview — ${owner}/${name}`,
    '',
  ]

  // Dependabot
  if (dependabotResult.status === 'fulfilled') {
    const alerts = dependabotResult.value
    if (alerts.length === 0) {
      lines.push('### Dependabot\n✅ No open alerts')
    }
    else {
      const bySeverity = new Map<string, number>()
      for (const a of alerts) bySeverity.set(a.severity, (bySeverity.get(a.severity) ?? 0) + 1)
      lines.push(`### Dependabot (${alerts.length} open)`)
      lines.push([...bySeverity.entries()].map(([s, c]) => `**${s}**: ${c}`).join(' · '))
      lines.push('')
      const headers = ['#', 'Severity', 'Package', 'Summary']
      const rows = alerts.slice(0, 10).map(a => [
        String(a.number),
        a.severity,
        a.dependency.package.name,
        a.security_advisory.summary.slice(0, 60),
      ])
      lines.push(markdownTable(headers, rows))
    }
  }
  else {
    lines.push('### Dependabot\n_Not available (requires write access or feature not enabled)_')
  }

  lines.push('')

  // Code scanning
  if (codeScanResult.status === 'fulfilled') {
    const alerts = codeScanResult.value
    if (alerts.length === 0) {
      lines.push('### Code Scanning\n✅ No open alerts')
    }
    else {
      lines.push(`### Code Scanning (${alerts.length} open)`)
      const headers = ['#', 'Severity', 'File', 'Rule']
      const rows = alerts.slice(0, 10).map(a => [
        String(a.number),
        a.rule.severity,
        a.most_recent_instance.location.path,
        a.rule.description.slice(0, 50),
      ])
      lines.push(markdownTable(headers, rows))
    }
  }
  else {
    lines.push('### Code Scanning\n_Not available (feature not enabled)_')
  }

  return lines.join('\n')
}
