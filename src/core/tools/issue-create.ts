import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseRepo, createIssue } from '../clients/github.js'
import { TodoStore } from '../storage/todo-store.js'
import { UpstreamStore } from '../storage/upstream-store.js'

function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contribbot', owner, name)
}

function detectTypeFromLabels(labels: string[]): 'bug' | 'feature' | 'docs' | 'chore' {
  const lower = labels.map(l => l.toLowerCase())
  if (lower.some(l => l.includes('bug'))) return 'bug'
  if (lower.some(l => l.includes('feature') || l.includes('enhancement'))) return 'feature'
  if (lower.some(l => l.includes('doc'))) return 'docs'
  return 'chore'
}

export async function issueCreate(
  title: string,
  body?: string,
  labels?: string,
  upstreamSha?: string,
  upstreamRepo?: string,
  autoTodo?: boolean,
  repo?: string,
): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const contribDir = getContribDir(owner, name)

  const labelList = labels ? labels.split(',').map(l => l.trim()).filter(Boolean) : undefined
  const issue = await createIssue(owner, name, title, body, labelList)

  const results: string[] = [
    `Created **${owner}/${name}#${issue.number}**: ${issue.html_url}`,
  ]

  // Link to upstream daily commit if provided
  if (upstreamSha && upstreamRepo) {
    const { owner: upOwner, name: upName } = parseRepo(upstreamRepo)
    const store = new UpstreamStore(contribDir)
    const daily = store.getDaily(`${upOwner}/${upName}`)
    const commit = daily.commits.find(c => c.sha === upstreamSha || c.sha.startsWith(upstreamSha))
    if (commit) {
      store.updateDailyCommit(`${upOwner}/${upName}`, commit.sha, {
        action: 'issue',
        ref: `#${issue.number}`,
      })
      results.push(`Linked upstream commit ${upstreamSha.slice(0, 7)} → #${issue.number}`)
    }
  }

  // Auto-create todo
  if (autoTodo !== false) {
    const todoStore = new TodoStore(contribDir)
    const type = labelList ? detectTypeFromLabels(labelList) : 'chore'
    todoStore.add({ ref: `#${issue.number}`, title, type })
    results.push(`Created todo: #${issue.number}`)
  }

  return results.join('\n')
}
