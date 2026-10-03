import { parseRepo, createComment } from '../../clients/github.js'
import type { RepositoryInput } from '../../utils/repository-ref.js'

export async function commentCreate(
  number: number,
  body: string,
  repo?: RepositoryInput,
): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const comment = await createComment(owner, name, number, body)
  return `Commented on **${owner}/${name}#${number}**: ${comment.html_url ?? 'success'}`
}
