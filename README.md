# contribbot

Open source collaboration assistant for [Claude Code](https://claude.com/claude-code). Helps developers efficiently maintain and contribute to open source projects.

Provides 39 MCP tools + 10 skills covering todo management, upstream tracking, issue/PR workflows, and multi-project oversight.

## Install

Requires [Claude Code](https://claude.com/claude-code).

```bash
claude plugin install darkingtail/contribbot
```

This installs both the skills and the MCP server (`contribbot-mcp`). No additional setup needed.

## What It Does

### Todo Management

Track personal tasks locally in `~/.contribbot/`, linked to GitHub issues:

```
/contribbot:todo add "Fix Cascader search" ref=#259
/contribbot:start-task darkingtail/my-repo
```

- `todo_add` / `todo_activate` / `todo_claim` / `todo_detail` / `todo_update` / `todo_done` / `todo_delete` / `todo_archive`
- Claim work items from issues — auto-comments on GitHub to coordinate with other maintainers
- Branch naming suggested by LLM based on repo conventions

### Upstream Tracking

Track changes from upstream repos (fork source or external upstream):

```
/contribbot:daily-sync darkingtail/antdv-next
```

- `upstream_daily` — fetch new commits since last tracked version
- `upstream_daily_skip_noise` — batch skip CI/deps/build noise
- `upstream_sync_check` — compare release changelog with your sync status

### Issue & PR Workflows

```
/contribbot:issue darkingtail/my-repo
/contribbot:pr darkingtail/my-repo
/contribbot:pre-submit darkingtail/my-repo 42
```

### Project Modes

Automatically detected from your repo's fork/upstream configuration:

| Mode | When | What It Enables |
|------|------|----------------|
| **none** | No fork, no upstream | Basic issue/PR/todo management |
| **fork** | Has fork source | Fork sync + cherry-pick decisions |
| **upstream** | Has external upstream | Cross-stack commit tracking |
| **fork+upstream** | Both | Fork sync + cross-stack tracking |

First time? Run `/contribbot:project-onboard` to auto-detect and configure.

## Skills

| Skill | Trigger | Description |
|-------|---------|-------------|
| `contribbot:daily-sync` | "daily sync", "每日同步" | Upstream sync workflow |
| `contribbot:start-task` | "start task", "开始任务" | Pick and activate a todo |
| `contribbot:pre-submit` | "pre-submit", "提交检查" | PR review readiness check |
| `contribbot:weekly-review` | "weekly review", "周回顾" | Contribution stats + progress |
| `contribbot:project-onboard` | "onboard", "接入项目" | New project setup |
| `contribbot:fork-triage` | "fork triage", "二开同步" | Cherry-pick decisions for forks |
| `contribbot:todo` | "todo", "任务列表" | Todo lifecycle management |
| `contribbot:issue` | "issue", "创建 issue" | Issue management |
| `contribbot:pr` | "pr", "创建 PR" | PR management |
| `contribbot:dashboard` | "dashboard", "项目概况" | Project overview |

## Tool Architecture

39 tools organized in three layers:

```
tools/
├── core/      21 tools — contribbot unique (todo_*, upstream_*, skills, config)
├── linkage/    4 tools — GitHub ops + local data sync (issue_create, pr_create...)
└── compat/    14 tools — GitHub wrappers for out-of-box use (issue_list, pr_summary...)
```

- **Core** — Cannot be replaced by GitHub MCP. Todo management, upstream tracking, skills, repo config.
- **Linkage** — GitHub operations that also update local data (e.g., `issue_create` auto-creates a todo).
- **Compat** — Pure GitHub API wrappers. Ensures contribbot works standalone without GitHub MCP installed.

## Data Storage

All data persists locally in `~/.contribbot/{owner}/{repo}/`:

```
~/.contribbot/{owner}/{repo}/
├── config.yaml        # Repo config (role, fork, upstream)
├── todos.yaml         # Todo index
├── todos/             # Implementation records (per issue/idea)
├── upstream.yaml      # Upstream tracking index
├── upstream/          # Upstream implementation records
├── archive.yaml       # Archived todos
├── templates/         # Custom templates (e.g., todo_claim.md)
├── skills/            # Personal reusable skills
└── sync/              # Sync history records
```

## Customization

### Claim Template

When claiming work items from an issue, contribbot posts a comment on GitHub. Customize the template:

Create `~/.contribbot/{owner}/{repo}/templates/todo_claim.md`:

```markdown
I'll work on the following:

{{items}}

<!-- contribbot:claim @{{user}} -->
```

Available variables: `{{items}}`, `{{user}}`, `{{repo}}`, `{{issue}}`

## Development

```bash
pnpm install
pnpm build        # Build MCP server
pnpm dev          # Run MCP server with tsx (debug)
pnpm test         # Run tests
```

### Project Structure

```
contribbot/
├── packages/mcp/     # contribbot-mcp (npm package)
│   └── src/
│       ├── core/     # Tools, storage, clients, utils
│       └── mcp/      # MCP server entry + registration
├── skills/           # 10 skills (MCP tool orchestration)
├── .claude-plugin/   # Plugin metadata
└── .mcp.json         # MCP server registration
```

## License

MIT
