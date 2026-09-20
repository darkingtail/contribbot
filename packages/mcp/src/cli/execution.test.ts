import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoStore } from '../core/storage/todo-store.js'

const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url))
const cli = fileURLToPath(new URL('./execution.ts', import.meta.url))

describe('execution CLI request discovery', () => {
  let home: string
  let preserveHome: boolean
  const call = (...args: string[]) => spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: home, encoding: 'utf8', timeout: 15_000, windowsHide: true,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    maxBuffer: 2 * 1024 * 1024,
  })
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'contribbot-cli-help-'))
    preserveHome = false
  })
  afterEach(() => { if (!preserveHome) rmSync(home, { recursive: true, force: true }) })

  it.each(['--schema', '--help'])('discovers check input via %s without reading a broken request or initializing storage', flag => {
    const file = join(home, 'broken.json')
    writeFileSync(file, '{not-json')
    const result = call('check', flag, '--request', file, '--data-root', join(home, 'unused'))
    expect(result.status, result.stderr + result.stdout).toBe(0)
    if (flag === '--schema') {
      const schema = JSON.parse(result.stdout)
      expect(schema.type).toBe('object')
      expect(schema.required).toContain('acceptance_id')
      expect(schema.properties).not.toHaveProperty('directory')
      expect(schema.properties).not.toHaveProperty('repo')
      expect(schema['x-contribbot'].validation).toBe('structure-only')
    }
    else {
      expect(result.stdout).toContain('acceptance_id')
      expect(result.stdout).toContain('expected_revision')
    }
    expect(readdirSync(home)).toEqual(['broken.json'])
    expect(readFileSync(file, 'utf8')).toBe('{not-json')
  })

  it.each(['--schema', '--help'])('does not open a missing request with %s', flag => {
    const result = call('check', flag, '--request', join(home, 'missing.json'))
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(readdirSync(home)).toEqual([])
  })

  it.each(['--schema', '--help'])('returns %s while request stdin remains open without EOF', async flag => {
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
    const child = spawn(process.execPath, ['--import', loader, cli, 'report', flag, '--request', '-'], {
      cwd: home, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home },
    })
    let output = ''
    let error = ''
    let closed = false
    child.stdout.on('data', data => { output = (output + data).slice(-65536) })
    child.stderr.on('data', data => { error = (error + data).slice(-65536) })
    child.on('error', failure => { error += String(failure) })
    child.stdin.on('error', () => {})
    const done = new Promise<number | null>(resolve => child.once('close', code => {
      closed = true
      resolve(code)
    }))
    try {
      // Deliberately do not write to or close stdin until after the CLI has exited.
      await vi.waitFor(() => expect(closed, error + output).toBe(true), { timeout: 5000 })
      expect(await done, error + output).toBe(0)
      if (flag === '--schema') {
        const schema = JSON.parse(output)
        expect(schema.required).toEqual(expect.arrayContaining(['candidate', 'observed_at', 'plan_id', 'attempt_id', 'epoch']))
      }
      expect(readdirSync(home)).toEqual([])
    }
    finally {
      child.stdin.end()
      try { await vi.waitFor(() => expect(closed, error + output).toBe(true), { timeout: 3000 }) }
      catch {
        child.kill('SIGKILL')
        try { await vi.waitFor(() => expect(closed, error + output).toBe(true), { timeout: 3000 }) }
        catch (failure) { preserveHome = true; throw failure }
      }
      await done
    }
  }, 20_000)

  it('offers global action discovery without requiring a request', () => {
    const result = call('--help')
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(result.stdout).toContain('delegate-prepare')
    expect(readdirSync(home)).toEqual([])
  })

  it.each([
    ['missing-action', '--help'], ['missing-action', '--schema'],
    ['--schema'], ['check', 'report', '--help'],
    ['check', '--schema', '--unknown'], ['check', '--help', '--schema'],
  ])('rejects invalid discovery arguments %j', (...args) => {
    const result = call(...args)
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).error.code).toBe('execution_error')
    expect(readdirSync(home)).toEqual([])
  })

  it('uses discovered structures to read, propose and replay an isolated task without Git or GitHub', () => {
    const data = join(home, 'data')
    const store = new TodoStore(join(data, 'fixture', 'discovery'))
    const todo = store.add({ ref: 'docs', title: 'Document a function', type: 'docs' })
    const execution = store.activateExecution(0).execution
    const todo_id = todo.id!
    const execution_id = execution.id
    const schemaFor = (action: string) => {
      const result = call(action, '--schema')
      expect(result.status, result.stderr + result.stdout).toBe(0)
      return JSON.parse(result.stdout)
    }
    const run = (action: string, payload: Record<string, unknown>) => {
      const file = join(home, 'request.json')
      writeFileSync(file, JSON.stringify(payload))
      const result = call(action, '--repo', 'fixture/discovery', '--data-root', data, '--request', file)
      expect(result.status, result.stderr + result.stdout).toBe(0)
      return JSON.parse(result.stdout)
    }
    const contextSchema = schemaFor('context')
    expect(contextSchema.required).toEqual(['todo_id'])
    const context = run('context', { todo_id })
    expect(context.workflow_revision).toBe(0)
    expect(context.execution.workflow).toBeUndefined()
    const applySchema = schemaFor('apply')
    const commands = applySchema.properties.command.anyOf
    expect(commands.map((item: { properties: { action: { const: string } } }) => item.properties.action.const).sort()).toEqual([
      'adopt_operation', 'begin_operation', 'confirm_plan', 'mark_unknown', 'propose_plan', 'request_control', 'return_operation',
    ])
    const plan = {
      goal: 'Explain the function inputs', completion_scope: 'task', remaining_scope: [], non_goals: [], scope: ['README.md'], risk: 'normal',
      steps: [{ id: 'write', title: 'Document', scope: ['README.md'], depends_on: [], acceptance_ids: ['review'] }],
      acceptance: [{ id: 'review', description: 'Review actual input examples', kind: 'manual', independent: false, required: true }],
    }
    const request = {
      todo_id, execution_id, request_id: 'propose', expected_revision: context.workflow_revision,
      command: { action: 'propose_plan', plan_id: 'plan', plan },
    }
    const first = run('apply', request)
    expect(first.workflow.plans[0].content).toEqual(plan)
    const repeated = run('apply', request)
    expect(repeated.workflow).toEqual(first.workflow)
    const resumed = run('resume', { todo_id, execution_id })
    expect(resumed.workflow_revision).toBe(first.workflow.revision)
    expect(resumed.execution.workflow.plans).toHaveLength(1)
    const before = store.list()
    writeFileSync(join(home, 'request.json'), JSON.stringify({
      ...request, request_id: 'internal', expected_revision: first.workflow.revision,
      command: { action: 'finish_closure', closure_id: 'fake' },
    }))
    const refused = call('apply', '--repo', 'fixture/discovery', '--data-root', data, '--request', join(home, 'request.json'))
    expect(refused.status).toBe(1)
    expect(JSON.parse(refused.stdout).error.message).toMatch(/Internal\/local action/)
    expect(store.list()).toEqual(before)
  }, 30_000)
})
