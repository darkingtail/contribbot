import { parseRepo, replyToReviewComment } from '../../clients/github.js'

export async function prReviewReply(
  prNumber: number,
  commentId: number,
  body: string,
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)
  await replyToReviewComment(owner, name, prNumber, commentId, body)
  return `Replied to review comment ${commentId} on **${owner}/${name}#${prNumber}**`
}
