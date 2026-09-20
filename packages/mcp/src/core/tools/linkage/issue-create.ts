import { parseRepo, createIssue } from '../../clients/github.js'
import { RecordFiles } from '../../storage/record-files.js'
import { TodoStore } from '../../storage/todo-store.js'
import { UpstreamStore } from '../../storage/upstream-store.js'
import { getContribDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { todayDate } from '../../utils/format.js'
import { detectTypeFromLabels } from '../../utils/github-helpers.js'

export async function issueCreate(
  title: string,
  body?: string,
  labels?: string,
  upstreamSha?: string,
  upstreamRepo?: string,
  autoTodo?: boolean,
  repo?: string,
): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const contribDir = getContribDir(owner, name)

  const labelList = labels ? labels.split(',').map(l => l.trim()).filter(Boolean) : undefined
  const issue = await createIssue(owner, name, title, body, labelList)

  const results: string[] = [
    `Created **${owner}/${name}#${issue.number}**: ${issue.html_url}`,
  ]

  try {
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
      const todo = todoStore.transaction(() => {
        const todo = todoStore.add({ ref: `#${issue.number}`, title, type })
        const records = new RecordFiles(contribDir)
        records.createTodoRecord(`#${issue.number}`, title, type, todayDate(), todo.id)
        return todo
      })
      results.push(`Created todo: #${issue.number} · Todo ID: \`${todo.id}\``)
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const recovery: string[] = []
    if (autoTodo !== false) {
      recovery.push(`todo_add(text=${JSON.stringify(title)}, ref="#${issue.number}", repo="${owner}/${name}")`)
    }
    if (upstreamSha && upstreamRepo) {
      recovery.push(
        `upstream_daily_act(upstream_repo="${upstreamRepo}", sha="${upstreamSha}", action="issue", ref="#${issue.number}", repo="${owner}/${name}")`,
      )
    }
    throw new Error(
      `GitHub issue ${owner}/${name}#${issue.number} was created successfully at ${issue.html_url}, but local contribbot reconciliation failed: ${message}. `
      + `Do not create another issue.${recovery.length > 0 ? ` Recover with ${recovery.join(' and then ')}.` : ''}`,
    )
  }

  return results.join('\n')
}
