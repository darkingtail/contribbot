import { createIssue } from '../../clients/github.js'
import { RecordFiles } from '../../storage/record-files.js'
import { TodoStore } from '../../storage/todo-store.js'
import { UpstreamStore } from '../../storage/upstream-store.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { repositoryRefSchema, type RepositoryInput, type RepositoryRef } from '../../utils/repository-ref.js'
import { todayDate } from '../../utils/format.js'
import { detectTypeFromLabels } from '../../utils/github-helpers.js'

export async function issueCreate(
  title: string,
  body?: string,
  labels?: string,
  upstreamSha?: string,
  upstreamRepo?: RepositoryRef,
  autoTodo?: boolean,
  repo?: RepositoryInput,
): Promise<string> {
  const source = upstreamRepo === undefined ? undefined : repositoryRefSchema.parse(upstreamRepo)
  const { owner, name, directory: contribDir, repository } = await resolveRepo(repo)
  if (repository.platform !== 'github' || repository.instance !== 'https://github.com') {
    throw new Error('issue_create supports GitHub.com repositories only; no remote changes were attempted.')
  }

  const labelList = labels ? labels.split(',').map(l => l.trim()).filter(Boolean) : undefined
  const issue = await createIssue(owner, name, title, body, labelList)

  const results: string[] = [
    `Created **${owner}/${name}#${issue.number}**: ${issue.html_url}`,
  ]

  try {
    // Link to upstream daily commit if provided
    if (upstreamSha && source) {
      const store = new UpstreamStore(contribDir)
      const daily = store.getDaily(source)
      const commit = daily.commits.find(c => c.sha === upstreamSha || c.sha.startsWith(upstreamSha))
      if (commit) {
        store.updateDailyCommit(source, commit.sha, {
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
      recovery.push(`todo_add(text=${JSON.stringify(title)}, ref="#${issue.number}", repo=${JSON.stringify(repository)})`)
    }
    if (upstreamSha && source) {
      recovery.push(
        `upstream_daily_act(upstream_repo=${JSON.stringify(source)}, sha=${JSON.stringify(upstreamSha)}, action="issue", ref="#${issue.number}", repo=${JSON.stringify(repository)})`,
      )
    }
    throw new Error(
      `GitHub issue ${owner}/${name}#${issue.number} was created successfully at ${issue.html_url}, but local contribbot reconciliation failed: ${message}. `
      + `Do not create another issue.${recovery.length > 0 ? ` Recover with ${recovery.join(' and then ')}.` : ''}`,
    )
  }

  return results.join('\n')
}
