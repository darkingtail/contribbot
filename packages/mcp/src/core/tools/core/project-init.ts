import { projectList } from './project-list.js'
import { getOrInitConfig, renderRepoConfig } from './repo-config-tool.js'
import { trackingStatus, type RepoConfigData } from '../../storage/repo-config.js'
import { repositoryDisplay, type RepositoryInput, type RepositoryRef } from '../../utils/repository-ref.js'
import { TodoStore, currentTodoExecution } from '../../storage/todo-store.js'

function renderTodoRecovery(directory: string): string[] {
  const store = new TodoStore(directory)
  const active = store.listForDisplay().filter(todo => todo.status === 'active')
  const lines = ['## Active Todo Recovery', '']
  if (active.length === 0) return [...lines, '_No active todos._', '']

  for (const todo of active) {
    const execution = currentTodoExecution(todo)
    lines.push(`### ${todo.ref ? `${todo.ref} ` : ''}${todo.title}`, `- Status: \`${todo.status}\``)
    if (execution) {
      lines.push(
        `- Execution: \`${execution.id}\``,
        `- Phase: \`${execution.phase}\``,
        `- Next: ${execution.next}`,
        `- Blocked on: ${execution.blocked_on ?? '—'}`,
        `- History: ${todo.executions.length} execution(s)`,
      )
    }
    else {
      lines.push('- No open execution. Use `todo_activate` when work resumes.', `- History: ${todo.executions.length} execution(s)`)
    }
    lines.push('')
  }
  return lines
}

/**
 * Initialize a repository-scoped contribbot session without performing writes
 * to GitHub or creating local work items.
 */
export interface ProjectInitResult {
  markdown: string
  context: {
    schema_version: 1
    repository: RepositoryRef
    directory: string
    lifecycle: { status: RepoConfigData['lifecycle']['status'] }
    tracking: { status: RepoConfigData['tracking']['status'] }
  }
}

export async function projectInitResult(repo: RepositoryInput): Promise<ProjectInitResult> {
  const { repository, directory, config: stored } = await getOrInitConfig(repo)
  const canonicalRepo = repositoryDisplay(repository)
  const config = renderRepoConfig(stored)
  const projects = projectList()
  const archived = stored.lifecycle.status === 'archived'
  const pending = trackingStatus(stored) === 'pending'

  const markdown = [
    `# Contribbot Context — ${canonicalRepo}`,
    `- Requested repository: \`${repositoryDisplay(repo)}\``,
    `- Canonical repository: \`${canonicalRepo}\``,
    '',
    '## Repository Configuration',
    config,
    '',
    '## Session Guidance',
    `Pass repo: ${JSON.stringify(repository)} to repository-scoped contribbot tools in this session.`,
    `The display name \`${canonicalRepo}\` is not a tool input.`,
    'This initialization only reads or creates the local repository config; it does not run patrols, create todos, write knowledge, or publish to GitHub.',
    '',
    ...(pending ? [
      '## External Tracking Confirmation — pending / 未确认',
      'Ask whether to track other repositories. The parent is not automatically a tracking source.',
      'Verify a candidate using an appropriate read-only platform adapter. Never infer identity from a name, fork relationship or URL alone.',
      'Only after confirmation, call repo_config with the full repository identity and tracking sources array; an explicit no is tracking: "". No answer leaves it pending.',
      'Existing configured or explicitly disabled tracking is already decided; do not ask again. Confirmation does not authorize patrols, public writes, or restoring archived projects.',
      '',
    ] : []),
    ...renderTodoRecovery(directory),
    '## Available Next Steps',
    ...(archived ? [
      '**This project is archived. Initialization does not reactivate it.**',
      '- Use project_restore with this full repository identity only when the user wants to resume maintenance.',
    ] : []),
    '- Use project_dashboard / todo_list with this full repository identity.',
    ...(archived ? [] : ['- A read-only patrol requires explicit separate invocation and supported platform.']),
    '',
    '## Global Tracked Projects',
    projects,
  ].join('\n')
  return {
    markdown,
    context: {
      schema_version: 1,
      repository,
      directory,
      lifecycle: { status: stored.lifecycle.status },
      tracking: { status: stored.tracking.status },
    },
  }
}

export async function projectInit(repo: RepositoryInput): Promise<string> {
  return (await projectInitResult(repo)).markdown
}
