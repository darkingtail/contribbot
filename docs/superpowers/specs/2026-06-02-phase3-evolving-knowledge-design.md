# Phase 3A: Evolving Repository Knowledge Design

## Summary

Phase 3A adds a self-evolving repository knowledge layer to contribbot.

The goal is not to build a fully autonomous agent first. The goal is to give future agents a reliable memory substrate: after issue investigation, todo work, PR review, debug sessions, and maintenance decisions, contribbot can propose durable project knowledge updates, wait for maintainer approval, then apply those updates with an audit trail.

This keeps the existing contribbot principle intact:

- tools do structured data read/write;
- the host AI agent does qualitative judgment;
- the maintainer confirms important writes.

## Problem

contribbot already has `knowledge_write` and `knowledge://{repo}/{name}` resources. They are useful, but the current model is static:

- a user or agent must know when to write knowledge;
- updates overwrite or append manually;
- there is no reviewable proposal flow;
- there is no audit trail for why a knowledge entry changed;
- repeated task learnings are easy to lose across sessions.

Phase 3 needs memory, but silent memory mutation is risky. Repository knowledge can encode project conventions, CI behavior, architecture decisions, and maintainer preferences. If an agent updates that silently, it can make future work worse.

## Design Goal

Add an explicit knowledge evolution workflow:

```text
source context -> proposal -> maintainer review -> apply -> audit trail
```

The first version should support two core operations:

- `knowledge_propose_update`: create a pending knowledge update proposal.
- `knowledge_apply_update`: apply an approved proposal into the canonical knowledge document.

The tool should not decide what knowledge is true. It stores and applies proposals created by the host AI agent after the agent has reasoned over task context.

## Non-Goals

Phase 3A will not include:

- a standalone daemon;
- scheduled jobs;
- chat integrations;
- automatic LLM summarization inside the MCP server;
- autonomous approval;
- vector search;
- cross-repo global memory;
- silent mutation of existing knowledge.

Those can come later after the knowledge proposal model is stable.

## Core Concepts

### Knowledge Entry

The existing canonical knowledge entry remains:

```text
~/.contribbot/{owner}/{repo}/knowledge/{name}/README.md
```

This is the stable memory surface exposed through `knowledge://{repo}/{name}`.

### Knowledge Proposal

A knowledge proposal is a pending change to one knowledge entry.

Suggested fields:

```ts
type KnowledgeProposalStatus = "pending" | "applied" | "rejected";
type KnowledgeProposalAction = "create" | "append" | "revise";
type KnowledgeSourceType =
  | "todo"
  | "issue"
  | "pr"
  | "review"
  | "debug"
  | "daily-sync"
  | "manual";

interface KnowledgeProposal {
  id: string;
  repo: string;
  target: string;
  action: KnowledgeProposalAction;
  status: KnowledgeProposalStatus;
  source_type: KnowledgeSourceType;
  source_ref?: string;
  title: string;
  rationale: string;
  proposed_content: string;
  created_at: string;
  applied_at?: string;
  rejected_at?: string;
}
```

### Audit Trail

Every applied proposal should remain visible after apply. The first version can store all proposals in a YAML index and mark status transitions.

The audit trail should answer:

- what changed;
- which source led to the change;
- why the agent proposed it;
- when it was applied;
- which canonical knowledge entry was affected.

## Storage

Use repo-local storage under the existing contribbot data directory.

Recommended first-version layout:

```text
~/.contribbot/{owner}/{repo}/
├── knowledge/
│   └── {name}/README.md
└── knowledge.proposals.yaml
```

This keeps proposal state easy to list and test without introducing a new nested file system model too early.

Future versions can move proposals into:

```text
knowledge/proposals/{proposal-id}.md
```

if proposal bodies become large or need richer rendering.

## Tool Behavior

### `knowledge_propose_update`

Inputs:

- `repo`: required, `owner/repo`.
- `target`: required knowledge entry name.
- `action`: `create`, `append`, or `revise`.
- `source_type`: source category.
- `source_ref`: optional issue number, PR number, todo ref, or other source id.
- `title`: short proposal title.
- `rationale`: why this belongs in durable project knowledge.
- `proposed_content`: the proposed markdown content.

Behavior:

- validate repo and path segments;
- create `knowledge.proposals.yaml` if missing;
- assign a stable local id, for example `kp-1`, `kp-2`;
- save proposal with `pending` status;
- do not write the canonical knowledge entry;
- return a markdown summary for maintainer review.

### `knowledge_apply_update`

Inputs:

- `repo`: required.
- `proposal_id`: required.

Behavior:

- load the pending proposal;
- ensure it has not already been applied or rejected;
- apply according to `action`:
  - `create`: fail if target exists, then create `knowledge/{target}/README.md`;
  - `append`: append proposed content to existing target, creating it only if explicitly allowed later;
  - `revise`: replace the target content with proposed content;
- mark proposal as `applied`;
- record `applied_at`;
- return the updated knowledge path and proposal summary.

First version should not implement automatic merge. For `revise`, the host agent must provide the full revised markdown.

## Review and Safety Rules

- A proposal is not knowledge until applied.
- Applying requires an explicit tool call.
- The MCP tool should not infer project truth from raw logs.
- Rejecting or rollback can be added later; the first version may leave rejection out if scope needs to stay small.
- Sensitive data should be treated as caller responsibility in v1, but docs should warn agents not to store tokens, secrets, private emails, or private customer data.
- Proposal ids are local to a repo.

## Integration Points

Phase 3A can be used by existing workflows without changing their core behavior:

- `start-task`: after implementation plan confirmation, propose reusable project knowledge if a pattern is discovered.
- `daily-sync`: after triage, propose upstream tracking rules or noise patterns.
- `pre-submit`: after review/CI checks, propose stable CI or PR conventions.
- `weekly-review`: list pending knowledge proposals.
- `project_dashboard`: show count of pending knowledge proposals.

These integrations can come after the core proposal/apply tools.

## Testing Plan

Add storage and tool tests for:

- proposal creation into an empty repo data directory;
- id allocation;
- list/load status behavior;
- create action applies to a missing knowledge entry;
- append action appends to an existing knowledge entry;
- revise action replaces an existing knowledge entry;
- applying an already applied proposal fails;
- path segment validation prevents unsafe target names;
- pending proposals survive reload.

## Implementation Order

1. Add a `KnowledgeProposalStore` under `packages/mcp/src/core/storage/`.
2. Add core tool functions under `packages/mcp/src/core/tools/core/knowledge-evolution.ts`.
3. Register MCP tools in `packages/mcp/src/mcp/server.ts`.
4. Export functions from `packages/mcp/src/index.ts`.
5. Document tools in `docs/tools.md`.
6. Add focused tests.

## Open Questions

- Should `knowledge_apply_update` support `reject` in the first implementation, or should rejection be a separate `knowledge_reject_update` tool later?
- Should `append` create the target when missing, or should it fail to keep intent explicit?
- Should proposal content be stored only in YAML, or should large proposal bodies use markdown files from the start?
- Should applied proposals add a small footer/comment into the canonical README, or should audit metadata stay only in the proposal index?

## Decision

Start with proposal and apply only.

Keep the design intentionally host-agent driven: Codex, Claude Code, or another coding agent decides what to propose; contribbot persists the proposal and applies it after user confirmation.

This is the safest first step toward Phase 3 because it improves memory without granting autonomous execution power.
