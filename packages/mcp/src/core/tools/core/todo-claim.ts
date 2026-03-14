import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createComment, getCurrentUser, getIssue } from '../../clients/github.js'
import type { TodoItem } from '../../storage/todo-store.js'
import { TodoStore } from '../../storage/todo-store.js'
import { getContribDir } from '../../utils/config.js'
import { resolveRepo } from '../../utils/resolve-repo.js'

const DEFAULT_TEMPLATE = `<!--
  Claim 评论模板 — 发布到 GitHub issue 的评论内容
  可用变量：
    {{items}}  — 领取的工作项列表（markdown 列表格式）
    {{user}}   — GitHub 用户名
    {{repo}}   — 仓库（owner/repo）
    {{issue}}  — issue 编号
-->
I'll work on the following:

{{items}}

<!-- contribbot:claim @{{user}} -->`

function loadTemplate(contribDir: string): string {
  const templateDir = join(contribDir, 'templates')
  const templatePath = join(templateDir, 'todo_claim.md')
  if (!existsSync(templatePath)) {
    if (!existsSync(templateDir)) mkdirSync(templateDir, { recursive: true })
    writeFileSync(templatePath, DEFAULT_TEMPLATE, 'utf-8')
  }
  // Strip leading HTML comment header (variable docs) before rendering
  return readFileSync(templatePath, 'utf-8')
    .replace(/^<!--[\s\S]*?-->\s*/m, '')
    .trim()
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
}

export async function todoClaim(
  item: string,
  items: string[],
  repo?: string,
): Promise<string> {
  const { owner, name } = await resolveRepo(repo)
  const contribDir = getContribDir(owner, name)
  const store = new TodoStore(contribDir)

  const resolved = store.resolveItem(item)
  if (!resolved) {
    throw new Error(`Todo not found: "${item}". Use todo_list to see available items.`)
  }

  const { storeIndex, item: todo } = resolved

  if (!todo.ref?.startsWith('#')) {
    throw new Error(`Todo "${todo.title}" has no issue ref — nothing to claim on GitHub.`)
  }

  if (items.length === 0) {
    throw new Error('No items specified. Provide at least one item to claim.')
  }

  const issueNumber = Number.parseInt(todo.ref.slice(1), 10)

  const issue = await getIssue(owner, name, issueNumber)
  if (issue.state === 'closed') {
    throw new Error(`Issue ${todo.ref} is closed — cannot claim on a closed issue.`)
  }

  const user = await getCurrentUser()
  if (!user?.login) {
    throw new Error('Cannot determine GitHub username. Check authentication (gh auth status or GITHUB_TOKEN).')
  }

  const existing = todo.claimed_items
  let warning = ''
  if (existing && existing.length > 0) {
    warning = `\n\n> Merged with ${existing.length} previously claimed item(s).`
  }

  const merged = existing
    ? [...new Set([...existing, ...items])]
    : items

  const itemsList = items.map(s => `- ${s}`).join('\n')
  const template = loadTemplate(contribDir)
  const body = renderTemplate(template, {
    items: itemsList,
    user: user.login,
    repo: `${owner}/${name}`,
    issue: String(issueNumber),
  })

  await createComment(owner, name, issueNumber, body)

  const fields: Partial<Pick<TodoItem, 'claimed_items' | 'status'>> = { claimed_items: merged }
  if (todo.status !== 'active' && todo.status !== 'pr_submitted') {
    fields.status = 'active'
  }
  store.update(storeIndex, fields)

  return [
    `Claimed ${items.length} item(s) on ${todo.ref}:`,
    '',
    itemsList,
    '',
    `Comment posted to ${owner}/${name}#${issueNumber}`,
    warning,
  ].join('\n').trim()
}
