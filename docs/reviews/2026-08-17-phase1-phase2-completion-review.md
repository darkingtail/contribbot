# Phase 1 & Phase 2 Completion Review

**Status:** Active follow-up  
**Reviewed:** 2026-08-17  
**Scope:** Phase 1 (MCP tools) and Phase 2 (Skills) on `main`

## Purpose

This review separates three questions that are easy to blur together:

1. Is the Phase 1 tool layer implemented and buildable?
2. Do the Phase 2 Skills describe real, usable workflows over those tools?
3. What must be closed before Phase 3 depends on these workflows as agent capabilities?

The answer is not simply "done" or "not done": the foundations are real and
usable, but several high-value workflow promises need a final consistency pass.

## Review Boundary

At review time, `main` and `origin/main` point at `4e99548`
(`docs: record phase3 reference projects`). The working tree also contains an
uncommitted Phase 3 Patrol spike. That spike is intentionally outside this
review and must not be treated as a shipped Phase 1 or Phase 2 capability.

The following checks were run in the current workspace:

```text
pnpm test
pnpm build
```

Observed results:

```text
pnpm test  -> 12 test files passed; 109 tests passed
pnpm build -> contribbot-mcp build completed
```

These results confirm that the current workspace is buildable. Because the
workspace includes uncommitted Patrol files and tests, a release check for a
future Phase 1/2-only release should also run from a clean checkout of the
target commit.

## Phase 1 — MCP Tool Layer

### What is verified

Phase 1 has a usable and tested MCP foundation:

- TypeScript MCP server builds successfully.
- The server exposes repository, Todo, upstream, GitHub, knowledge, reward,
  quality, and global-project capabilities.
- Repository-scoped tools require an explicit `owner/repo` input, except for
  intended global views such as cross-project contribution statistics.
- Local structured state is backed by the existing YAML stores.
- GitHub-facing linkage tools keep local Todo and upstream state connected to
  public Issues and PRs.
- Knowledge evolution uses the reviewable
  `propose -> review -> apply/reject -> audit` flow rather than silently
  changing canonical repository knowledge.

The present workspace registers `53` MCP tools, `1` resource template, and
`4` prompts. The committed `main` baseline registers `52` tools, `1` resource
template, and `4` prompts; the additional workspace tool belongs to the
uncommitted Patrol spike.

### Phase 1 conclusion

**Core implementation: complete and usable.**

Phase 1 should not be reopened to redesign its base architecture. Future work
should add narrowly justified read capabilities for agent investigation, rather
than duplicate existing storage or GitHub integration in the agent runtime.

### Phase 1 follow-up

The public tool count in [docs/tools.md](../tools.md) does not match the actual
registered tool count. This may be intentional if internal-only tools are
excluded, but the documentation does not state that rule. Before the next
release, make one of these contracts explicit:

- document every registered public MCP tool; or
- label the catalogue as a user-facing subset and document the exclusion rule.

The MCP server registration should be the authoritative source for the count.

## Phase 2 — Skills Workflow Layer

### What is verified

The plugin contains ten Skill definitions with valid frontmatter:

| Skill | Primary workflow |
| --- | --- |
| `project-onboard` | Initialize a tracked repository and its mode |
| `daily-sync` | Inspect maintenance state and upstream updates |
| `start-task` | Select, activate, and document a Todo |
| `todo` | Manage the Todo lifecycle |
| `issue` | Manage GitHub Issues |
| `pr` | Manage Pull Requests and review replies |
| `pre-submit` | Assess PR merge readiness |
| `weekly-review` | Review repository or cross-project progress |
| `fork-triage` | Assess fork-source changes for a customized branch |
| `dashboard` | Show repository or cross-project status |

The architecture remains sound:

```text
User intent
  -> Skill workflow instruction
  -> MCP tools
  -> GitHub and ~/.contribbot state
```

Skills deliberately leave project-specific judgment—such as issue subtask
identification, upstream relevance, and branch naming—to the host LLM, while
the MCP layer owns deterministic reads and writes.

### Phase 2 conclusion

**Usable and structurally complete, with three workflow-quality gaps to close.**

The Skills should remain the guided, human-driven layer. They do not need an
agent runtime to be valuable. However, the three gaps below would become
serious once Phase 3 starts reusing Skills and MCP tools for autonomous
investigation.

## Workflow Gaps

### 1. `start-task` promises branch-convention discovery without a source

[`start-task`](../../skills/start-task/SKILL.md) tells the assistant to inspect
existing branch names before suggesting one. The MCP server currently has no
branch-list or local Git branch inspection capability.

Choose one explicit resolution:

- add a safe read-only branch discovery tool; or
- change the workflow to use recorded repository knowledge when available and
  otherwise offer a clearly labelled default convention.

### 2. `pre-submit` can inspect repository CI rather than PR-specific CI

[`pre-submit`](../../skills/pre-submit/SKILL.md) calls `actions_status(repo)`.
The current tool can filter by branch, but the Skill does not pass the PR's
head branch or commit SHA. It can therefore report a recent repository run
instead of the checks for the pull request under review.

The workflow needs a PR-specific check lookup—by PR number, head SHA, or head
branch—and an acceptance test that proves it rejects a PR whose own required
check is failing.

### 3. `fork-triage` requires evidence that its tools do not yet expose

[`fork-triage`](../../skills/fork-triage/SKILL.md) asks the LLM to assess file
impact, conflict risk, and cherry-pick value. The tool layer currently lacks
the read-side evidence needed for that decision, such as:

- upstream commit detail and changed-file diff;
- comparison with the customized branch or target repository code;
- code and Issue/PR association search.

Until those reads exist, the workflow is a human-guided suggestion process,
not a reliable cherry-pick assessment.

## Recommended Closure Order

1. **Publish a truthful tool catalogue.** Define whether `docs/tools.md` lists
   all registered MCP tools or a documented user-facing subset.
2. **Make pre-submit PR-specific.** This protects a concrete public decision:
   whether a PR is ready to merge.
3. **Resolve start-task branch naming.** Add branch discovery or narrow the
   written promise to match available evidence.
4. **Add fork-triage investigation reads.** Start with commit detail/diff and
   target-code comparison; do not begin with automatic cherry-picks.
5. **Add workflow-level fixture tests.** Cover `none`, `fork`, `upstream`, and
   `fork+upstream` paths so a tool rename or schema change cannot silently
   invalidate a Skill.

## Relationship to Phase 3

Phase 3 should build on, not replace, the existing layers:

```text
Phase 1: deterministic tools and durable state
Phase 2: human-guided workflow instructions
Phase 3: evidence-driven investigation and confirmation-gated execution
```

The current Phase 3 Patrol spike proves MCP connectivity, structured model
output, and audit storage. It does not yet prove an investigation loop. The
next agent slice should dynamically investigate one concrete maintenance lead
before making a decision, rather than summarize a fixed dashboard snapshot.

## Final Assessment

| Area | Assessment | Next action |
| --- | --- | --- |
| Phase 1 tools and storage | Complete and usable | Keep stable; add only investigation reads with clear need |
| Phase 1 public reference | Needs alignment | Reconcile tool count and catalogue scope |
| Phase 2 Skill structure | Complete and usable | Preserve the 10-Skill workflow model |
| `start-task` | Needs contract alignment | Add branch discovery or narrow the instruction |
| `pre-submit` | Needs correctness fix | Resolve CI against the reviewed PR |
| `fork-triage` | Needs evidence tools | Add commit and code comparison reads |
| Phase 3 | Experimental | Design an Investigator loop; do not call the Patrol spike a finished MVP |

The practical decision is: **treat Phase 1 as closed, treat Phase 2 as
available but needing a focused quality pass, then build Phase 3 on the
resulting reliable investigation primitives.**
