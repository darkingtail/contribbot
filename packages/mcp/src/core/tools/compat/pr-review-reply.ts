import { parseRepo, replyToReviewComment } from '../../clients/github.js'
import type { RepositoryInput } from '../../utils/repository-ref.js'

export async function prReviewReply(
  prNumber: number,
  commentId: number,
  body: string,
  repo?: RepositoryInput,
): Promise<string> {
  const { owner, name } = parseRepo(repo)
  await replyToReviewComment(owner, name, prNumber, commentId, body)
  return `Replied to review comment ${commentId} on **${owner}/${name}#${prNumber}**`
}
