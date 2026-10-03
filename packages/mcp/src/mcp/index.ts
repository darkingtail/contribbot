import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

async function main() {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  if (process.env.CONTRIBBOT_QUIET !== '1') {
    console.error('contribbot MCP server running (platform authentication is checked on use)')
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
