import { parseRepo, updatePull } from '../clients/github.js'

export async function prUpdate(
  prNumber: number,
  fields: { title?: string; body?: string; state?: string; draft?: boolean },
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)

  await updatePull(owner, name, prNumber, fields)

  const changes: string[] = []
  if (fields.title) changes.push(`title → "${fields.title}"`)
  if (fields.body) changes.push(`body updated`)
  if (fields.state) changes.push(`state → ${fields.state}`)
  if (fields.draft !== undefined) changes.push(`draft → ${fields.draft}`)

  return `Updated **${owner}/${name}#${prNumber}**: ${changes.join(', ')}`
}
