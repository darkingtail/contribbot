# upstream_daily Redesign: Version-Anchored Tracking

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor `upstream_daily` from time-based (days) to version-anchored tracking, using GitHub compare API.

**Architecture:** `upstream_daily` uses the last tracked version tag as anchor instead of a day count. First-time usage requires the user (or agent) to provide a starting version. The compare API (`{tag}...HEAD`) gives exact commits since that version.

**Tech Stack:** TypeScript, GitHub REST API (compare endpoint, releases endpoint), existing UpstreamStore

---

## Background

### Project Types (by upstream relationship)

|  | upstream set | upstream not set |
|--|-------------|-----------------|
| **fork set** | Fork + enhancement (plane, Sub2API) | - |
| **fork not set** | Port/alignment (antdv-next <- ant-design) | Own project (contribbot) |

Only projects with `upstream != null` need daily tracking. The `fork` field does NOT affect daily logic -- both fork and port use the same mechanism: compare on the upstream repo.

### Current Problem

`upstream_daily(upstream_repo, days=7)` uses an arbitrary time window. The real anchor should be the last tracked version tag -- daily exists to bridge between version releases, not as a standalone time-based poll.

### Workflow

```
v5.20.0 (user's baseline)
  |
  v5.21.0, v5.22.0, v5.23.0, v5.24.0  <-- recorded as pending versions
  |
  daily: compare/5.24.0...HEAD  <-- only new commits after latest release
  |
  v5.25.0 released -> sync_check -> markDailyAsSynced -> new daily anchor
```

---

## Design

### API Changes

**Before:**
```
upstream_daily(upstream_repo, days?, repo?)
```

**After:**
```
upstream_daily(upstream_repo, repo?, since_tag?)
```

- `since_tag`: Only needed on first call to set baseline. Ignored once store has version records.

### Three Runtime States

#### State 1: No anchor, no `since_tag` (first time, no input)

1. Fetch upstream releases via `listReleases(owner, repo)`
2. Return a formatted table of recent releases
3. Prompt: "Call again with `since_tag` to set your baseline"
4. **Not an error** -- returns actionable info for agent/user to pick

```markdown
## Initialize Sync Anchor

No tracked versions for ant-design/ant-design.

| # | Version | Date |
|---|---------|------|
| 1 | 5.24.0  | 2026-03-01 |
| 2 | 5.23.0  | 2026-02-15 |
| 3 | 5.22.0  | 2026-01-20 |
| 4 | 5.21.0  | 2026-01-05 |
| 5 | 5.20.0  | 2025-12-10 |

Select your current aligned version:
upstream_daily(upstream_repo="ant-design/ant-design", since_tag="5.xx.0")
```

#### State 2: No anchor, with `since_tag` (first time, with input)

1. Fetch all releases after `since_tag`
2. For each release between since_tag and latest: call `upstream_sync_check` logic to extract PR items, write as version entries in upstream.yaml (status: active)
3. Latest release becomes daily anchor
4. `compare/{latestTag}...HEAD` to get new commits
5. Normal daily output

#### State 3: Has anchor (normal run)

1. Read latest tracked version tag from store
2. Check if upstream has newer releases since that tag
   - If yes: record new versions in store, update anchor to latest
3. `compare/{anchor}...HEAD` to get commits since anchor
4. Deduplicate, noise detection, auto-detect issues/PRs
5. Normal daily output

### GitHub Client Additions

```typescript
// New: Compare API
interface CompareResult {
  commits: Array<{
    sha: string
    commit: { message: string, author: { name: string, date: string } | null }
    author: { login: string } | null
  }>
  total_commits: number
}

export async function getCompareCommits(
  owner: string, repo: string, base: string, head: string
): Promise<CompareResult>

// New: List releases (paginated, sorted by date desc)
export async function listReleases(
  owner: string, repo: string, perPage?: number
): Promise<GitHubRelease[]>
```

### UpstreamStore Changes

No schema changes needed. Existing `versions` array and `daily` data structure work as-is.

Add helper method:
```typescript
getLatestVersionTag(repo: string): string | null
// Returns the version string of the newest tracked version, or null
```

### server.ts Parameter Changes

```typescript
server.tool(
  'upstream_daily',
  'Fetch upstream commits since last tracked version. First run: shows releases to pick baseline.',
  {
    upstream_repo: z.string().describe('Upstream repo, e.g. "ant-design/ant-design"'),
    since_tag: z.string().optional().describe('Baseline version tag for first-time init, e.g. "5.20.0"'),
    repo: repoParam,
  },
  wrapHandler(async ({ upstream_repo, since_tag, repo }) =>
    upstreamDaily(upstream_repo as string, repo as string | undefined, since_tag as string | undefined),
  ),
)
```

### Edge Cases

- **Upstream has no releases**: Return error "No releases found for {repo}"
- **since_tag not found in releases**: Return error "Tag {tag} not found in releases"
- **Compare API returns 500+ commits**: Still works, but output truncates table and shows count
- **New release detected during normal run**: Auto-record it, shift anchor forward

---

## Implementation Tasks

### Task 1: GitHub client -- add compare and listReleases

**Files:**
- Modify: `src/core/clients/github.ts`

Add `getCompareCommits()` and `listReleases()` functions with proper types, timeouts, and null guards.

### Task 2: UpstreamStore -- add getLatestVersionTag

**Files:**
- Modify: `src/core/storage/upstream-store.ts`

Add method to get the latest tracked version tag for a given upstream repo.

### Task 3: Refactor upstream_daily core logic

**Files:**
- Modify: `src/core/tools/upstream-daily.ts`

Replace days-based logic with three-state version-anchored logic:
- State 1: no anchor, no since_tag -> list releases
- State 2: no anchor, with since_tag -> init + fetch
- State 3: has anchor -> normal compare

### Task 4: Update server.ts registration

**Files:**
- Modify: `src/mcp/server.ts`

Replace `days` param with `since_tag`. Update handler call.

### Task 5: Update exports and verify

**Files:**
- Modify: `src/index.ts`
- Run: `pnpm test && pnpm build`
