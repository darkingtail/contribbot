import { getIssue, getIssueComments, parseRepo, getRepoDefaultBranch, createBranch } from '../clients/github.js'
import { RecordFiles } from '../storage/record-files.js'
import { TodoStore } from '../storage/todo-store.js'
import { RepoConfig } from '../storage/repo-config.js'
import type { TodoDifficulty } from '../enums.js'
import { getContribDir } from '../utils/config.js'
import { difficultyLabel } from '../utils/format.js'

function generateBranchName(todo: { ref: string | null; title: string; type: string }): string {
  const prefix = todo.type === 'bug' ? 'fix' : todo.type === 'docs' ? 'docs' : 'feat'

  let slug: string
  if (todo.ref?.startsWith('#')) {
    // Issue ref: feat/259-cascader-search
    const num = todo.ref.slice(1)
    const words = todo.title
      .replace(/[^\w\s-]/g, '')
      .split(/\s+/)
      .filter(w => /^[a-zA-Z]/.test(w))
      .map(w => w.toLowerCase())
      .filter(w => w.length > 1 && !['the', 'and', 'for', 'with', 'from', 'this', 'that'].includes(w))
      .slice(0, 3)
    slug = words.length > 0 ? `${num}-${words.join('-')}` : num
  } else if (todo.ref) {
    slug = todo.ref
  } else {
    const words = todo.title
      .replace(/[^\w\s-]/g, '')
      .split(/\s+/)
      .filter(w => /^[a-zA-Z]/.test(w))
      .map(w => w.toLowerCase())
      .filter(w => w.length > 1)
      .slice(0, 3)
    slug = words.join('-') || 'task'
  }

  return `${prefix}/${slug}`
}

export async function todoActivate(item: string, repo?: string): Promise<string> {
  const { owner, name } = parseRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)
  const records = new RecordFiles(contribDir)

  const resolved = store.resolveItem(item)
  if (!resolved) {
    throw new Error(`Todo not found: "${item}". Use todo_list to see available items.`)
  }

  const { storeIndex, item: todo } = resolved
  let difficulty: TodoDifficulty = 'medium'

  if (todo.ref && todo.ref.startsWith('#')) {
    // Issue ref like #281 — fetch issue info
    const issueNumber = Number.parseInt(todo.ref.slice(1), 10)

    try {
      const [issue, comments] = await Promise.all([
        getIssue(owner, name, issueNumber),
        getIssueComments(owner, name, issueNumber),
      ])

      // Assess difficulty heuristically
      const labelNames = issue.labels.map(l =>
        (typeof l === 'string' ? l : l.name).toLowerCase(),
      )

      if (labelNames.some(n => n.includes('good first issue') || n.includes('easy'))) {
        difficulty = 'easy'
      }
      else if (
        labelNames.some(n => n.includes('complex'))
        || comments.length > 10
        || (issue.body && issue.body.length > 2000)
      ) {
        difficulty = 'hard'
      }
      else {
        difficulty = 'medium'
      }

      // Build comments summary
      const commentsSummary = comments
        .map((c) => {
          const user = c.user?.login ?? 'unknown'
          const body = c.body.replace(/\r?\n/g, ' ').slice(0, 100)
          return `- @${user}: ${body}`
        })
        .join('\n')

      // Create issue record file
      const labelsStr = issue.labels
        .map(l => (typeof l === 'string' ? l : l.name))
        .join(', ')

      records.createIssueRecord(issueNumber, {
        title: issue.title,
        link: issue.html_url,
        labels: labelsStr || '—',
        author: issue.user?.login ?? 'unknown',
        createdAt: issue.created_at,
        commentsSummary,
        body: issue.body ?? '',
      })
    }
    catch (err) {
      // If GitHub API fails, still activate but with default difficulty
      const message = err instanceof Error ? err.message : String(err)
      const updated = store.update(storeIndex, { status: 'active', difficulty })
      if (!updated) {
        throw new Error(`Failed to update todo at index ${storeIndex}.`)
      }
      return `Activated: **${updated.title}** (difficulty: ${difficulty}) — ⚠️ GitHub fetch failed: ${message}`
    }
  }
  else if (todo.ref) {
    // Custom slug ref — create slug record
    records.createSlugRecord(todo.ref, todo.title)
  }
  else {
    // No ref — create idea record
    records.createIdeaRecord(todo.title)
  }

  // Create remote branch
  const branchName = generateBranchName(todo)
  let branchMsg = ''

  // Determine which repo to create branch on (fork or current repo)
  const config = new RepoConfig(contribDir)
  const repoConfig = config.load()
  const branchOwner = repoConfig?.fork ? parseRepo(repoConfig.fork).owner : owner
  const branchRepo = repoConfig?.fork ? parseRepo(repoConfig.fork).name : name

  try {
    const { sha } = await getRepoDefaultBranch(branchOwner, branchRepo)
    await createBranch(branchOwner, branchRepo, branchName, sha)
    branchMsg = ` · branch: \`${branchName}\``
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    branchMsg = ` · ⚠️ branch creation failed: ${msg}`
  }

  // Update todo status to active with assessed difficulty and branch
  const updated = store.update(storeIndex, { status: 'active', difficulty, branch: branchName })
  if (!updated) {
    throw new Error(`Failed to update todo at index ${storeIndex}.`)
  }

  return `Activated: **${updated.title}**${updated.ref ? ` (${updated.ref})` : ''} — difficulty: ${difficultyLabel(difficulty)}${branchMsg}`
}
