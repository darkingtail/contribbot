import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { todayDate } from '../utils/format.js'
import { safeWriteFileSync } from '../utils/fs.js'

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
  claimed_items: string[] | null
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
export function refSortKey(ref: string | null): number {
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
    return (data?.todos ?? []).map(t => ({
      ...t,
      claimed_items: t.claimed_items ?? null,
    }))
  }

  listSorted(): TodoItem[] {
    const todos = this.list()
    return [...todos].sort((a, b) => refSortKey(a.ref) - refSortKey(b.ref))
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
      claimed_items: null,
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
    fields: Partial<Pick<TodoItem, 'status' | 'difficulty' | 'pr' | 'branch' | 'title' | 'type' | 'claimed_items'>>,
  ): TodoItem | undefined {
    const todos = this.list()
    const todo = todos[index]
    if (index < 0 || index >= todos.length || !todo) return undefined
    const today = todayDate()
    if (fields.status !== undefined) todo.status = fields.status
    if (fields.difficulty !== undefined) todo.difficulty = fields.difficulty
    if (fields.pr !== undefined) todo.pr = fields.pr
    if (fields.branch !== undefined) todo.branch = fields.branch
    if (fields.title !== undefined) todo.title = fields.title
    if (fields.type !== undefined) todo.type = fields.type
    if (fields.claimed_items !== undefined) todo.claimed_items = fields.claimed_items
    todo.updated = today
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

  private get archivePath(): string {
    const newPath = join(this.baseDir, 'todos.archive.yaml')
    if (existsSync(newPath)) return newPath
    // Backward compat: migrate old archive.yaml
    const oldPath = join(this.baseDir, 'archive.yaml')
    if (existsSync(oldPath)) {
      const content = readFileSync(oldPath, 'utf-8')
      safeWriteFileSync(newPath, content)
      // Keep old file for safety, will be ignored going forward
      return newPath
    }
    return newPath
  }

  /**
   * Archive a todo: append to todos.archive.yaml, then delete from todos.yaml.
   * Returns the archived item or undefined if index is invalid.
   */
  archiveAndDelete(index: number): ArchivedTodoItem | undefined {
    const todos = this.list()
    const todo = todos[index]
    if (index < 0 || index >= todos.length || !todo) return undefined
    const today = todayDate()

    const archivedItem: ArchivedTodoItem = { ...todo, status: todo.status === 'not_planned' ? 'not_planned' : 'done', archived: today }

    let archived: ArchivedTodoItem[] = []
    if (existsSync(this.archivePath)) {
      const content = readFileSync(this.archivePath, 'utf-8')
      const data = parse(content) as { todos: ArchivedTodoItem[] } | null
      archived = data?.todos ?? []
    }
    archived.push(archivedItem)

    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    safeWriteFileSync(this.archivePath, stringify({ todos: archived }))

    // Delete from active only after archive write succeeds.
    todos.splice(index, 1)
    this.save(todos)

    return archivedItem
  }

  listArchived(): ArchivedTodoItem[] {
    if (!existsSync(this.archivePath)) return []
    const content = readFileSync(this.archivePath, 'utf-8')
    const data = parse(content) as { todos: ArchivedTodoItem[] } | null
    return data?.todos ?? []
  }

  /**
   * Compact archive: remove old entries by date or keep count.
   * Exactly one of `before` or `keep` must be provided.
   */
  compact(options: { before?: string; keep?: number }): { removed: number; remaining: number } {
    const archived = this.listArchived()
    if (archived.length === 0) return { removed: 0, remaining: 0 }

    let kept: ArchivedTodoItem[]

    if (options.before) {
      kept = archived.filter(t => t.archived >= options.before!)
    } else if (options.keep !== undefined) {
      kept = options.keep === 0 ? [] : archived.slice(-options.keep)
    } else {
      throw new Error('Exactly one of "before" or "keep" must be provided.')
    }

    const removed = archived.length - kept.length
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    safeWriteFileSync(this.archivePath, stringify({ todos: kept }))
    return { removed, remaining: kept.length }
  }

  private save(todos: TodoItem[]): void {
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true })
    const data: TodosFile = { todos }
    safeWriteFileSync(this.yamlPath, stringify(data))
  }
}
