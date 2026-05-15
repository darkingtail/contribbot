# Agora Bounty MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `contribbot bounty`, an MVP for optional bounty coordination in GitHub-native open-source workflows with multi-rail settlement records.

**Architecture:** Add a local YAML-backed `BountyStore`, core MCP tool functions under `core/tools/core`, and server/export registration. The MVP records bounty lifecycle state and settlement instructions; Arc USDC is represented as a settlement rail and instruction, not a real-money transfer.

**Tech Stack:** TypeScript, Vitest, YAML persistence, MCP SDK, existing contribbot storage/tool patterns.

---

### Task 1: Bounty Store

**Files:**
- Create: `packages/mcp/src/core/storage/bounty-store.ts`
- Create: `packages/mcp/src/core/storage/bounty-store.test.ts`

- [ ] **Step 1: Write failing store tests**

Cover add/list/detail, claim, PR link, ready mark, settle mark, invalid transitions, and YAML persistence.

- [ ] **Step 2: Run store tests and verify RED**

Run: `pnpm --filter contribbot-mcp test src/core/storage/bounty-store.test.ts`

Expected: fails because `bounty-store.ts` does not exist.

- [ ] **Step 3: Implement `BountyStore`**

Use `~/.contribbot/{owner}/{repo}/bounties.yaml` via the caller-provided base directory. Store shape:

```yaml
bounties:
  - id: bounty-1
    ref: "#123"
    title: Fix issue title
    amount: "25"
    currency: USDC
    rail: arc-usdc
    status: open
    creator: alice
    claimant: null
    claimant_wallet: null
    pr: null
    settlement: null
    created: "2026-05-13"
    updated: "2026-05-13"
```

Allowed rails: `arc-usdc`, `github-sponsors`, `manual`.
Allowed statuses: `open`, `claimed`, `ready`, `settled`, `cancelled`.

- [ ] **Step 4: Run store tests and verify GREEN**

Run: `pnpm --filter contribbot-mcp test src/core/storage/bounty-store.test.ts`

Expected: all store tests pass.

### Task 2: Bounty Core Tools

**Files:**
- Create: `packages/mcp/src/core/tools/core/bounties.ts`
- Create: `packages/mcp/src/core/tools/core/bounties.test.ts`

- [ ] **Step 1: Write failing tool tests**

Cover:
- `bountyCreate` creates a bounty for a repo.
- `bountyList` groups records in markdown.
- `bountyDetail` shows claim, PR, and settlement state.
- `bountyClaim` records GitHub user, optional wallet, and optional claim note.
- `bountyLinkPr` links PR number.
- `bountyMarkReady` moves claimed bounty to ready.
- `bountySettle` records rail-specific settlement note/instruction.

- [ ] **Step 2: Run tool tests and verify RED**

Run: `pnpm --filter contribbot-mcp test src/core/tools/core/bounties.test.ts`

Expected: fails because `bounties.ts` does not exist.

- [ ] **Step 3: Implement tool functions**

Functions:
- `bountyCreate(args, repo)`
- `bountyList(repo, status?)`
- `bountyDetail(idOrRef, repo)`
- `bountyClaim(idOrRef, args, repo)`
- `bountyLinkPr(idOrRef, pr, repo)`
- `bountyMarkReady(idOrRef, repo)`
- `bountySettle(idOrRef, args, repo)`

Keep GitHub comments out of the first implementation to avoid network-dependent tests. Return markdown that can be pasted to GitHub.

- [ ] **Step 4: Run tool tests and verify GREEN**

Run: `pnpm --filter contribbot-mcp test src/core/tools/core/bounties.test.ts`

Expected: all tool tests pass.

### Task 3: MCP Registration and Exports

**Files:**
- Modify: `packages/mcp/src/mcp/server.ts`
- Modify: `packages/mcp/src/mcp/server.test.ts`
- Modify: `packages/mcp/src/index.ts`
- Modify: `docs/tools.md`

- [ ] **Step 1: Write failing MCP schema tests**

Extend `server.test.ts` to assert that bounty tools are listed and that repository-scoped bounty tools require `repo`.

- [ ] **Step 2: Run MCP schema tests and verify RED**

Run: `pnpm --filter contribbot-mcp test src/mcp/server.test.ts`

Expected: fails because bounty tools are not registered.

- [ ] **Step 3: Register bounty tools**

Add MCP tools:
- `bounty_create`
- `bounty_list`
- `bounty_detail`
- `bounty_claim`
- `bounty_link_pr`
- `bounty_mark_ready`
- `bounty_settle`

All require explicit `repo`.

- [ ] **Step 4: Export bounty functions**

Export core functions and types from `packages/mcp/src/index.ts`.

- [ ] **Step 5: Update tool docs**

Add a "Bounty Coordination" section to `docs/tools.md` with MVP scope and rail meanings.

- [ ] **Step 6: Run MCP schema tests and verify GREEN**

Run: `pnpm --filter contribbot-mcp test src/mcp/server.test.ts`

Expected: all MCP schema tests pass.

### Task 4: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run all tests**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 2: Run build**

Run: `pnpm build`

Expected: build succeeds.

- [ ] **Step 3: Inspect git status**

Run: `git status --short --branch`

Expected: only intended files changed on `feature/agora-bounty-agent`.

