# Repository Patrol Agent

## Status

Experimental. The single-repository loop, cross-project orchestration,
report-only scheduling, and an explicitly invoked worktree executor are
implemented in `packages/agent`.

## Product Boundary

Phase 3 starts with one repository patrol agent backed by auditable repository
memory. It is not an agent team and it is not an autonomous GitHub maintainer.

The command is:

```bash
contribbot patrol owner/repo
```

The first loop is deliberately narrow:

```text
Observe -> Analyze -> Plan -> Act / Ask -> Learn
```

## What One Run Does

### Observe

The Python runtime starts `contribbot-mcp` over stdio and reads:

- repository config and project mode;
- project dashboard;
- local todos;
- upstream tracking state;
- recent GitHub Actions runs;
- security alerts;
- pending knowledge proposals;
- canonical repository knowledge resources.

Each observation is retained in the run snapshot. A failed source does not erase
the rest of the patrol; it is reported as incomplete coverage.

### Analyze and Plan

The default backend calls Codex in a temporary read-only workspace and requires
a structured result:

- repository health;
- evidence-backed findings;
- recommended actions;
- action kind and safety level;
- optional durable knowledge candidates.

Repository content is treated as untrusted data. Issue titles, commit messages,
comments, and knowledge documents cannot redefine the patrol instructions.

Action kinds have runtime-enforced safety floors:

| Kind | Minimum Safety | Note |
| --- | --- | --- |
| `read` | `auto` | Inspection only |
| `local_write` | `auto` | Must remain local and reversible |
| `public_write` | `confirm` | GitHub-visible changes require approval |
| `destructive` | `manual` | Never delegated by the patrol MVP |

### Act or Ask

Every completed run automatically performs one low-risk action: it records the
patrol report and its audit artifacts under the canonical contribbot repo data
directory.

The report may recommend other actions, but the MVP does not execute GitHub
comments, issues, pull requests, merges, or destructive Git commands.

### Learn

Codex may return a knowledge candidate only when the snapshot proves a durable,
reusable repository convention. The user must approve before contribbot calls
`knowledge_propose_update`.

Approval creates a reviewable proposal. It does not modify canonical knowledge.
The existing Phase 3A apply/reject workflow remains the final gate.

## Run It From The Repository

Prerequisites:

- GitHub CLI authenticated with `gh auth login`;
- Codex CLI installed and authenticated;
- `uv`, Node.js, and pnpm installed.

Install Python dependencies:

```bash
uv sync --project packages/agent
```

Run a real patrol:

```bash
uv run --project packages/agent contribbot patrol darkingtail/contribbot
```

For non-interactive use, keep knowledge candidates in the report without
creating proposals:

```bash
uv run --project packages/agent contribbot patrol darkingtail/contribbot --no-input
```

Resume the pending actions of that same auditable Run later:

```bash
uv run --project packages/agent contribbot patrol darkingtail/contribbot --resume RUN_ID
```

Resume loads the stored snapshot, analysis, trace, Run, and Action states. It
does not pay for another analysis, skips already completed/rejected actions,
and relies on stable Action IDs plus Todo idempotency to avoid duplicate work.

For a no-LLM smoke test:

```bash
uv run --project packages/agent contribbot patrol darkingtail/contribbot --backend rules --no-input
```

Explicitly approve all returned knowledge candidates:

```bash
uv run --project packages/agent contribbot patrol darkingtail/contribbot --propose-knowledge
```

## Audit Artifacts

Each run is stored at:

```text
~/.contribbot/{owner}/{repo}/patrol/
├── latest.md
├── latest.json
└── runs/{run-id}/
    ├── report.md
    ├── snapshot.json
    ├── analysis.json
    ├── trace.json
    ├── run.json
    └── actions.json
```

The files answer four different questions:

| File | Question | Note |
| --- | --- | --- |
| `snapshot.json` | What source material did the agent see? | Tool and knowledge outputs |
| `analysis.json` | What did the model conclude? | Schema-validated result |
| `trace.json` | Which loop phases and actions occurred? | Ordered audit events |
| `run.json` | What state did the run reach? | Status, coverage, timing, investigation count |
| `actions.json` | What happened to each proposed action? | Approval, execution and result state |
| `report.md` | What should the maintainer read and do next? | Human-facing output |

## Architecture

```text
packages/mcp       TypeScript tools and storage
packages/agent     Python patrol runtime and Codex analysis
```

TypeScript is the hands. Python is the brain. The agent calls the existing MCP
tools instead of reimplementing GitHub access, todo storage, upstream tracking,
or knowledge mutation.

## Current Non-Goals

- no agent team;
- no automatic public GitHub writes;
- no automatic issue closing or PR merging;
- no vector database;
- no silent knowledge mutation;
- no reward or bounty automation;
- no automatic push or pull-request creation.

## Multi-repository and scheduled runs

The global view is available from any directory because it reads the tracked
projects through the MCP `project_list` tool:

```bash
uv run --project packages/agent contribbot patrol-all --backend rules --max-investigation-rounds 0
```

For scheduled runs, create a local JSON configuration and run one batch:

```bash
uv run --project packages/agent contribbot init-config --config .agent.json
uv run --project packages/agent contribbot patrol-schedule --once --config .agent.json
```

`report_only` is the default. The scheduler records reports but does not
perform public GitHub writes. Use Windows Task Scheduler or another external
wake-up mechanism to invoke `patrol-schedule --once` daily. Unchanged batches
are silent; add `--show-unchanged` when diagnosing the scheduler.

## Worktree remediation

An explicitly invoked remediation creates an isolated worktree, allows Codex
to make uncommitted changes, checks protected paths, and runs the requested
validation commands:

```bash
uv run --project packages/agent contribbot remediate C:/src/my-repo \
  --prompt "Fix the issue" --validate "pnpm test"
```

The result is `validated` only when changes exist and every validation command
passes. The run directory contains `changes.patch`, `result.json`, and
`VERIFICATION.txt`. Publishing remains a separate maintainer action.

## Verified smoke test

Verified on September 6, 2026:

```bash
uv run --project packages/agent contribbot patrol-all darkingtail/contribbot \
  --backend rules --max-investigation-rounds 0

uv run --project packages/agent contribbot patrol-schedule --once \
  --config .codex/agent-smoke.json
```

The global command was also executed from `D:/dev/darkingtail` and discovered
the four actual tracked repositories while excluding the runtime-only
`remediation` and `worktrees` directories. The scheduler smoke configuration
is kept only under the ignored `.codex/` test area.

### Windows daily wake-up

Keep the scheduler itself simple and let Windows Task Scheduler invoke one
batch. Save a wrapper such as:

```powershell
# C:\Users\you\.contribbot\patrol.ps1
uv run --project D:\dev\darkingtail\contribbot\packages\agent `
  contribbot patrol-schedule --once `
  --config C:\Users\you\.contribbot\agent.json
```

Then create a daily task pointing to:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\you\.contribbot\patrol.ps1
```

Because unchanged batches produce no output, a notification wrapper only needs
to forward non-empty stdout or failures.
