import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from './server.js'
import { RepoConfig } from '../core/storage/repo-config.js'
import { TodoStore } from '../core/storage/todo-store.js'
import { projectDirectory, repositoryDisplay, repositoryRefSchema, type RepositoryRef } from '../core/utils/repository-ref.js'
import type { WorkflowPlanInput } from '../core/execution/contracts.js'

const repositories: RepositoryRef[] = [
  { platform: 'gitlab', instance: 'http://code.example.test:8443/gitlab', path: 'team/subgroup/app' },
  { platform: 'gitlab', instance: 'https://code.example.test:8443/gitlab', path: 'team/subgroup/app' },
  { platform: 'github', instance: 'https://github.com', path: 'fixture/app' },
]
const plan: WorkflowPlanInput = {
  goal: 'Inspect a synthetic project', completion_scope: 'task', remaining_scope: [],
  scope: ['.'], risk: 'normal', non_goals: [],
  steps: [{ id: 'inspect', title: 'Inspect', scope: ['.'], depends_on: [], acceptance_ids: ['manual'] }],
  acceptance: [{ id: 'manual', description: 'Synthetic criterion', kind: 'manual', independent: false, required: true }],
}
const propose = { action: 'propose_plan', plan_id: 'plan', plan }
const pause = {
  action: 'request_control', control_id: 'pause', kind: 'pause',
  decision: 'fixture:user-pause', note: 'Synthetic request only.',
}

describe.each(['memory', 'stdio'] as const)('public response identity over %s MCP', transportKind => {
  let home: string
  let client: Client
  let server: ReturnType<typeof createServer> | undefined
  let transport: StdioClientTransport | undefined
  const network = vi.fn(async () => { throw new Error('Unexpected network request in offline fixture.') })
  const seed = (repository: RepositoryRef) => {
    const directory = projectDirectory(repository)
    new RepoConfig(directory).save({
      schema_version: 3, repository, lifecycle: { status: 'active' },
      parent: { status: 'unknown' }, tracking: { status: 'pending' },
    })
    const store = new TodoStore(directory)
    const todoId = store.add({ ref: 'managed', title: repository.instance, type: 'chore' }).id!
    const executionId = store.activateExecution(0).execution.id
    const cancelId = store.add({ ref: 'unstarted', title: 'Unstarted fixture', type: 'chore' }).id!
    return { repository, directory, store, todoId, executionId, cancelId }
  }
  let projects: ReturnType<typeof seed>[]
  const args = (project: ReturnType<typeof seed>) => ({
    repo: project.repository, todo_id: project.todoId, execution_id: project.executionId,
  })
  const yaml = (project: ReturnType<typeof seed>) => readFileSync(join(project.directory, 'todos.yaml'))
  const configs = () => projects.map(project => readFileSync(join(project.directory, 'config.yaml')))
  const revision = (project: ReturnType<typeof seed>) => project.store.get(0)!.executions[0]!.workflow?.revision ?? 0
  const call = (name: string, input: Record<string, unknown>) => client.callTool({ name, arguments: input })

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mcp-response-identity-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    network.mockClear()
    vi.stubGlobal('fetch', network)
    projects = repositories.map(seed)
    client = new Client({ name: 'response-identity-test', version: '1' })
    if (transportKind === 'memory') {
      server = createServer()
      const [a, b] = InMemoryTransport.createLinkedPair()
      await Promise.all([client.connect(a), server.connect(b)])
    }
    else {
      const env: Record<string, string> = {
        HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        XDG_CONFIG_HOME: home, GH_CONFIG_DIR: join(home, 'gh'),
        PATH: join(home, 'no-executables'), CONTRIBBOT_GITLAB_CREDENTIAL_BINDINGS: '[]',
      }
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]!
      }
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../../../../scripts/dev-mcp.mjs', import.meta.url))],
        cwd: home, env, stderr: 'pipe',
      })
      await client.connect(transport)
    }
  }, 20_000)

  afterEach(async () => {
    await client?.close()
    await transport?.close()
    await server?.close()
    transport = undefined
    server = undefined
    expect(network).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    expect(dirname(resolve(home))).toBe(resolve(tmpdir()))
    expect(home).toContain('mcp-response-identity-')
    rmSync(home, { recursive: true, force: true })
  })

  function structured(result: Awaited<ReturnType<typeof call>>, repository: RepositoryRef) {
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(result.structuredContent).toBeDefined()
    const body = result.structuredContent as Record<string, unknown>
    const content = result.content as { type: string; text: string }[]
    expect(JSON.parse(content[0]!.text)).toEqual(body)
    expect(body.schema_version).toBe(1)
    expect.soft(body.repo).toEqual(repository)
    expect.soft(repositoryRefSchema.safeParse(body.repo).success).toBe(true)
    return body
  }

  it.each(['todo_context', 'todo_resume', 'todo_check'])('%s returns a reusable identity without changing Todo state', async name => {
    const beforeConfig = configs()
    const beforeTodos = projects.map(yaml)
    for (const project of projects) {
      const body = structured(await call(name, args(project)), project.repository)
      const echoed = await call('todo_context', { ...args(project), repo: body.repo })
      expect.soft(echoed.isError).not.toBe(true)
      expect.soft(echoed.structuredContent).toMatchObject({ repo: project.repository, todo: { id: project.todoId } })
    }
    expect(new Set(projects.map(project => project.directory)).size).toBe(3)
    expect(projects.map(yaml)).toEqual(beforeTodos)
    expect(configs()).toEqual(beforeConfig)
  })

  it('preserves reusable identity, revisions and lifecycle rules across plan, control and cancellation', async () => {
    const beforeConfig = configs()
    for (const project of projects) {
      const others = projects.filter(other => other !== project)
      const otherBytes = others.map(yaml)
      const proposed = structured(await call('todo_plan', {
        ...args(project), request_id: 'plan', expected_revision: 0, command: propose,
      }), project.repository)
      const controlled = structured(await call('todo_control', {
        ...args(project), request_id: 'pause', expected_revision: revision(project), command: pause,
      }), project.repository)
      const cancelled = structured(await call('todo_cancel', {
        repo: project.repository, todo_id: project.cancelId, expected_lifecycle_revision: 0,
        decision: 'fixture:user-cancel',
      }), project.repository)
      for (const [body, todoId] of [[proposed, project.todoId], [controlled, project.todoId], [cancelled, project.cancelId]] as const) {
        const echoed = await call('todo_context', { repo: body.repo, todo_id: todoId })
        expect.soft(echoed.isError).not.toBe(true)
        expect.soft(echoed.structuredContent).toMatchObject({ repo: project.repository, todo: { id: todoId } })
      }
      const beforeStale = yaml(project)
      for (const [name, input] of [
        ['todo_plan', { ...args(project), request_id: 'stale-plan', expected_revision: 0, command: propose }],
        ['todo_control', { ...args(project), request_id: 'stale-pause', expected_revision: 0, command: pause }],
        ['todo_cancel', { repo: project.repository, todo_id: project.cancelId, expected_lifecycle_revision: 0, decision: 'fixture:stale' }],
        ['todo_cancel', { repo: project.repository, todo_id: project.todoId, expected_lifecycle_revision: 0, decision: 'fixture:managed' }],
      ] as const) {
        expect((await call(name, input)).isError).toBe(true)
      }
      expect(yaml(project)).toEqual(beforeStale)
      expect(project.store.get(0)!.status).toBe('active')
      expect(project.store.get(1)).toMatchObject({ status: 'cancelled', executions: [] })
      expect(project.store.listArchived()).toEqual([])
      expect(others.map(yaml)).toEqual(otherBytes)
    }
    expect(configs()).toEqual(beforeConfig)
  })

  it('rejects missing, shorthand, incomplete and noncanonical identities without implicit project binding', async () => {
    const project = projects[0]!
    await call('todo_context', args(project))
    const beforeTodos = projects.map(yaml)
    const beforeConfig = configs()
    for (const name of ['todo_context', 'todo_resume', 'todo_check', 'todo_plan', 'todo_control', 'todo_operation', 'todo_cancel', 'project_status']) {
      for (const repo of [undefined, project.repository.path, { platform: 'gitlab', path: project.repository.path },
        { ...project.repository, instance: `${project.repository.instance}/` }]) {
        const command = name === 'todo_plan' ? propose : name === 'todo_control' ? pause : {
          action: 'begin_operation', operation_id: 'op', actor: 'primary', kind: 'read',
          delegated: false, step_id: 'inspect', scope: ['.'], purpose: 'Synthetic observation',
        }
        const result = await call(name, {
          ...args(project), repo, request_id: 'invalid', expected_revision: 0, command,
          expected_lifecycle_revision: 0, decision: 'fixture:invalid',
        })
        expect(result.isError, name).toBe(true)
        expect(JSON.stringify(result.content), name).toContain('repo')
      }
    }
    expect(projects.map(yaml)).toEqual(beforeTodos)
    expect(configs()).toEqual(beforeConfig)
  })

  it('returns project identity in all lifecycle states without changing its text-only protocol or creating data', async () => {
    const variants: RepositoryRef[] = [
      ...repositories,
      { ...repositories[1]!, instance: 'https://code.example.test/gitlab' },
      { ...repositories[1]!, instance: 'https://code.example.test:8443/GitLab' },
    ]
    const labels: string[] = []
    for (const repository of variants) {
      const directory = projectDirectory(repository)
      const config = new RepoConfig(directory)
      for (const status of ['active', 'archived', 'not_initialized'] as const) {
        const input = status === 'not_initialized' ? { ...repository, path: `${repository.path}-missing` } : repository
        const targetDirectory = projectDirectory(input)
        const archivedAt = status === 'archived' ? '2026-10-03T00:00:00Z' : null
        if (status !== 'not_initialized') {
          const lifecycle = status === 'archived' ? { status, archived_at: archivedAt! } : { status }
          const current = config.load()
          if (current) config.update({ lifecycle }, current)
          else config.save({
            schema_version: 3, repository, lifecycle,
            parent: { status: 'unknown' }, tracking: { status: 'pending' },
          })
        }
        const before = status === 'not_initialized' ? null : readFileSync(join(directory, 'config.yaml'))
        const result = await call('project_status', { repo: input })
        expect(result.isError).not.toBe(true)
        expect(result.structuredContent).toBeUndefined()
        const content = result.content as { type: string; text: string }[]
        expect(content).toHaveLength(1)
        expect(content[0]!.type).toBe('text')
        const body = JSON.parse(content[0]!.text)
        expect.soft(body).toEqual({
          repository: input, repo: repositoryDisplay(input), configured: status !== 'not_initialized',
          status, archived_at: archivedAt,
        })
        expect.soft(repositoryRefSchema.safeParse(body.repository).success).toBe(true)
        if (status === 'active') labels.push(body.repo)
        if (status === 'not_initialized') expect(existsSync(targetDirectory)).toBe(false)
        else expect(readFileSync(join(directory, 'config.yaml'))).toEqual(before)
      }
    }
    expect(labels[0]).toBe(labels[1])
    expect(new Set(variants.map(repository => projectDirectory(repository))).size).toBe(variants.length)
  })
})
