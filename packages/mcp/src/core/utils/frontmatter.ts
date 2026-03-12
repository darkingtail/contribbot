export interface FrontmatterMeta {
  name: string
  description: string
}

export function parseFrontmatter(content: string): FrontmatterMeta {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return { name: '', description: '' }
  const fm = match[1] ?? ''
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ''
  return { name, description }
}
