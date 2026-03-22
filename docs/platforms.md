# Other Platforms Setup

contribbot's MCP server works with any MCP-compatible tool. Below are configuration guides for each platform.

## Claude Desktop

Add to config file (Settings → Developer → Edit Config):

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "contribbot": {
      "command": "npx",
      "args": ["-y", "contribbot-mcp@latest"]
    }
  }
}
```

## Gemini CLI

```bash
gemini mcp add contribbot -- npx -y contribbot-mcp@latest
```

Or manually add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "contribbot": {
      "command": "npx",
      "args": ["-y", "contribbot-mcp@latest"]
    }
  }
}
```

## Codex CLI

```bash
codex mcp add contribbot -- npx -y contribbot-mcp@latest
```

Or manually add to `~/.codex/config.toml`:

```toml
[mcp_servers.contribbot]
command = "npx"
args = ["-y", "contribbot-mcp@latest"]
startup_timeout_sec = 30
```

> Codex CLI default startup timeout is 10 seconds. Set `startup_timeout_sec = 30` for first-time npx download.

## Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "contribbot": {
      "command": "npx",
      "args": ["-y", "contribbot-mcp@latest"]
    }
  }
}
```

## Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "contribbot": {
      "command": "npx",
      "args": ["-y", "contribbot-mcp@latest"]
    }
  }
}
```

## VS Code (GitHub Copilot)

Add to `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "contribbot": {
      "command": "npx",
      "args": ["-y", "contribbot-mcp@latest"]
    }
  }
}
```

## Zed

Add to `~/.config/zed/settings.json` (note: uses `context_servers`, not `mcpServers`):

```json
{
  "context_servers": {
    "contribbot": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "contribbot-mcp@latest"]
    }
  }
}
```

## Platform Support Summary

| Platform | Tools | Skills | MCP Prompts | Install Method |
|----------|-------|--------|-------------|----------------|
| Claude Code | ✅ | ✅ via plugin | ✅ | `claude plugin install` |
| Claude Desktop | ✅ | — | ✅ | JSON config |
| Gemini CLI | ✅ | — | ✅ | CLI or JSON config |
| Codex CLI | ✅ | — | ✅ | CLI or TOML config |
| Cursor | ✅ | — | ✅ | JSON config |
| Windsurf | ✅ | — | ✅ | JSON config |
| VS Code | ✅ | — | ✅ | JSON config |
| Zed | ✅ | — | ✅ | JSON config (`context_servers`) |

> Skills are Claude Code plugin-specific. Other platforms get MCP tools + prompts. Skills are markdown workflow instructions — any platform can use them by loading the `skills/*/SKILL.md` content as context.
