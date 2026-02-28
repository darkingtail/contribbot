import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseRepo } from '../clients/github.js'

function getTodosPath(owner: string, name: string): string {
  return join(homedir(), '.contrib', owner, name, 'todos.md')
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

interface TodoItem {
  index: number
  done: boolean
  text: string
  raw: string
}

function splitTodoText(text: string): { title: string, note: string } {
  // Split at first （...） or ：to extract note
  const parenMatch = text.match(/^(.+?)（(.+)）(.*)$/)
  if (parenMatch) {
    const title = parenMatch[1].trim()
    const note = parenMatch[3] ? `${parenMatch[2]}${parenMatch[3]}`.trim() : parenMatch[2].trim()
    return { title, note }
  }
  const colonIdx = text.indexOf('：')
  if (colonIdx !== -1) {
    return { title: text.slice(0, colonIdx).trim(), note: text.slice(colonIdx + 1).trim() }
  }
  return { title: text, note: '' }
}

function parseTodos(content: string): TodoItem[] {
  return content
    .split('\n')
    .map((line, i) => {
      const match = line.match(/^- \[([ x])\] (.+)/)
      if (!match) return null
      return { index: i, done: match[1] === 'x', text: match[2], raw: line }
    })
    .filter((item): item is TodoItem => item !== null)
}

export function todoList(repo?: string): string {
  const { owner, name } = parseRepo(repo)
  const path = getTodosPath(owner, name)

  if (!existsSync(path)) {
    return `## Todos — ${owner}/${name}\n\n_No todos yet. Use \`todo_add\` to create one._`
  }

  const content = readFileSync(path, 'utf-8')
  const todos = parseTodos(content)

  if (todos.length === 0) {
    return `## Todos — ${owner}/${name}\n\n_No todos yet._`
  }

  const open = todos.filter(t => !t.done)
  const done = todos.filter(t => t.done)

  const lines = [
    `## Todos — ${owner}/${name}`,
    `> ${open.length} open · ${done.length} done`,
    '',
  ]

  if (open.length > 0) {
    lines.push('### Open')
    lines.push('| # | Todo | 备注 |')
    lines.push('| --- | --- | --- |')
    open.forEach((t, i) => {
      const { title, note } = splitTodoText(t.text)
      lines.push(`| ${i + 1} | ${title} | ${note || '—'} |`)
    })
    lines.push('')
  }

  if (done.length > 0) {
    lines.push('### Done')
    done.forEach(t => lines.push(`- ~~${t.text}~~`))
  }

  return lines.join('\n')
}

export function todoAdd(text: string, repo?: string): string {
  const { owner, name } = parseRepo(repo)
  const path = getTodosPath(owner, name)
  ensureDir(path)

  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : ''
  const newLine = `- [ ] ${text}`
  const updated = existing ? `${existing.trimEnd()}\n${newLine}\n` : `${newLine}\n`
  writeFileSync(path, updated, 'utf-8')

  return `Added: ${text}`
}

export function todoDone(indexOrText: string, repo?: string): string {
  const { owner, name } = parseRepo(repo)
  const path = getTodosPath(owner, name)

  if (!existsSync(path)) {
    return 'Error: No todos file found.'
  }

  const content = readFileSync(path, 'utf-8')
  const lines = content.split('\n')
  const todos = parseTodos(content)

  // Match by 1-based index or by text substring
  const num = Number.parseInt(indexOrText, 10)
  const openTodos = todos.filter(t => !t.done)
  let target: TodoItem | undefined

  if (!Number.isNaN(num) && num >= 1 && num <= openTodos.length) {
    target = openTodos[num - 1]
  }
  else {
    target = openTodos.find(t => t.text.toLowerCase().includes(indexOrText.toLowerCase()))
  }

  if (!target) {
    return `Error: Todo not found: "${indexOrText}". Use todo_list to see available items.`
  }

  lines[target.index] = lines[target.index].replace('- [ ]', '- [x]')
  writeFileSync(path, lines.join('\n'), 'utf-8')

  return `Done: ~~${target.text}~~`
}
