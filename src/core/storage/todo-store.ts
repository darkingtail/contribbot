import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'

export type TodoType = 'bug' | 'feature' | 'docs' | 'chore'
export type TodoStatus = 'idea' | 'backlog' | 'active' | 'pr_submitted' | 'done'
export type TodoDifficulty = 'easy' | 'medium' | 'hard'

export interface TodoItem {
  ref: string | null
  title: string
  type: TodoType
  status: TodoStatus
  difficulty: TodoDifficulty | null
  pr: number | null
  created: string
  updated: string
}

interface TodosFile {
  todos: TodoItem[]
}

// Sort order: #N (by number) → slug (alphabetical, at Number.MAX_SAFE_INTEGER) → null (Infinity)
function refSortKey(ref: string | null): number {
  if (!ref) return Infinity
  if (ref.startsWith('#')) {
    const num = Number.parseInt(ref.slice(1), 10)
    return Number.isNaN(num) ? Number.MAX_SAFE_INTEGER : num
  }
  return Number.MAX_SAFE_INTEGER
}

export class TodoStore {
  private yamlPath: string

  constructor(private baseDir: string) {
    this.yamlPath = join(baseDir, 'todos.yaml')
  }

  list(): TodoItem[] {
    if (!existsSync(this.yamlPath)) return []
    const content = readFileSync(this.yamlPath, 'utf-8')
    const data = parse(content) as TodosFile | null
    return data?.todos ?? []
  }

  listSorted(): TodoItem[] {
    const todos = this.list()
    return todos.sort((a, b) => refSortKey(a.ref) - refSortKey(b.ref))
  }

  get(index: number): TodoItem | undefined {
    return this.list()[index]
  }

  findByText(text: string): TodoItem | undefined {
    return this.list().find(t => t.title.toLowerCase().includes(text.toLowerCase()))
  }

  add(input: { ref: string | null; title: string; type: TodoType }): TodoItem {
    const today = new Date().toISOString().slice(0, 10)
    const item: TodoItem = {
      ref: input.ref,
      title: input.title,
      type: input.type,
      status: 'idea',
      difficulty: null,
      pr: null,
      created: today,
      updated: today,
    }
    const todos = this.list()
    todos.push(item)
    this.save(todos)
    return item
  }

  update(
    index: number,
    fields: Partial<Pick<TodoItem, 'status' | 'difficulty' | 'pr' | 'title' | 'type'>>,
  ): TodoItem | undefined {
    const todos = this.list()
    if (index < 0 || index >= todos.length) return undefined
    const today = new Date().toISOString().slice(0, 10)
    Object.assign(todos[index], fields, { updated: today })
    this.save(todos)
    return todos[index]
  }

  private save(todos: TodoItem[]): void {
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    const data: TodosFile = { todos }
    writeFileSync(this.yamlPath, stringify(data), 'utf-8')
  }
}
