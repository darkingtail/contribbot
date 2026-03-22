# contribbot

[中文](README.zh.md) | English

Open source collaboration assistant. Helps developers efficiently maintain and contribute to open source projects.

MCP tools + skills — todo management, upstream tracking, issue/PR workflows, multi-project oversight.

## Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated (`gh auth login`)

## Install

### Claude Code

```bash
# Step 1: Add marketplace (first time only)
claude plugin marketplace add https://github.com/darkingtail/contribbot

# Step 2: Install
claude plugin install contribbot
```

This installs skills + MCP server (`contribbot-mcp`). Skills provide guided workflows, MCP server provides the tools.

### Other Platforms

contribbot's MCP server works with any MCP-compatible tool. See [Other Platforms Setup](docs/platforms.md) for Claude Desktop, Gemini CLI, Codex CLI, Cursor, Windsurf, etc.

## What contribbot does for you

Most AI coding tools can read GitHub issues and create PRs. contribbot goes further — it tracks **what you're working on**, **what changed upstream**, and **who's doing what** across multi-maintainer repos.

### vs GitHub CLI alone

|                               | gh CLI | contribbot                                    |
| ----------------------------- | ------ | --------------------------------------------- |
| Read issues/PRs               | ✅     | ✅                                            |
| Create issues/PRs             | ✅     | ✅ + auto-link to local todos                 |
| Track personal tasks          | ❌     | ✅ todo lifecycle with implementation records |
| Track upstream changes        | ❌     | ✅ commit-level tracking with triage          |
| Multi-maintainer coordination | ❌     | ✅ claim work items, comment to GitHub        |
| Fork alignment                | ❌     | ✅ sync fork + cherry-pick decisions          |
| Cross-stack tracking          | ❌     | ✅ track React → Vue feature parity           |
| Project knowledge             | ❌     | ✅ persistent knowledge per repo              |

### Skills

Skills are guided workflows that orchestrate MCP tools. In Claude Code, trigger them by name or natural language.

| Skill                        | Description                                                            |
| ---------------------------- | ---------------------------------------------------------------------- |
| `contribbot:project-onboard` | New project setup — detect fork/upstream, init config, first sync      |
| `contribbot:daily-sync`      | Daily check — sync fork, fetch upstream commits, skip noise, triage    |
| `contribbot:start-task`      | Start working — pick todo, activate, LLM generates implementation plan |
| `contribbot:todo`            | Todo lifecycle — add, activate, claim, update, done, archive, compact  |
| `contribbot:issue`           | Issue management — list, detail, create, close, comment                |
| `contribbot:pr`              | PR management — list, summary, create, update, review, reply           |
| `contribbot:pre-submit`      | Pre-merge check — PR review, CI status, security alerts                |
| `contribbot:weekly-review`   | Weekly retrospective — contribution stats, progress, cleanup           |
| `contribbot:fork-triage`     | Fork cherry-pick decisions for downstream consumers                    |
| `contribbot:dashboard`       | Project overview — single or cross-project                             |

## Project Modes

contribbot auto-detects your project's relationship with upstream repos and adapts its workflow accordingly.

| Mode              | Condition             | What It Enables                   |
| ----------------- | --------------------- | --------------------------------- |
| **none**          | No fork, no upstream  | Issue/PR/todo management          |
| **fork**          | Has fork source       | Fork sync + cherry-pick decisions |
| **upstream**      | Has external upstream | Cross-stack commit tracking       |
| **fork+upstream** | Both                  | Fork sync + cross-stack tracking  |

Run `/contribbot:project-onboard` to auto-detect and configure.

### Why fork data is stored under parent repo

When you work on `darkingtail/plane` (a fork of `makeplane/plane`), contribbot stores data under `~/.contribbot/makeplane/plane/` — the **parent repo** path.

Why: multiple people may fork the same repo. Storing under the parent ensures everyone's local data aligns to the same canonical repo, and `sync_fork` / `upstream_daily` always know which repo is the source of truth.

Your fork is recorded in `config.yaml` as the `fork` field:

```yaml
# ~/.contribbot/makeplane/plane/config.yaml
role: admin
org: null
fork: darkingtail/plane # your fork
upstream: null
```

### Three-layer capability

| Layer                | Capability                                 | Modes                   |
| -------------------- | ------------------------------------------ | ----------------------- |
| Basic                | Issue/PR/todo management                   | All                     |
| Fork tracking        | Cherry-pick decisions from fork source     | fork, fork+upstream     |
| Cross-stack tracking | Feature parity tracking across tech stacks | upstream, fork+upstream |

## Data Storage

All data is local in `~/.contribbot/{owner}/{repo}/`:

```
~/.contribbot/{owner}/{repo}/
├── config.yaml              # Repo config
│                            #   role: admin|maintain|write|triage|read
│                            #   org: organization name or null
│                            #   fork: your fork repo or null
│                            #   upstream: external upstream or null
│
├── todos.yaml               # Active todos
│                            #   ref: issue number (#123) or custom slug
│                            #   title, type (bug/feature/docs/chore)
│                            #   status: idea → backlog → active → pr_submitted → done | not_planned
│                            #   difficulty: easy|medium|hard
│                            #   pr, branch, claimed_items
│
├── todos/                   # Implementation records (one per todo)
│   ├── 123.md               #   Created at todo_add, enriched at todo_activate
│   └── playground.md        #   LLM generates implementation plan here
│
├── todos.archive.yaml       # Archived todos (done + not_planned)
│                            #   Use todo_compact to clean old entries
│
├── upstream.yaml            # Upstream tracking
│                            #   versions: release-level sync status
│                            #   daily: commit-level triage (action: skip|todo|issue|pr|synced)
│
├── upstream.archive.yaml   # Archived upstream daily commits
│                            #   Moved here by upstream_compact
│
├── upstream/                # Upstream implementation records
│   └── {owner}/{repo}/
│       └── {version}.md
│
├── templates/               # Custom templates (auto-generated on first use)
│   ├── todo_record.md       #   Todo implementation doc template
│   └── todo_claim.md        #   GitHub claim comment template
│
├── knowledge/               # Project knowledge (via knowledge_write)
│   └── {name}/README.md
│
└── sync/                    # Sync history records
```

## Tool Architecture

Tools organized in three layers:

```
tools/
├── core/      contribbot unique (todo, upstream, knowledge, config)
├── linkage/   GitHub ops + local data sync (issue_create, pr_create...)
└── compat/    GitHub API wrappers for standalone use
```

- **Core** — Cannot be replaced by GitHub MCP. Todo management, upstream tracking, knowledge, repo config, compact.
- **Linkage** — GitHub operations that also update local data (e.g., `issue_create` auto-creates a todo).
- **Compat** — Pure GitHub API wrappers. Ensures contribbot works without GitHub MCP installed.

Full tool reference: [docs/tools.md](docs/tools.md)

## Customization

### Templates

Templates are auto-generated with documentation on first use. Edit them to customize:

- `templates/todo_record.md` — Todo implementation document format
  - Variables: `{{title}}`, `{{ref}}`, `{{type}}`, `{{date}}`
- `templates/todo_claim.md` — GitHub claim comment format
  - Variables: `{{items}}`, `{{user}}`, `{{repo}}`, `{{issue}}`

### Archive & Compact

Archived data accumulates over time. Use `todo_compact` / `upstream_compact` to clean up — by date or count. See [docs/tools.md](docs/tools.md) for details.

### Config

`config.yaml` is auto-detected on first use via `repo_config`. Fields:

| Field      | Description                                     |
| ---------- | ----------------------------------------------- |
| `role`     | Your GitHub permission level (auto-detected)    |
| `org`      | Organization name (auto-detected)               |
| `fork`     | Your fork repo, if this is a parent repo        |
| `upstream` | External upstream repo for cross-stack tracking |

## Contributing

```bash
pnpm install
pnpm build        # Build MCP server
pnpm dev          # Run MCP server with tsx (debug)
pnpm test         # Run tests (71 tests)
```

Project structure:

```
contribbot/
├── packages/mcp/     # contribbot-mcp (npm package)
│   └── src/
│       ├── core/     # Tools (core/linkage/compat), storage, clients, utils
│       └── mcp/      # MCP server entry + tool registration
├── skills/           # Skills (MCP tool orchestration)
├── .claude-plugin/   # Plugin metadata for Claude Code
└── .mcp.json         # MCP server config
```

## License

MIT
