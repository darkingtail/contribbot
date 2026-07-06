# Agora Agents Hackathon Submission Draft

## Project

**contribbot bounty**

## One-liner

contribbot bounty adds optional bounty coordination to GitHub-native open-source workflows, with multiple payout rails including Arc USDC, GitHub Sponsors, and manual settlement.

## Short Description

contribbot is an open-source collaboration assistant for maintainers who work across issues, PRs, todos, upstream changes, and project knowledge. For Agora Agents, contribbot adds a bounty coordination layer that does not replace GitHub. Issues, PRs, reviews, and community discussion stay on GitHub; contribbot tracks optional bounty state around that workflow.

The MVP lets a maintainer create a bounty for an issue or contribbot todo, lets a contributor claim it, links the bounty to a PR, marks it ready after maintainer review, and records settlement through a selected payout rail. Arc USDC is supported as one settlement rail for fast, low-cost, verifiable task-level payouts. GitHub Sponsors and manual settlement are supported as community-friendly alternatives.

This is not a trading bot. It is agent-mediated coordination for a different market: open-source contribution incentives.

## Why It Fits Agora

- **Agents:** contribbot reads and coordinates repository workflow state: issue/todo refs, claims, PR links, readiness, and settlement state.
- **Markets:** open-source contribution work has demand, supply, incentives, and settlement. Bounties are optional price signals, not a replacement for community contribution.
- **Arc / USDC:** Arc USDC is a payout rail for task-level settlement, where low cost and fast confirmation matter.
- **Traction:** contribbot is being used to build contribbot itself, including this hackathon feature branch.

## GitHub Repo

Repository:

```text
https://github.com/darkingtail/contribbot
```

Hackathon branch:

```text
https://github.com/darkingtail/contribbot/tree/feature/agora-bounty-agent
```

Core implementation:

```text
packages/mcp/src/core/storage/bounty-store.ts
packages/mcp/src/core/tools/core/bounties.ts
packages/mcp/src/mcp/server.ts
docs/tools.md
```

## Demo Script

Recommended demo length: 2-3 minutes.

### 1. Explain the problem

Open-source maintainers already coordinate issues, PRs, reviews, and claims on GitHub. But optional bounties are usually tracked out of band: in comments, spreadsheets, sponsor notes, or private messages. That makes it hard to see who claimed what, whether work is ready, and how it was settled.

### 2. Run the local demo

Use a temporary directory so the demo does not alter real contributor data:

```powershell
pnpm --filter contribbot-mcp exec tsx -e "import { mkdtempSync } from 'node:fs'; import { join } from 'node:path'; import { tmpdir } from 'node:os'; import { bountyCreate, bountyList, bountyClaim, bountyLinkPr, bountyMarkReady, bountySettle, bountyDetail } from './src/core/tools/core/bounties.ts'; const dir=mkdtempSync(join(tmpdir(),'bounty-demo-')); const repo='darkingtail/contribbot'; console.log('demo dir:', dir); console.log(bountyCreate({ ref:'agora-bounty', title:'Agora bounty MVP demo', amount:'10', currency:'USDC', rail:'arc-usdc', creator:'darkingtail' }, repo, dir)); console.log('\n--- list ---\n' + bountyList(repo, undefined, dir)); console.log('\n--- claim ---\n' + bountyClaim('bounty-1', { claimant:'darkingtail', claimant_wallet:'0xYourArcWallet', claim_note:'Demo claim for Agora hackathon' }, repo, dir)); console.log('\n--- link pr ---\n' + bountyLinkPr('bounty-1', 1, repo, dir)); console.log('\n--- ready ---\n' + bountyMarkReady('bounty-1', repo, dir)); console.log('\n--- settle ---\n' + bountySettle('bounty-1', { rail:'arc-usdc', tx:'0xDemoTxHash', note:'Arc USDC demo settlement instruction' }, repo, dir)); console.log('\n--- detail ---\n' + bountyDetail('bounty-1', repo, dir));"
```

### 3. Show the flow

- `bounty_create`: creates an optional bounty for a GitHub issue or contribbot todo.
- `bounty_claim`: records who claimed the work and the payout details.
- `bounty_link_pr`: connects the bounty to a PR.
- `bounty_mark_ready`: maintainer confirms the work is ready for settlement.
- `bounty_settle`: records settlement through Arc USDC, GitHub Sponsors, or manual payout.
- `bounty_detail`: shows the final audit trail.

### 4. Close with the product boundary

contribbot bounty does not replace GitHub and does not force crypto. It adds optional bounty coordination to existing open-source workflows, with Arc USDC as one supported payout rail.

## 60-Second Pitch Script

Hi, I am the creator of contribbot, an open-source collaboration assistant for maintainers.

Maintainers already coordinate issues, pull requests, reviews, and contributor claims on GitHub. But optional bounties are usually tracked out of band, which makes it hard to know who claimed what, whether the work is ready, and how the contribution was settled.

For Agora Agents, I built contribbot bounty. It adds optional bounty coordination to GitHub-native workflows without replacing GitHub. A maintainer can create a bounty for an issue or todo, a contributor can claim it, contribbot can link it to a PR, mark it ready after review, and record settlement.

The settlement rail is flexible. The MVP supports Arc USDC, GitHub Sponsors, and manual settlement. Arc USDC is useful for fast, low-cost, verifiable task-level payouts, while Sponsors and manual settlement preserve the community-friendly open-source model.

This is not a trading bot. It is an agent interface for open-source contribution incentives: coordinating work, claims, delivery evidence, and settlement.

## Traction Notes

- contribbot is already a working MCP server and skill-based workflow system for open-source maintenance.
- The bounty MVP is implemented inside contribbot itself.
- The project is being used to manage its own hackathon development todos and design notes.
- Initial user: the maintainer building contribbot across multiple repositories.

## Current MVP Limitations

- Arc USDC is represented as a settlement rail and instruction / transaction record. The MVP does not custody private keys.
- GitHub comment posting for bounties is not yet wired into the bounty tools; the MVP returns markdown that can be posted to GitHub.
- There is no public marketplace UI yet. This is a GitHub-native maintainer workflow tool.

## Next Steps

- Add `/contribbot:bounty` skill workflow.
- Add GitHub issue comment integration for bounty create and claim.
- Add Arc testnet transfer integration through ARC CLI or Arc App Kit.
- Add repository-level self-evolving knowledge base for Phase 3 agent memory.
