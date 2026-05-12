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
})
