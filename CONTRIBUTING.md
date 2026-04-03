# Contributing

## Setup

```bash
git clone https://github.com/darkingtail/contribbot.git
cd contribbot
pnpm install
```

## Development

```bash
pnpm build        # Build MCP server
pnpm dev          # Run MCP server with tsx (debug)
pnpm test         # Run tests
```

## Project Structure

```
contribbot/
├── packages/mcp/         # contribbot-mcp (npm package)
│   └── src/
│       ├── core/
│       │   ├── clients/  # GitHub API client (gh CLI / GITHUB_TOKEN)
│       │   ├── storage/  # YAML persistence (todo-store, upstream-store, repo-config, record-files)
│       │   ├── tools/    # Three-layer tool classification
│       │   │   ├── core/     # contribbot unique tools
│       │   │   ├── linkage/  # GitHub ops + local data sync
│       │   │   └── compat/   # GitHub API wrappers
│       │   ├── utils/    # Config, format, frontmatter, fs, resolve-repo
│       │   └── enums.ts  # as const enums + runtime validation
│       └── mcp/
│           ├── index.ts  # MCP server entry (stdio)
│           └── server.ts # Tool registration + INSTRUCTIONS + Prompts
├── skills/               # Skills (MCP tool orchestration, one per directory)
├── docs/                 # Documentation
│   ├── design.md         # Architecture and design decisions
│   ├── tools.md          # Full tool reference
│   ├── platforms.md      # Multi-platform setup guide
│   ├── concepts/         # Design concepts (project modes, competitive research)
│   └── plans/            # Historical design decisions
├── .claude-plugin/       # Claude Code plugin metadata
└── .mcp.json             # MCP server config
```

## Architecture

### Three-Layer Tool Classification

- **Core** — contribbot unique: todo management, upstream tracking, knowledge, config. Cannot be replaced by GitHub MCP.
- **Linkage** — GitHub operations that also update local data (e.g., `issue_create` auto-creates a todo).
- **Compat** — Pure GitHub API wrappers. Ensures contribbot works without GitHub MCP installed.

### Design Principles

- **Tools don't make qualitative judgments** — subtask identification, branch naming, noise filtering are LLM responsibilities
- **Templates are files** — `templates/` directory, auto-generated on first use with documented variables
- **Todo = record** — `todo_add` creates implementation doc immediately
- **User confirmation** — `todo_activate` generates plan draft, user confirms before writing

### Data Flow

```
server.ts (registration layer)
    ↓ wrapHandler
tools/*.ts (business logic)
    ↓
storage/*.ts (YAML read/write)
```

Registration layer only maps params and wraps errors. Business logic lives in tool functions. Storage layer is pure CRUD.

## Commit Style

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add upstream_compact tool
fix: archive preserves not_planned status
refactor: rename skill_write to knowledge_write
docs: update README with compact usage
test: add compact unit tests
chore: bump version to 0.0.2
```

## Testing

```bash
pnpm test                    # Run all tests
pnpm --filter contribbot-mcp test   # Run MCP package tests only
```

Tests cover storage layer (TodoStore, UpstreamStore, RecordFiles, RepoConfig) and utility functions. Tool-level integration tests run via MCP protocol against `darkingtail/contribbot-test` repo.

## Publishing

See project memory for npm publish procedures. Key rule: **test thoroughly before publishing** — npm version numbers cannot be reused.
