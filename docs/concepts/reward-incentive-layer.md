# Reward Incentive Layer

## Status

Draft. The bounty MVP is now on `main`, but the broader reward / incentive model is still an active product design thread. Keep the implementation conservative until the reward model and statistics boundary are clearer.

## Positioning

The bounty feature should evolve into a broader reward / incentive layer for open-source contribution workflows.

The core product is not "crypto bounty payment". The core product is coordination:

- what work is available;
- who claimed it;
- what evidence delivers it;
- whether maintainers reviewed and accepted it;
- what reward was promised;
- how the reward was fulfilled.

GitHub remains the system of record for issues, PRs, reviews, and public discussion. contribbot tracks the incentive layer around that native GitHub workflow.

## Core Shift

The MVP currently talks about `payout rail`. That is too narrow.

Use `reward rail` or `incentive rail` as the broader product concept.

Money is one reward type, but not the only one. A maintainer or sponsor may reward contributors with:

- Arc USDC;
- GitHub Sponsors;
- manual payment;
- AI assistant subscriptions;
- API credits;
- model tokens;
- SaaS coupons;
- cloud credits;
- maintainer-defined perks;
- custom non-monetary rewards.

This keeps the product aligned with open-source culture. It supports crypto when useful, without forcing every contribution to become a crypto transaction.

## Lifecycle

The lifecycle should stay close to the existing bounty MVP:

```text
open -> claimed -> delivered -> ready -> rewarded
```

Meaning:

- `open`: a reward is attached to an issue, todo, upstream item, or maintainer-defined task.
- `claimed`: a contributor declares intent to work on it.
- `delivered`: there is delivery evidence, usually a PR, commit, demo, issue comment, or external link.
- `ready`: the maintainer has reviewed the evidence and considers the reward payable or grantable.
- `rewarded`: the reward has been fulfilled and the proof is recorded.

The MVP name `settled` still works for money rails, especially Arc USDC, but `rewarded` is more general when the reward is a subscription, token quota, coupon, or service credit.

## Suggested Data Model

Future versions can generalize the current bounty fields toward:

```ts
type RewardType =
  | "money"
  | "subscription"
  | "credits"
  | "service"
  | "custom";

type RewardProvider =
  | "arc-usdc"
  | "github-sponsors"
  | "manual"
  | "openai"
  | "anthropic"
  | "cursor"
  | "cloud"
  | string;

interface RewardSpec {
  type: RewardType;
  provider: RewardProvider;
  description: string;
  amount?: string;
  currency?: string;
  expires_at?: string;
  terms?: string;
}

interface RewardProof {
  provider: RewardProvider;
  proof: string;
  note?: string;
  recorded_at: string;
}
```

The important part is the human-readable `description`. Many rewards will not fit cleanly into amount/currency fields, and contribbot should not pretend they do.

## Agent Role

The agent should not decide that a contribution deserves a reward by itself. That remains a maintainer decision.

The agent can help with:

- discovering rewardable work from issues, todos, and upstream changes;
- drafting reward terms;
- detecting existing claims;
- recording claim state;
- linking PRs and delivery evidence;
- summarizing whether review, CI, and discussion suggest the work is ready;
- preparing reward instructions;
- recording fulfillment proof;
- showing unresolved reward obligations.

The agent coordinates and summarizes. It should not unilaterally approve rewards or move money unless a maintainer explicitly confirms that action.

## Statistics Boundary

This feature naturally leads to statistics, but statistics should not be merged into the core MVP too early.

Useful future metrics:

- open rewards;
- claimed rewards;
- ready but unfulfilled rewards;
- rewarded items by provider;
- total monetary amount by currency;
- non-monetary rewards by category;
- contributor reward history;
- maintainer or sponsor reward spend;
- average time from claim to delivery;
- average time from ready to rewarded;
- delivery / completion rate;
- stale claims.

Implementation boundary:

- Store reward events first.
- Build statistics as derived views later.
- Avoid hard-coding monetary assumptions into dashboard and weekly review.

This keeps the MVP simple while preserving enough event history for later analytics.

## Integration Points

Potential contribbot integrations:

- `todo_detail`: show attached rewards and claim state.
- `todo_claim`: optionally claim a reward-backed work item.
- `project_dashboard`: show unresolved reward obligations.
- `weekly_review`: summarize reward activity and stale claims.
- `knowledge_write`: record project-specific reward policies.
- GitHub comments: publish claim and reward-ready state for team visibility.

## Merge Strategy

Keep reward / incentive work on `feature/agora-bounty-agent` for now.

Do not merge into `main` until the following are clearer:

- whether the public concept should be called bounty, reward, or incentive;
- whether `settled` should become `rewarded`;
- how much of the current bounty MVP data model needs migration;
- which statistics belong in core dashboard versus optional reports;
- how GitHub-native reward coordination should appear in comments.

The feature is promising, but it is a new product domain inside contribbot. It should enter `main` through smaller, reviewed steps rather than one large merge.
