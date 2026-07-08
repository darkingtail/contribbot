# Docs Information Architecture Redesign

## Goal

Make contribbot's documentation explain the product clearly before exposing implementation history.

The current docs are rich, but the structure mixes four different audiences:

- users trying to understand what contribbot is;
- maintainers trying to operate tools and workflows;
- contributors trying to understand architecture;
- the project owner preserving historical implementation plans.

The redesign should keep all useful content, but separate the current product narrative from old construction notes.

## Current Problems

### 1. The Product Story Is Buried

The README still mostly presents contribbot as "MCP tools + skills". That was accurate for Phase 1 and Phase 2, but the product direction is now clearer:

> contribbot is moving toward a repository-level patrol agent that observes a repo, judges what matters, proposes actions, and learns from maintainer feedback.

This should be visible before the tool catalog.

### 2. Formal Docs and Historical Plans Are Mixed

Files such as `docs/tools.md`, `docs/design.md`, `docs/plans/*`, and `docs/superpowers/*` sit close together even though they serve different purposes.

Historical implementation plans are valuable, but they should read as archive material, not current user-facing documentation.

### 3. Phase 3 Lacks a Simple Entry Point

Phase 3 currently includes:

- Phase 3A knowledge evolution;
- Phase 3B self-evolution / Hermes tracking;
- future agent runtime;
- scheduler;
- memory;
- safety boundaries;
- possible agent team.

These pieces are real, but a reader needs one simple bridge:

> Phase 3 starts with a single-repo patrol loop.

Without that bridge, the docs jump from MCP tools to autonomous agent runtime too quickly.

### 4. Bounty / Reward Is a Separate Product Thread

Bounty and reward coordination are now merged into main, but they should not blur the Phase 3 agent story.

They are best presented as an optional collaboration and incentive layer that can later be powered by the patrol agent.

## Proposed Top-Level Structure

```text
docs/
├── index.md
├── product.md
├── getting-started.md
├── roadmap.md
├── architecture.md
├── tools.md
├── agent/
│   ├── patrol.md
│   ├── memory.md
│   ├── safety.md
│   └── runtime.md
├── concepts/
│   ├── project-modes.md
│   ├── upstream-tracking.md
│   ├── reward-incentive-layer.md
│   └── competitive-research.md
└── archive/
    ├── plans/
    ├── specs/
    ├── hackathon/
    └── superpowers/
```

## Proposed Responsibilities

### `docs/index.md`

The docs landing page.

It should answer:

- What is contribbot?
- What should I read first?
- What is stable today?
- What is experimental?

Recommended sections:

- Product in one paragraph
- Current capabilities
- Phase 3 direction
- Reading guide

### `docs/product.md`

The product north star.

Core statement:

> contribbot is a repository-level patrol agent for open-source maintenance.

It should explain:

- why GitHub alone is not enough;
- why contribbot tracks local todo/upstream/knowledge state;
- why Phase 3 is about patrol, not generic chat;
- how bounty/reward fits as an optional incentive layer.

### `docs/getting-started.md`

Practical setup and first workflow.

Move most install/setup content out of README into this file:

- prerequisites;
- install via Claude Code;
- MCP-compatible platforms;
- first `project-onboard`;
- first `daily-sync`;
- first `start-task`.

### `docs/roadmap.md`

Replace or absorb root `ROADMAP.md` later.

Suggested model:

```text
Phase 1: Tools
Phase 2: Skills
Phase 3A: Auditable repository memory
Phase 3B: Single-repo patrol agent
Phase 3C: Scheduler and multi-repo patrol
Phase 3D: Agent team and collaboration layers
```

Important wording:

- Phase 3B should be framed as `contribbot patrol <repo>`.
- Agent team should be presented as a later decomposition, not the first implementation target.

### `docs/architecture.md`

Current technical architecture.

It should separate:

- `packages/mcp` as the TypeScript tool server;
- future `packages/agent` as the Python patrol/runtime layer;
- local storage under `~/.contribbot`;
- GitHub as the public collaboration surface;
- MCP as the boundary between agent and tools.

### `docs/tools.md`

Keep this as a reference manual.

Do not make it explain the whole product. It should stay factual:

- tool groups;
- parameters;
- lifecycle;
- storage side effects.

### `docs/agent/patrol.md`

The most important new Phase 3 document.

Define the first real agent MVP:

```text
contribbot patrol owner/repo
```

Patrol loop:

```text
Observe -> Analyze -> Plan -> Act / Ask -> Learn
```

First version behavior:

- read repo config, dashboard, todo, upstream, CI, security, knowledge;
- produce a patrol report;
- create low-risk local state updates;
- propose knowledge updates;
- ask before public GitHub writes.

### `docs/agent/memory.md`

Move Phase 3A knowledge evolution here.

Explain:

- `knowledge_propose_update`;
- `knowledge_proposals`;
- `knowledge_apply_update`;
- `knowledge_reject_update`;
- provenance;
- why memory mutation requires review.

### `docs/agent/safety.md`

Define action safety levels.

Suggested categories:

- auto-allowed: read, summarize, local report, local proposal;
- configurable: create local todo, mark upstream action, create issue draft;
- confirmation-required: public GitHub comments, issue creation, PR creation;
- forbidden without explicit command: close issue, merge PR, force push, destructive git ops.

### `docs/agent/runtime.md`

Keep runtime language and deployment here.

Recommended direction:

- TypeScript remains `contribbot-mcp`;
- Python becomes `contribbot-agent`;
- Python agent calls TS MCP tools instead of reimplementing them.

### `docs/concepts/`

Keep durable conceptual docs here.

Move or rename:

- `project-modes.md` stays;
- `competitive-research.md` stays;
- `reward-incentive-layer.md` becomes official concept doc;
- add `upstream-tracking.md` by extracting from current `docs/design.md`.

### `docs/archive/`

Move historical planning artifacts here.

Candidates:

- current `docs/plans/*`;
- current `docs/superpowers/plans/*`;
- hackathon submission docs after they stop being active;
- older implementation specs that are no longer the current design.

## README Strategy

README should become a sharp project front door, not a full manual.

Recommended sections:

1. One-paragraph product statement
2. What contribbot can do today
3. Phase 3 direction: patrol agent
4. Quick install
5. First workflow
6. Docs links

README should link to:

- `docs/index.md`;
- `docs/getting-started.md`;
- `docs/product.md`;
- `docs/agent/patrol.md`;
- `docs/tools.md`.

## Migration Plan

### Step 1: Add New Entry Docs

Create:

- `docs/index.md`
- `docs/product.md`
- `docs/agent/patrol.md`
- `docs/agent/memory.md`
- `docs/agent/safety.md`

Do not move old files yet.

### Step 2: Update README Links

Point README toward the new docs entry points.

Keep install instructions short.

### Step 3: Archive Historical Plans

Move old implementation plans to `docs/archive/`.

Keep git history intact; do not delete useful plans.

### Step 4: Split Current `docs/design.md`

Extract:

- product framing -> `docs/product.md`;
- project modes -> `docs/concepts/project-modes.md`;
- architecture -> `docs/architecture.md`;
- Phase 3 details -> `docs/agent/*`.

### Step 5: Normalize Status Labels

Every doc should be marked as one of:

- Stable
- Active Design
- Experimental
- Archive

This prevents old plans from looking like current product direction.

## Recommended First Commit

The first commit should be small:

- add this plan;
- add `docs/index.md`;
- add `docs/product.md`;
- add `docs/agent/patrol.md`;

Do not move archives in the same commit. The document tree should gain a new front door before old rooms are rearranged.

## Decision

Use the docs redesign to make Phase 3 legible:

> Phase 3 is not "build an agent team" first. Phase 3 starts with a single-repo patrol agent, backed by auditable repository memory.

Everything else should hang off that sentence.
