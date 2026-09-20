import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from './server.js'

describe('createServer tool schemas', () => {
  let client: Client | undefined
  let server: ReturnType<typeof createServer> | undefined

  async function listTools() {
    server = createServer()
    client = new Client({ name: 'contribbot-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ])
    return client.listTools()
  }

  afterEach(async () => {
    await client?.close()
    await server?.close()
    client = undefined
    server = undefined
  })

  it('marks concrete repository tools as requiring repo', async () => {
    const { tools } = await listTools()
    const projectDashboard = tools.find(t => t.name === 'project_dashboard')

    expect(projectDashboard).toBeDefined()
    expect(projectDashboard!.inputSchema.required ?? []).toContain('repo')
  })

  it('keeps cross-project stats repo optional', async () => {
    const { tools } = await listTools()
    const contributionStats = tools.find(t => t.name === 'contribution_stats')

    expect(contributionStats?.inputSchema.required ?? []).not.toContain('repo')
  })

  it('registers knowledge evolution tools requiring repo', async () => {
    const { tools } = await listTools()
    const names = tools.map(t => t.name)
    for (const tool of ['knowledge_propose_update', 'knowledge_proposals', 'knowledge_apply_update', 'knowledge_reject_update', 'knowledge_rollback_update']) {
      expect(names).toContain(tool)
      expect(tools.find(t => t.name === tool)!.inputSchema.required ?? []).toContain('repo')
    }
  })

  it('registers project initialization as a repository-scoped tool', async () => {
    const { tools } = await listTools()
    const init = tools.find(t => t.name === 'project_init')

    expect(init).toBeDefined()
    expect(init!.inputSchema.required ?? []).toContain('repo')
  })

  it('registers lifecycle tools and an optional global list filter', async () => {
    const { tools } = await listTools()
    for (const name of ['project_archive', 'project_restore', 'project_status']) {
      expect(tools.find(t => t.name === name)?.inputSchema.required).toContain('repo')
    }
    const list = tools.find(t => t.name === 'project_list')!
    expect(list.inputSchema.properties).toHaveProperty('status')
    expect(list.inputSchema.required ?? []).not.toContain('repo')
    expect(list.inputSchema.required ?? []).not.toContain('status')
    const result = await client!.callTool({ name: 'project_list', arguments: { status: 'invalid' } })
    expect(result.isError).toBe(true)
  })

  it('registers patrol audit and recovery tools as repository-scoped', async () => {
    const { tools } = await listTools()
    for (const name of ['patrol_record', 'patrol_run_get']) {
      const tool = tools.find(t => t.name === name)
      expect(tool).toBeDefined()
      expect(tool!.inputSchema.required ?? []).toContain('repo')
    }
  })

  it('registers project guidance as a repository-scoped tool', async () => {
    const { tools } = await listTools()
    const guidance = tools.find(t => t.name === 'project_guidance')

    expect(guidance).toBeDefined()
    expect(guidance!.inputSchema.required ?? []).toContain('repo')
  })

  it('registers structured todo progress as a repository-scoped tool', async () => {
    const { tools } = await listTools()
    const progress = tools.find(t => t.name === 'todo_progress')

    expect(progress).toBeDefined()
    expect(progress!.inputSchema.required ?? []).toContain('repo')
    expect(progress!.inputSchema.required ?? []).toContain('item')
    expect(progress!.inputSchema.properties).toHaveProperty('phase')
    expect(progress!.inputSchema.properties).toHaveProperty('evidence')
  })

  it('keeps todo completion on the canonical todo_done tool', async () => {
    const { tools } = await listTools()
    const update = tools.find(t => t.name === 'todo_update')!
    const status = update.inputSchema.properties!.status as { enum?: string[] }

    expect(status.enum).toEqual(['idea', 'backlog', 'active'])
    expect(status.enum).not.toContain('done')
    expect(update.description).toContain('todo_done')
    const cancel = tools.find(t => t.name === 'todo_cancel')!
    expect(cancel.inputSchema.required).toEqual(expect.arrayContaining([
      'repo', 'todo_id', 'expected_lifecycle_revision', 'decision',
    ]))
    expect(cancel.inputSchema.properties).not.toHaveProperty('execution_id')
    const list = tools.find(t => t.name === 'todo_list')!
    const filter = list.inputSchema.properties!.status as { enum: string[] }
    expect([...filter.enum].sort()).toEqual(['active', 'backlog', 'cancelled', 'done', 'idea', 'paused'])
  })

  it('delivers consistent one-decision completion guidance to MCP hosts', async () => {
    const { tools } = await listTools()
    const instructions = client!.getInstructions()
    expect(instructions).not.toContain('完成 todo 相关工作后：主动询问用户是否标记 todo_done')
    expect(instructions).toContain('缺少完成决定时')
    expect(instructions).toContain('待评价结果已存在')
    expect(instructions).toContain('不能代填未观察的人工项')
    expect(instructions).not.toContain('todo_done → todo_archive')
    expect(tools.find(tool => tool.name === 'todo_done')?.description).toContain('same user statement')
  })

  it('keeps both weekly review prompts on preview-first explicit archival', async () => {
    await listTools()
    const cases: Record<string, string>[] = [{ repo: 'workflow-fixture/repo' }, {}]
    for (const args of cases) {
      const prompt = await client!.getPrompt({ name: 'weekly-review', arguments: args })
      const text = prompt.messages
        .map(message => message.content.type === 'text' ? message.content.text : '')
        .join('\n')
      expect(text).toContain('preview ended todos only')
      expect(text).toContain('user explicitly selects exact Todo IDs and preview snapshots')
      expect(text).not.toContain('clean up completed todos')
    }
  })

  it('requires an explicit force option for destructive todo archive compaction', async () => {
    const { tools } = await listTools()
    const compact = tools.find(t => t.name === 'todo_compact')

    expect(compact).toBeDefined()
    expect(compact!.inputSchema.properties).toHaveProperty('force')
  })

  it('registers repository investigation tools as repository-scoped tools', async () => {
    const { tools } = await listTools()
    for (const name of ['commit_detail', 'compare_refs']) {
      const tool = tools.find(t => t.name === name)
      expect(tool).toBeDefined()
      expect(tool!.inputSchema.required ?? []).toContain('repo')
    }
  })

  it('supports PR-specific actions inspection', async () => {
    const { tools } = await listTools()
    const actions = tools.find(t => t.name === 'actions_status')
    expect(actions?.inputSchema.properties).toHaveProperty('pr_number')
  })

  it('registers bounty tools as repository-scoped tools', async () => {
    const { tools } = await listTools()
    const names = tools.map(t => t.name)

    for (const name of [
      'bounty_create',
      'bounty_list',
      'bounty_detail',
      'bounty_claim',
      'bounty_link_pr',
      'bounty_mark_ready',
      'bounty_settle',
    ]) {
      const tool = tools.find(t => t.name === name)
      expect(names).toContain(name)
      expect(tool?.inputSchema.required ?? []).toContain('repo')
    }
  })
})


describe('upstream confirmation tool guidance', () => {
  it('exposes pending and explicit-none semantics to MCP hosts', async () => {
    const server = createServer()
    const client = new Client({ name: 'init-contract-test', version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    try {
      await Promise.all([client.connect(a), server.connect(b)])
      const { tools } = await client.listTools()
      expect(tools.find(t => t.name === 'project_init')?.description).toContain('pending')
      expect(tools.find(t => t.name === 'project_init')?.description).toContain('ask')
      expect(tools.find(t => t.name === 'repo_config')?.description).toContain('confirms none')
    } finally { await client.close(); await server.close() }
  })
})
