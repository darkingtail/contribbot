import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'yaml'
import { migrateTodos, parseTodoLine, parseTodosMd } from './migrate-todos.js'
import type { TodoItem } from '../storage/todo-store.js'

// ────────────────────────────────────────────
// Unit tests for parseTodoLine
// ────────────────────────────────────────────

describe('parseTodoLine', () => {
  it('parses a checked item with issue ref', () => {
    const item = parseTodoLine('- [x] #63 Notification 单元测试（测试任务系列最后一个）')
    expect(item).not.toBeNull()
    expect(item!.ref).toBe('#63')
    expect(item!.title).toBe('Notification 单元测试（测试任务系列最后一个）')
    expect(item!.status).toBe('done')
  })

  it('parses an unchecked item with issue ref', () => {
    const item = parseTodoLine('- [ ] #168 Modal 函数调用国际化问题（待方案设计）')
    expect(item).not.toBeNull()
    expect(item!.ref).toBe('#168')
    expect(item!.status).toBe('idea')
  })

  it('parses item without issue ref', () => {
    const item = parseTodoLine('- [ ] Tree/DirectoryTree 泛型支持：当前方案 A（放宽到 BasicDataNode）')
    expect(item).not.toBeNull()
    expect(item!.ref).toBeNull()
    expect(item!.title).toBe('Tree/DirectoryTree 泛型支持：当前方案 A（放宽到 BasicDataNode）')
  })

  it('parses external repo reference as null ref', () => {
    const item = parseTodoLine('- [x] nuxt/modules PR #1410 Nuxt modules 注册（待 Nuxt 团队 review）')
    expect(item).not.toBeNull()
    expect(item!.ref).toBeNull()
    expect(item!.title).toBe('nuxt/modules PR #1410 Nuxt modules 注册（待 Nuxt 团队 review）')
    expect(item!.pr).toBe(1410)
    expect(item!.status).toBe('done')
  })

  it('extracts PR number from text', () => {
    const item = parseTodoLine('- [x] #209 TreeSelect + Form 警告 bug（PR #210 Open）')
    expect(item).not.toBeNull()
    expect(item!.ref).toBe('#209')
    expect(item!.pr).toBe(210)
  })

  it('detects [Bug] type tag', () => {
    const item = parseTodoLine('- [ ] #313 [Bug] 修复 Windows copaw.cmd UTF-8 BOM 导致无限循环')
    expect(item).not.toBeNull()
    expect(item!.type).toBe('bug')
    expect(item!.title).toBe('修复 Windows copaw.cmd UTF-8 BOM 导致无限循环')
  })

  it('detects [Feature] type tag', () => {
    const item = parseTodoLine('- [ ] #159 [Feature] 补充单元测试 + 完善贡献指南')
    expect(item).not.toBeNull()
    expect(item!.type).toBe('feature')
    expect(item!.title).toBe('补充单元测试 + 完善贡献指南')
  })

  it('detects [Docs] type tag', () => {
    const item = parseTodoLine('- [ ] #281 [Docs] 补充模型下载镜像配置文档（HF_ENDPOINT + ModelScope）')
    expect(item).not.toBeNull()
    expect(item!.type).toBe('docs')
    expect(item!.title).toBe('补充模型下载镜像配置文档（HF_ENDPOINT + ModelScope）')
  })

  it('detects type from title keywords when no tag', () => {
    const item = parseTodoLine('- [x] #209 TreeSelect + Form 警告 bug（PR #210 Open）')
    expect(item).not.toBeNull()
    expect(item!.type).toBe('bug')
  })

  it('returns null for non-checkbox lines', () => {
    expect(parseTodoLine('')).toBeNull()
    expect(parseTodoLine('## Heading')).toBeNull()
    expect(parseTodoLine('some text')).toBeNull()
  })

  it('sets difficulty to null', () => {
    const item = parseTodoLine('- [ ] #100 Some task')
    expect(item!.difficulty).toBeNull()
  })

  it('sets created and updated to today', () => {
    const today = new Date().toISOString().slice(0, 10)
    const item = parseTodoLine('- [ ] #100 Some task')
    expect(item!.created).toBe(today)
    expect(item!.updated).toBe(today)
  })
})

// ────────────────────────────────────────────
// Unit tests for parseTodosMd
// ────────────────────────────────────────────

describe('parseTodosMd', () => {
  it('parses multiple lines', () => {
    const content = [
      '- [x] #63 Notification 单元测试',
      '- [ ] #168 Modal 函数调用国际化问题',
      '- [ ] Tree/DirectoryTree 泛型支持',
    ].join('\n')

    const items = parseTodosMd(content)
    expect(items).toHaveLength(3)
    expect(items[0]!.status).toBe('done')
    expect(items[1]!.status).toBe('idea')
    expect(items[2]!.ref).toBeNull()
  })

  it('skips blank lines and headings', () => {
    const content = [
      '## My Todos',
      '',
      '- [x] #1 Done task',
      '',
      '- [ ] #2 Open task',
    ].join('\n')

    const items = parseTodosMd(content)
    expect(items).toHaveLength(2)
  })

  it('parses CoPaw format correctly', () => {
    const content = [
      '- [ ] #281 [Docs] 补充模型下载镜像配置文档（HF_ENDPOINT + ModelScope）',
      '- [ ] #313 [Bug] 修复 Windows copaw.cmd UTF-8 BOM 导致无限循环',
      '- [ ] #159 [Feature] 补充单元测试 + 完善贡献指南',
      '- [ ] #295 [Feature] WebUI 聊天中 ECharts 图表内联渲染',
    ].join('\n')

    const items = parseTodosMd(content)
    expect(items).toHaveLength(4)
    expect(items[0]!.type).toBe('docs')
    expect(items[1]!.type).toBe('bug')
    expect(items[2]!.type).toBe('feature')
    expect(items[3]!.type).toBe('feature')
  })
})

// ────────────────────────────────────────────
// Integration test for migrateTodos
// ────────────────────────────────────────────

describe('migrateTodos', () => {
  let tmpDir: string
  let origHome: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'migrate-test-'))
    origHome = process.env.HOME ?? ''
    // Override HOME so homedir() returns our temp dir
    process.env.HOME = tmpDir
  })

  afterEach(() => {
    process.env.HOME = origHome
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('migrates antdv-next format todos.md to todos.yaml', () => {
    const contribDir = join(tmpDir, '.contribbot', 'antdv-next', 'antdv-next')
    mkdirSync(contribDir, { recursive: true })

    const mdContent = [
      '- [x] #63 Notification 单元测试（测试任务系列最后一个）',
      '- [ ] #168 Modal 函数调用国际化问题（待方案设计）',
      '- [x] #209 TreeSelect + Form 警告 bug（PR #210 Open）',
      '- [ ] Tree/DirectoryTree 泛型支持：当前方案 A',
    ].join('\n')

    writeFileSync(join(contribDir, 'todos.md'), mdContent)

    const result = migrateTodos('antdv-next/antdv-next')

    expect(result).toContain('Migration complete')
    expect(result).toContain('4')

    // Verify todos.yaml was created
    const yamlPath = join(contribDir, 'todos.yaml')
    expect(existsSync(yamlPath)).toBe(true)

    // Verify todos.md was renamed to .bak
    expect(existsSync(join(contribDir, 'todos.md'))).toBe(false)
    expect(existsSync(join(contribDir, 'todos.md.bak'))).toBe(true)

    // Verify YAML content
    const yamlContent = readFileSync(yamlPath, 'utf-8')
    const data = parse(yamlContent) as { todos: TodoItem[] }
    expect(data.todos).toHaveLength(4)

    // Check first item (done)
    expect(data.todos[0]!.ref).toBe('#63')
    expect(data.todos[0]!.status).toBe('done')

    // Check open item
    expect(data.todos[1]!.ref).toBe('#168')
    expect(data.todos[1]!.status).toBe('idea')

    // Check PR extraction
    expect(data.todos[2]!.pr).toBe(210)

    // Check null ref
    expect(data.todos[3]!.ref).toBeNull()
  })

  it('migrates CoPaw format todos.md', () => {
    const contribDir = join(tmpDir, '.contribbot', 'agentscope-ai', 'CoPaw')
    mkdirSync(contribDir, { recursive: true })

    const mdContent = [
      '- [ ] #281 [Docs] 补充模型下载镜像配置文档（HF_ENDPOINT + ModelScope）',
      '- [ ] #313 [Bug] 修复 Windows copaw.cmd UTF-8 BOM 导致无限循环',
      '- [ ] #159 [Feature] 补充单元测试 + 完善贡献指南',
      '- [ ] #295 [Feature] WebUI 聊天中 ECharts 图表内联渲染',
    ].join('\n')

    writeFileSync(join(contribDir, 'todos.md'), mdContent)

    const result = migrateTodos('agentscope-ai/CoPaw')

    expect(result).toContain('Migration complete')
    expect(result).toContain('4')

    const yamlPath = join(contribDir, 'todos.yaml')
    const yamlContent = readFileSync(yamlPath, 'utf-8')
    const data = parse(yamlContent) as { todos: TodoItem[] }

    expect(data.todos[0]!.type).toBe('docs')
    expect(data.todos[0]!.title).toBe('补充模型下载镜像配置文档（HF_ENDPOINT + ModelScope）')
    expect(data.todos[1]!.type).toBe('bug')
    expect(data.todos[2]!.type).toBe('feature')
    expect(data.todos[3]!.type).toBe('feature')

    // All should be idea (unchecked)
    data.todos.forEach((t) => {
      expect(t.status).toBe('idea')
    })
  })

  it('returns message when todos.md does not exist', () => {
    const contribDir = join(tmpDir, '.contribbot', 'test', 'repo')
    mkdirSync(contribDir, { recursive: true })

    const result = migrateTodos('test/repo')
    expect(result).toContain('No todos.md found')
  })

  it('skips migration when todos.yaml already exists', () => {
    const contribDir = join(tmpDir, '.contribbot', 'test', 'repo')
    mkdirSync(contribDir, { recursive: true })

    writeFileSync(join(contribDir, 'todos.md'), '- [ ] #1 Test')
    writeFileSync(join(contribDir, 'todos.yaml'), 'todos:\n  - ref: "#1"\n    title: Existing\n    type: chore\n    status: idea\n    difficulty: null\n    pr: null\n    created: "2026-01-01"\n    updated: "2026-01-01"\n')

    const result = migrateTodos('test/repo')
    expect(result).toContain('already exists')
    expect(result).toContain('Skipping migration')
  })

  it('returns message when todos.md has no items', () => {
    const contribDir = join(tmpDir, '.contribbot', 'test', 'repo')
    mkdirSync(contribDir, { recursive: true })

    writeFileSync(join(contribDir, 'todos.md'), '## Empty file\n\nNo todos here.')

    const result = migrateTodos('test/repo')
    expect(result).toContain('No todo items found')
  })
})
