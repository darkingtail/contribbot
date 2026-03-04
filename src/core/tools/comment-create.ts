import { parseRepo, createComment } from '../clients/github.js'

export async function commentCreate(
  number: number,
  body: string,
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const comment = await createComment(owner, name, number, body)
  return `Commented on **${owner}/${name}#${number}**: ${comment.html_url ?? 'success'}`
}
