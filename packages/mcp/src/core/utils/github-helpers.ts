import type { TodoType } from '../enums.js'

export function detectTypeFromLabels(labels: Array<{ name: string } | string>): TodoType {
  const names = labels.map(l => (typeof l === 'string' ? l : l.name).toLowerCase())
  if (names.some(n => n.includes('bug'))) return 'bug'
  if (names.some(n => n.includes('feature') || n.includes('enhancement'))) return 'feature'
  if (names.some(n => n.includes('doc'))) return 'docs'
  return 'chore'
}
