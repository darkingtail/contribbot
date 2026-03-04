import { existsSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseRepo } from '../clients/github.js'
import { TodoStore } from '../storage/todo-store.js'
import type { TodoItem, TodoStatus, TodoType } from '../storage/todo-store.js'

function getContribDir(owner: string, name: string): string {
  return join(homedir(), '.contribbot', owner, name)
}

/**
 * Parse a single checkbox line from todos.md into a TodoItem.
 *
 * Supported formats:
 * - `- [x] #63 Title text`
 * - `- [ ] #168 Modal 函数调用国际化问题（待方案设计）`
 * - `- [x] nuxt/modules PR #1410 Nuxt modules 注册`
 * - `- [ ] Tree/DirectoryTree 泛型支持：...`
 * - `- [ ] #281 [Docs] 补充模型下载镜像配置文档`
 */
export function parseTodoLine(line: string): TodoItem | null {
  const match = line.match(/^- \[([ xX])\]\s+(.+)$/)
  if (!match) return null

  const checked = match[1].toLowerCase() === 'x'
  const rest = match[2].trim()

  const status: TodoStatus = checked ? 'done' : 'idea'
  const today = new Date().toISOString().slice(0, 10)

  // Try to extract #NNN ref at the beginning of the text
  let ref: string | null = null
  let title = rest

  const refMatch = rest.match(/^#(\d+)\s+(.*)$/)
  if (refMatch) {
    ref = `#${refMatch[1]}`
    title = refMatch[2].trim()
  }

  // Detect type from [Bug], [Feature], [Docs] tags (CoPaw format)
  let type: TodoType = 'chore'
  const typeTagMatch = title.match(/^\[(Bug|Feature|Docs|Chore)\]\s*/i)
  if (typeTagMatch) {
    const tag = typeTagMatch[1].toLowerCase()
    if (tag === 'bug') type = 'bug'
    else if (tag === 'feature') type = 'feature'
    else if (tag === 'docs') type = 'docs'
    else type = 'chore'
    title = title.slice(typeTagMatch[0].length).trim()
  }
  else {
    // Try to detect type from title keywords
    type = detectTypeFromTitle(title)
  }

  // Extract PR number if present in the text (PR #NNN)
  let pr: number | null = null
  const prMatch = rest.match(/PR\s+#(\d+)/i)
  if (prMatch) {
    pr = Number.parseInt(prMatch[1], 10)
  }

  return {
    ref,
    title,
    type,
    status,
    difficulty: null,
    pr,
    created: today,
    updated: today,
  }
}

function detectTypeFromTitle(title: string): TodoType {
  const lower = title.toLowerCase()
  if (lower.includes('bug') || lower.includes('fix') || lower.includes('修复') || lower.includes('警告')) return 'bug'
  if (lower.includes('test') || lower.includes('测试') || lower.includes('单元测试')) return 'chore'
  if (lower.includes('doc') || lower.includes('文档') || lower.includes('补充')) return 'docs'
  if (lower.includes('feature') || lower.includes('泛型') || lower.includes('支持') || lower.includes('渲染')) return 'feature'
  return 'chore'
}

/**
 * Parse a todos.md file content into a list of TodoItems.
 */
export function parseTodosMd(content: string): TodoItem[] {
  const lines = content.split('\n')
  const items: TodoItem[] = []

  for (const line of lines) {
    const item = parseTodoLine(line)
    if (item) {
      items.push(item)
    }
  }

  return items
}

/**
 * Migrate todos.md checkbox format to todos.yaml.
 *
 * 1. Read todos.md from ~/.contrib/{owner}/{repo}/
 * 2. Parse each checkbox line into TodoItem
 * 3. Write todos.yaml via TodoStore
 * 4. Rename todos.md to todos.md.bak
 * 5. Return a summary
 */
export function migrateTodos(repo?: string): string {
  const { owner, name } = parseRepo(repo)
  const contribDir = getContribDir(owner, name)
  const mdPath = join(contribDir, 'todos.md')

  if (!existsSync(mdPath)) {
    return `No todos.md found at ${mdPath}. Nothing to migrate.`
  }

  const content = readFileSync(mdPath, 'utf-8')
  const items = parseTodosMd(content)

  if (items.length === 0) {
    return `No todo items found in ${mdPath}. Nothing to migrate.`
  }

  // Write using TodoStore (creates todos.yaml)
  const store = new TodoStore(contribDir)
  const existing = store.list()

  if (existing.length > 0) {
    return `todos.yaml already exists with ${existing.length} items at ${contribDir}. Skipping migration to avoid data loss.`
  }

  // Add items one-by-one to go through TodoStore's save logic
  for (const item of items) {
    store.add({ ref: item.ref, title: item.title, type: item.type })
    // After add, update additional fields (status, pr, difficulty)
    const allTodos = store.list()
    const lastIndex = allTodos.length - 1
    store.update(lastIndex, {
      status: item.status,
      pr: item.pr,
      difficulty: item.difficulty,
    })
  }

  // Rename todos.md to todos.md.bak
  const bakPath = join(contribDir, 'todos.md.bak')
  renameSync(mdPath, bakPath)

  const doneCount = items.filter(t => t.status === 'done').length
  const openCount = items.length - doneCount

  const lines = [
    `## Migration complete — ${owner}/${name}`,
    '',
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Total migrated | ${items.length} |`,
    `| Open | ${openCount} |`,
    `| Done | ${doneCount} |`,
    '',
    `- \`todos.md\` → \`todos.md.bak\``,
    `- \`todos.yaml\` created at \`${contribDir}\``,
  ]

  return lines.join('\n')
}
