import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TodoStore } from '../core/storage/todo-store.js'
import { fixtureProjectDirectory, saveFixtureProjectConfig } from '../core/execution/__fixtures__/repository.js'

describe('six-state lifecycle through MCP stdio', () => {
  let home: string
  let directory: string
  let store: TodoStore
  let todoId: string
  let client: Client
  let transport: StdioClientTransport
  const repo = 'cancellation-fixture/repo'
  const repoRef = { platform: 'github', instance: 'https://github.com', path: repo } as const

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-cancel-stdio-'))
    directory = fixtureProjectDirectory(join(home, '.contribbot'), repo)
    saveFixtureProjectConfig(directory, repo)
    store = new TodoStore(directory)
    todoId = store.add({ ref: 'task', title: 'Plain task', type: 'chore' }).id!
    client = new Client({ name: 'cancellation-fixture', version: '1' })
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)), fileURLToPath(new URL('./index.ts', import.meta.url))],
      cwd: home, env: {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        HOME: home, USERPROFILE: home, GH_CONFIG_DIR: join(home, 'gh'),
        GITHUB_TOKEN: 'isolated-fixture-no-network', GH_TOKEN: 'isolated-fixture-no-network',
      },
      stderr: 'pipe',
    })
    await client.connect(transport)
  }, 15_000)
  afterEach(async () => {
    await client?.close()
    await transport?.close()
    rmSync(home, { recursive: true, force: true })
  })
  const cancel = () => client.callTool({ name: 'todo_cancel', arguments: {
    repo: repoRef, todo_id: todoId, expected_lifecycle_revision: 0, decision: 'user:cancel-this-task',
  } })

  it('cancels without execution, retries, reopens and rejects the stale original decision', async () => {
    const first = await cancel()
    expect(first.isError, JSON.stringify(first)).not.toBe(true)
    expect(first.structuredContent).toMatchObject({ archived: false, todo: { status: 'cancelled', executions: [] } })
    expect((await cancel()).isError).not.toBe(true)
    expect(store.listArchived()).toEqual([])
    const reopened = await client.callTool({ name: 'todo_reopen', arguments: { repo: repoRef, item: todoId } })
    expect(reopened.isError, JSON.stringify(reopened)).not.toBe(true)
    const before = readFileSync(join(directory, 'todos.yaml'), 'utf8')
    expect((await cancel()).isError).toBe(true)
    expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toBe(before)
    expect(store.get(0)!.status).toBe('backlog')
  })

  it('rejects old lifecycle values in both updates and filters before changing anything', async () => {
    const before = readFileSync(join(directory, 'todos.yaml'), 'utf8')
    for (const status of ['pr_submitted', 'not_planned']) {
      const update = await client.callTool({ name: 'todo_update', arguments: { repo: repoRef, item: todoId, status, branch: 'must-not-write', note: 'Must not write' } })
      expect(update.isError).toBe(true)
      expect((await client.callTool({ name: 'todo_list', arguments: { repo: repoRef, status } })).isError).toBe(true)
      expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toBe(before)
    }
  })

  it('does not allow plain cancellation to bypass an active managed control', async () => {
    const executionId = store.activateExecution(0).execution.id
    const control = await client.callTool({ name: 'todo_control', arguments: {
      repo: repoRef, todo_id: todoId, execution_id: executionId, request_id: 'pause', expected_revision: 0,
      command: { action: 'request_control', control_id: 'pause', kind: 'pause', decision: 'user:pause', note: 'Pause first.' },
    } })
    expect(control.isError, JSON.stringify(control)).not.toBe(true)
    const before = readFileSync(join(directory, 'todos.yaml'), 'utf8')
    expect((await cancel()).isError).toBe(true)
    expect(readFileSync(join(directory, 'todos.yaml'), 'utf8')).toBe(before)
    expect(store.get(0)!.executions[0]!.closed_at).toBeNull()
  })
})
