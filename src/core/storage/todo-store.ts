import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { todayDate } from '../utils/format.js'

export type { TodoType, TodoStatus, TodoDifficulty } from '../enums.js'
import type { TodoType, TodoStatus, TodoDifficulty } from '../enums.js'

export interface TodoItem {
  ref: string | null
  title: string
  type: TodoType
  status: TodoStatus
  difficulty: TodoDifficulty | null
  pr: number | null
  branch: string | null
  created: string
  updated: string
}

interface TodosFile {
  todos: TodoItem[]
}

export interface ArchivedTodoItem extends TodoItem {
  archived: string
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

  /**
   * Resolve an item query (1-based index among open todos, or text substring match).
   * Returns { storeIndex, item } or undefined.
   */
  resolveItem(query: string): { storeIndex: number; item: TodoItem } | undefined {
    const allTodos = this.list()
    const openIndices: number[] = []
    allTodos.forEach((t, i) => {
      if (t.status !== 'done') openIndices.push(i)
    })

    if (openIndices.length === 0) return undefined

    const num = Number.parseInt(query, 10)
    let targetIndex: number | undefined

    if (!Number.isNaN(num) && num >= 1 && num <= openIndices.length) {
      targetIndex = openIndices[num - 1]
    } else {
      targetIndex = openIndices.find(i => {
        const t = allTodos[i]
        return t ? t.title.toLowerCase().includes(query.toLowerCase()) : false
      })
    }

    if (targetIndex === undefined) return undefined
    const item = allTodos[targetIndex]
    if (!item) return undefined
    return { storeIndex: targetIndex, item }
  }

  /**
   * Resolve an item from all todos (including done), sorted by ref.
   * Used by todoDetail which needs to find done items too.
   */
  resolveItemFromAll(query: string): TodoItem | undefined {
    const allTodos = this.listSorted()
    if (allTodos.length === 0) return undefined

    const num = Number.parseInt(query, 10)
    if (!Number.isNaN(num) && num >= 1 && num <= allTodos.length) {
      return allTodos[num - 1]
    }
    return allTodos.find(t => t.title.toLowerCase().includes(query.toLowerCase()))
  }

  add(input: { ref: string | null; title: string; type: TodoType }): TodoItem {
    const today = todayDate()
    const item: TodoItem = {
      ref: input.ref,
      title: input.title,
      type: input.type,
      status: 'idea',
      difficulty: null,
      pr: null,
      branch: null,
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
    fields: Partial<Pick<TodoItem, 'status' | 'difficulty' | 'pr' | 'branch' | 'title' | 'type'>>,
  ): TodoItem | undefined {
    const todos = this.list()
    const todo = todos[index]
    if (index < 0 || index >= todos.length || !todo) return undefined
    const today = todayDate()
    Object.assign(todo, fields, { updated: today })
    this.save(todos)
    return todo
  }

  delete(index: number): TodoItem | undefined {
    const todos = this.list()
    if (index < 0 || index >= todos.length) return undefined
    const [removed] = todos.splice(index, 1)
    this.save(todos)
    return removed
  }

  /**
   * Archive a todo: append to archive.yaml, then delete from todos.yaml.
   * Returns the archived item or undefined if index is invalid.
   */
  archiveAndDelete(index: number): ArchivedTodoItem | undefined {
    const todos = this.list()
    const todo = todos[index]
    if (index < 0 || index >= todos.length || !todo) return undefined
    const today = todayDate()

    // Load existing archive
    const archivePath = join(this.baseDir, 'archive.yaml')
    let archived: ArchivedTodoItem[] = []
    if (existsSync(archivePath)) {
      const content = readFileSync(archivePath, 'utf-8')
      const data = parse(content) as { todos: ArchivedTodoItem[] } | null
      archived = data?.todos ?? []
    }

    // Append to archive
    const archivedItem: ArchivedTodoItem = { ...todo, status: 'done', archived: today }
    archived.push(archivedItem)

    // Atomic write: archive first, then delete
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    writeFileSync(archivePath, stringify({ todos: archived }), 'utf-8')

    // Delete from active todos
    todos.splice(index, 1)
    this.save(todos)

    return archivedItem
  }

  private save(todos: TodoItem[]): void {
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    const data: TodosFile = { todos }
    writeFileSync(this.yamlPath, stringify(data), 'utf-8')
  }
}
