import { execFileSync } from 'node:child_process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

function checkAuth(): 'token' | 'gh-cli' {
  if (process.env.GITHUB_TOKEN) {
    return 'token'
  }

  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' })
    return 'gh-cli'
  }
  catch {
    console.error(`
[contrib] GitHub auth not configured. Please set up one of:

  Option A - gh CLI (recommended):
    gh auth login

  Option B - GitHub Token:
    Set GITHUB_TOKEN environment variable in .mcp.json:
    {
      "mcpServers": {
        "contrib": {
          "command": "npx",
          "args": ["tsx", "packages/contrib/src/mcp/index.ts"],
          "env": { "GITHUB_TOKEN": "<your-token>" }
        }
      }
    }
`)
    process.exit(1)
  }
}

async function main() {
  const authMode = checkAuth()
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`contrib MCP server running (auth: ${authMode})`)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
