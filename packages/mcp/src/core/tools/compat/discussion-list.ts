import { graphql, parseRepo } from '../../clients/github.js'
import { relativeTime, truncate } from '../../utils/format.js'

interface DiscussionsData {
  repository: {
    discussions: {
      nodes: Array<{
        number: number
        title: string
        url: string
        createdAt: string
        updatedAt: string
        author: { login: string } | null
        category: { name: string }
        comments: { totalCount: number }
        answerChosenAt: string | null
        upvoteCount: number
      }>
    }
  }
}

interface DiscussionDetailData {
  repository: {
    discussion: {
      number: number
      title: string
      url: string
      body: string
      createdAt: string
      author: { login: string } | null
      category: { name: string }
      upvoteCount: number
      answerChosenAt: string | null
      comments: {
        nodes: Array<{
          author: { login: string } | null
          body: string
          createdAt: string
          upvoteCount: number
          isAnswer: boolean
        }>
      }
    }
  }
}

export async function discussionList(repo?: string, category?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const query = `
    query($owner: String!, $repo: String!, $first: Int!) {
      repository(owner: $owner, name: $repo) {
        discussions(first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes {
            number
            title
            url
            createdAt
            updatedAt
            author { login }
            category { name }
            comments { totalCount }
            answerChosenAt
            upvoteCount
          }
        }
      }
    }
  `

  let data: DiscussionsData
  try {
    data = await graphql<DiscussionsData>(query, { owner, repo: name, first: 20 })
  }
  catch (e) {
    return `Error fetching discussions: ${e instanceof Error ? e.message : String(e)}`
  }

  let nodes = data.repository.discussions.nodes
  if (category) {
    nodes = nodes.filter(d => d.category.name.toLowerCase().includes(category.toLowerCase()))
  }

  if (nodes.length === 0) {
    return `## Discussions — ${owner}/${name}\n\n_No discussions found._`
  }

  const lines = [
    `## Discussions — ${owner}/${name}`,
    `> ${nodes.length} discussions`,
    '',
    `| # | Category | Title | Author | Comments | Updated |`,
    `| --- | --- | --- | --- | --- | --- |`,
    ...nodes.map(d => [
      `| #${d.number}`,
      d.category.name,
      (d.answerChosenAt ? '✅ ' : '') + truncate(d.title, 50),
      `@${d.author?.login ?? '?'}`,
      String(d.comments.totalCount),
      `${relativeTime(d.updatedAt)} |`,
    ].join(' | ')),
  ]

  return lines.join('\n')
}

export async function discussionDetail(discussionNumber: number, repo?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)

  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        discussion(number: $number) {
          number
          title
          url
          body
          createdAt
          author { login }
          category { name }
          upvoteCount
          answerChosenAt
          comments(first: 20) {
            nodes {
              author { login }
              body
              createdAt
              upvoteCount
              isAnswer
            }
          }
        }
      }
    }
  `

  let data: DiscussionDetailData
  try {
    data = await graphql<DiscussionDetailData>(query, { owner, repo: name, number: discussionNumber })
  }
  catch (e) {
    return `Error fetching discussion: ${e instanceof Error ? e.message : String(e)}`
  }

  const d = data.repository.discussion
  const lines = [
    `## Discussion #${d.number}: ${d.title}`,
    `> ${d.category.name} · @${d.author?.login ?? '?'} · ${relativeTime(d.createdAt)}${d.answerChosenAt ? ' · ✅ Answered' : ''}`,
    '',
    d.body,
    '',
    `---`,
    `### Comments (${d.comments.nodes.length})`,
    '',
  ]

  for (const c of d.comments.nodes) {
    lines.push(`**@${c.author?.login ?? '?'}** · ${relativeTime(c.createdAt)}${c.isAnswer ? ' ✅ Answer' : ''}`)
    lines.push(truncate(c.body, 300))
    lines.push('')
  }

  return lines.join('\n')
}
