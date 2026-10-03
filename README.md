# contribbot

> /kənˈtrɪbɒt/ — contrib + bot, the "b" in "contrib" merges with "bot"

[中文](README.zh.md) | English

Open source collaboration assistant evolving into a repository-level patrol agent.

Stable MCP tools and skills handle todo management, upstream tracking, issue/PR workflows, and multi-project oversight. The Phase 3 runtime now supports resumable patrols, multi-project scheduling, knowledge evolution, and isolated remediation.

## Phase 3 Patrol (Experimental)

Run one repository maintenance loop:

```bash
uv sync --project packages/agent
uv run --project packages/agent contribbot patrol darkingtail/contribbot
```

The patrol observes repository state through contribbot MCP tools, asks Codex for a structured assessment, saves a report and complete audit trail, and requests confirmation before creating reviewable knowledge proposals. It never performs public GitHub writes in the MVP.

```bash
# Patrol every tracked repository from any directory
uv run --project D:/dev/darkingtail/contribbot/packages/agent contribbot patrol-all

# Run one scheduled batch; unchanged batches are silent
uv run --project packages/agent contribbot patrol-schedule --once --config agent.json

# Edit and validate in an isolated worktree without commit/push/PR creation
uv run --project packages/agent contribbot remediate D:/dev/my-repo \
  --prompt "Fix the failing test" --validate "pnpm test"
```

See [Repository Patrol Agent](docs/agent/patrol.md) for behavior, safety boundaries, and audit files.

## Prerequisites

- GitHub operations: authenticated [GitHub CLI](https://cli.github.com/) (`gh auth login`)
  or `GITHUB_TOKEN`. MCP startup and existing-project offline reads do not require GitHub login.
- GitLab first-time initialization: access to the selected instance; private access uses
  an exact HTTPS instance-to-token-variable binding in the trusted startup environment.
  See [the credential interface](docs/tools.md#gitlab-首次只读初始化).

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

| Skill | Description | Notes |
| --- | --- | --- |
| `contribbot:project-onboard` | Initialize the managed project and confirm tracking choices | First sync needs separate authorization |
| `contribbot:daily-sync` | Repository maintenance and configured-source triage | Parent sync and tracking are separate |
| `contribbot:start-task` | Pick a Todo, activate it and prepare a plan | Plan confirmation precedes implementation |
| `contribbot:todo` | Add, activate, progress, claim, complete, cancel and archive | Completion does not archive |
| `contribbot:issue` | List, inspect, create, close and comment | Public writes need authorization |
| `contribbot:pr` | List, inspect, create, update and review | PR progress is independent of Todo state |
| `contribbot:pre-submit` | Review changes, CI and security alerts | Checks are not permission to publish |
| `contribbot:weekly-review` | Review contributions and task progress | Archival is a separate choice |
| `contribbot:fork-triage` | Evaluate cherry-picks for a downstream fork | Does not imply automatic application |
| `contribbot:dashboard` | Single-project or cross-project overview | Shows each managed identity separately |

## Project Modes

The current source uses schema v3. Modes are derived from the confirmed `parent`
relationship and the user's `tracking` choice, not stored as a project type.

| Mode | Condition | Available workflow | Notes |
| --- | --- | --- | --- |
| **none** | No confirmed parent; tracking not configured | Local Todo and supported repository tools | Does not mean an unknown parent is absent |
| **fork** | Confirmed parent; tracking not configured | Authorized fork sync | Does not automatically track the parent |
| **tracking** | No confirmed parent; tracking configured | Commit and release tracking | Sources are chosen explicitly |
| **fork+tracking** | Confirmed parent and configured tracking | Fork sync and source tracking | These are separate operations |

`tracking.pending` is not `tracking.none`: an unanswered question remains pending.
`project_init` creates a minimal config with `parent.unknown`; an existing config
can be read offline. Explicit `parent_refresh` verifies a GitHub.com project's
direct parent and updates only its local relationship snapshot. An `unavailable`
result retains the previous snapshot and verification time, not fresh evidence.
It does not initialize, sync code, change tracking or lifecycle, or update Todo.
The schema upgrade is not fully accepted; see [current progress](docs/progress/README.md).

### Each repository owns its data

Managing `darkingtail/antdv-next` keeps its Todo, Consult and Knowledge data under
that repository's identity, even when it is a fork. `parent` describes the direct
fork source; it never redirects storage or silently selects a PR destination.

Example of the minimal config shape, not a claim about a verified fork relation:

```yaml
# ~/.contribbot/projects/v1/<repository-digest>/config.yaml
schema_version: 3
repository:
  platform: github
  instance: https://github.com
  path: darkingtail/antdv-next
lifecycle:
  status: active
parent:
  status: unknown
tracking:
  status: pending
```

Every repository-scoped MCP call receives a complete `{platform, instance, path}`
object. The host may remember the confirmed project; MCP has no implicit project
binding. Schema v3 can represent GitHub and GitLab instances. GitLab first-time
initialization performs one read-only identity GET with optional exact-instance
credentials; existing valid configs remain usable offline. Tests use fake tokens
and mocked responses, not real deployments. GitLab Issue/MR, parent verification
and remote tracking are not implemented; those remote workflows remain GitHub.com-only.
Representing an identity does not grant access to it.

## Data Storage

Repository data is local in `~/.contribbot/projects/v1/<repository-digest>/`.
The digest uses the full platform, instance and path; config identity is checked
on reads. Old owner/repo directories are not automatically migrated or cleared.

```
~/.contribbot/projects/v1/<repository-digest>/
├── config.yaml              # Exactly five root keys:
│                            #   schema_version, repository, lifecycle, parent, tracking
│
├── todos.yaml               # Unarchived todos, including done and cancelled
│                            #   id: stable Todo identity
│                            #   ref: issue number (#123) or custom slug
│                            #   title, type (bug/feature/docs/chore)
│                            #   status: idea|backlog|active|paused|done|cancelled
│                            #   PR progress is independent; no automatic archival
│                            #   difficulty: easy|medium|hard
│                            #   pr, branch, claimed_items
│                            #   executions: resumable Phase/Next/Evidence history
│
├── todos/                   # Implementation records (one per todo)
│   ├── 123.md               #   Created at todo_add, enriched at todo_activate
│   └── playground.md        #   LLM generates implementation plan here
│
├── todos.archive.yaml       # Explicitly archived todos (done + cancelled)
│                            #   Use todo_compact to clean old entries
│
├── upstream.yaml            # schema_version: 1; sources keyed by source digest
│                            #   each source: repository, versions, daily
│
├── upstream.archive.yaml   # Archived upstream daily commits
│                            #   Moved here by upstream_compact
│
├── upstream/                # Upstream implementation records
│   └── <source-digest>/
│       └── {version}.md
│
├── templates/               # Custom templates (auto-generated on first use)
│   ├── todo_record.md       #   Todo implementation doc template
│   └── todo_claim.md        #   GitHub claim comment template
│
├── knowledge/               # Project knowledge (via knowledge_write)
│   └── {name}/README.md
│
├── patrol/                  # Phase 3 patrol reports and audit artifacts
│   ├── latest.md
│   └── runs/{run-id}/       # report, snapshot, analysis, trace
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

The current source accepts only the six Todo states listed above. Old Todo states
`pr_submitted` and `not_planned` are rejected on reads and writes, without automatic
conversion. Upstream item status `pr_submitted` is a separate domain and remains valid.

Cancel unstarted or unmanaged work with `todo_cancel`, using its exact Todo ID,
observed lifecycle revision and explicit user decision. Managed work requires
`todo_control` with `command.kind=cancel`, followed by safe local `stopped` closure with the same
decision. Neither path archives the Todo or changes GitHub.

Completed and cancelled Todos remain visible until separately selected through
`todo_archive`. Retry interrupted explicit archival with the original selections;
old combined completion/archive recovery is no longer supported. These source
capabilities do not imply runtime activation or authorization to migrate personal data.

Archived data accumulates over time. Use `todo_compact` / `upstream_compact` to clean up — by date or count. See [docs/tools.md](docs/tools.md) for details.

### Config

Only `project_init` creates the minimal config after identity verification.
`repo_config` reads it or saves an explicit tracking choice; a missing project
returns `not_initialized` without creation.

| Field | Description | Notes |
| --- | --- | --- |
| `schema_version` | `3` | Old config shapes are rejected, not converted |
| `repository` | Managed `{platform, instance, path}` | Not editable through an ordinary config update |
| `lifecycle` | Local project state: active or archived | Independent of Todo and remote repository state |
| `parent` | Direct fork relationship snapshot | unknown / none / confirmed; not an authorization |
| `tracking` | User-selected source repositories | pending / none / configured; sources use full identities |

Permissions are checked per remote operation, not persisted as `role` or `org`.
For exact shapes, timestamps, identity normalization and storage rules, see the
[schema v3 contract](docs/plans/2026-09-29-project-config-contract.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, architecture, and development guide.

## License

MIT
