import { projectList } from './project-list.js'
import { repoConfig } from './repo-config-tool.js'
import { resolveRepo } from '../../utils/resolve-repo.js'
import { RepoConfig, upstreamStatus } from '../../storage/repo-config.js'
import { getContribDir } from '../../utils/config.js'
import { TodoStore, currentTodoExecution } from '../../storage/todo-store.js'

function renderTodoRecovery(owner: string, name: string): string[] {
  const store = new TodoStore(getContribDir(owner, name))
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
export async function projectInit(repo: string): Promise<string> {
  const canonical = await resolveRepo(repo)
  const canonicalRepo = `${canonical.owner}/${canonical.name}`
  const config = await repoConfig(repo)
  const projects = projectList()
  const stored = new RepoConfig(getContribDir(canonical.owner, canonical.name)).load()!
  const archived = stored.status === 'archived'
  const pending = upstreamStatus(stored) === 'pending'

  return [
    `# Contribbot Context — ${canonicalRepo}`,
    `- Requested repository: \`${repo}\``,
    `- Canonical repository: \`${canonicalRepo}\``,
    '',
    '## Repository Configuration',
    config,
    '',
    '## Session Guidance',
    `Use the canonical repo \`${canonicalRepo}\` for repository-scoped contribbot tools in this session.`,
    'This initialization only reads or creates the local repository config; it does not run patrols, create todos, write knowledge, or publish to GitHub.',
    '',
    ...(pending ? [
      '## External Upstream Confirmation — pending / 未确认',
      'Ask the user whether to track an external repository (not the fork parent). Do not infer it from a repository name, fork parent, or project mode.',
      'Accept a project name, shorthand, owner/repo, or GitHub URL as a clue, not a verified choice. Verify candidates with repo_info; use available read-only GitHub search if ambiguous. Do not initialize candidate projects.',
      'Before asking for confirmation, proactively show the verified full repository name, clickable GitHub URL, and short description together. Let the user choose among ambiguous candidates; never invent a verified URL. Lookup failure or unavailable search leaves the decision pending; ask for more clues.',
      `Only after the user confirms the displayed candidate, call repo_config({ repo: "${canonicalRepo}", upstream: "verified-owner/verified-repo" }). If the candidate changes, confirm again.`,
      `If explicitly no, call repo_config({ repo: "${canonicalRepo}", upstream: "" }). No answer, EOF or cancellation leaves it pending; do not write a no decision.`,
      'Existing nonempty upstream is already configured; do not ask again. Confirmation does not authorize patrols, public writes, or restoring archived projects.',
      '',
    ] : []),
    ...renderTodoRecovery(canonical.owner, canonical.name),
    '## Available Next Steps',
    ...(archived ? [
      '**This project is archived. Initialization does not reactivate it.**',
      `- \`project_restore({ repo: "${canonicalRepo}" })\` only when the user wants to resume maintenance.`,
    ] : []),
    `- \`project_dashboard({ repo: "${canonicalRepo}" })\``,
    `- \`todo_list({ repo: "${canonicalRepo}" })\``,
    ...(archived ? [] : [`- \`patrol ${canonicalRepo} --no-input\` for a read-only patrol via the local agent CLI`]),
    '',
    '## Global Tracked Projects',
    projects,
  ].join('\n')
}
