import { projectList } from './project-list.js'
import { repoConfig } from './repo-config-tool.js'
import { resolveRepo } from '../../utils/resolve-repo.js'

/**
 * Initialize a repository-scoped contribbot session without performing writes
 * to GitHub or creating local work items.
 */
export async function projectInit(repo: string): Promise<string> {
  const canonical = await resolveRepo(repo)
  const canonicalRepo = `${canonical.owner}/${canonical.name}`
  const config = await repoConfig(repo)
  const projects = projectList()

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
    '## Available Next Steps',
    `- \`project_dashboard({ repo: "${canonicalRepo}" })\``,
    `- \`todo_list({ repo: "${canonicalRepo}" })\``,
    `- \`patrol ${canonicalRepo} --no-input\` for a read-only patrol via the local agent CLI`,
    '',
    '## Global Tracked Projects',
    projects,
  ].join('\n')
}
