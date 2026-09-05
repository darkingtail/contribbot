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
    for (const tool of ['knowledge_propose_update', 'knowledge_proposals', 'knowledge_apply_update', 'knowledge_reject_update']) {
      expect(names).toContain(tool)
      expect(tools.find(t => t.name === tool)!.inputSchema.required ?? []).toContain('repo')
    }
  })

  it('registers project guidance as a repository-scoped tool', async () => {
    const { tools } = await listTools()
    const guidance = tools.find(t => t.name === 'project_guidance')

    expect(guidance).toBeDefined()
    expect(guidance!.inputSchema.required ?? []).toContain('repo')
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
