export function todayDate(): string {
  const d = new Date()
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function markdownTable(headers: string[], rows: string[][]): string {
  const escape = (s: string) => s.replace(/\|/g, '\\|')
  const separator = headers.map(() => '---')
  const lines = [
    `| ${headers.map(escape).join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.map(row => `| ${row.map(escape).join(' | ')} |`),
  ]
  return lines.join('\n')
}

export function truncate(str: string, maxLen: number): string {
  if (maxLen < 4) return str.slice(0, maxLen)
  if (str.length <= maxLen) return str
  return `${str.slice(0, maxLen - 3)}...`
}

export function relativeTime(date: string | Date): string {
  const now = Date.now()
  const then = new Date(date).getTime()
  const diff = now - then
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  return 'just now'
}
