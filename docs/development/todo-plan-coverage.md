# Todo Plan Coverage

Current status, 2026-09-19: C, B, D and six-state Todo convergence are implemented
and locally verified. The known-settled open-Issue pause path was approved and
fixed. Final full MCP regression: 63 files, 902 passed, one Windows skip.
See the [current C/B/D audit](todo-cbd-audit.md). The B/D "not implemented",
"pending decision" and legacy migration statements below are historical, not
current blockers. The user excluded old Todo-state compatibility and migration.
This does not authorize runtime activation or complete the tracking Todo.

Date: 2026-09-18. This records batch C of the
[Todo lifecycle design](../plans/2026-09-18-todo-lifecycle-delivery-design.md).
The code, focused verification and subsequent full MCP regression are complete.
B is now in implementation and verification; D remains unimplemented.
See [stop control](todo-control.md) for the current B boundary.
This is not completion or archival of the tracking Todo
`t-7a4e458d-b057-400e-b697-abf21939bb49`.

## Behavior

| Boundary | Implemented behavior | Note |
| --- | --- | --- |
| New plan | Requires `completion_scope` and `remaining_scope`, included in the existing plan digest | Confirmation still targets the exact plan version |
| Stage plan | Uses `completion_scope: stage` and nonempty remaining task goals | Passing stage checks retains the open execution, not a stopped or completed Todo |
| Whole-task plan | Uses `completion_scope: task` and an explicit empty remaining array | The declaration is necessary, not proof of acceptance |
| New completion | `reserve_closure` requires confirmed whole-task coverage for both `verified` and `with_gaps` | Acknowledging gaps cannot waive missing task coverage |
| Stop | Existing `stopped` closure does not require whole-task coverage | Existing settlement and candidate checks still apply; this is not B's new cancellation control |
| Context | MCP context and local inspect expose `completion_coverage` | Scope eligibility is separate from current check results and user acceptance |
| Document | Generated records and stage Next expose remaining goals | The generated Markdown is not a second source of truth |

Plans and checks remain in the same Todo execution. There is no new Phase or Work
entity. Moving from a stage plan to a whole-task plan requires confirmation of the
new digest, a new attempt and applicable fresh checks; previous checks remain
historical evidence rather than passes for the new plan.

The declarations do not infer intent from words in the user's message. The host
must explain the entire Todo goal, this plan's scope and what remains, then record
the user's confirmation. Tests exercise the resulting contract; they do not prove
that a live host correctly understood a natural-language request.

## Compatibility

Missing stored fields remain missing. Reads do not inject defaults, recalculate
historical plan digests or reinterpret completed execution history. A stored
`task` declaration without `remaining_scope` is also incomplete, not an implicit
empty list.

A legacy plan can still be read and used for ordinary work, but it must receive a
new confirmed coverage declaration before starting a new whole-task completion.
Previously persisted reserved/prepared closures remain recoverable under their
original intent, plan/attempt/epoch binding, candidate and evidence checks. This
avoids stranding a closure after its remote effect already happened. An explicit
stage declaration still refuses `verified` and `with_gaps`.

Historical completed requests retain their idempotent result. Returning that
result does not verify later code changes. No real data migration, installation,
runtime activation, commit or push was performed.

This is not a guarantee that arbitrary old writers can safely share newly
written data. B/D still need the writer-compatibility boundary resolved and
verified before activation. Legacy `pr_submitted` and `not_planned` remain; their
migration is deferred until after D validation and separate authorization.

## Verification

| Check | Result | Note |
| --- | --- | --- |
| Initial coverage RED | 3 intended failures | New undeclared proposals and new stage/legacy completion reservations |
| Independent-review regression RED | 1 intended failure | A partially declared stored task plan incorrectly appeared eligible |
| Full MCP run during the final fix | 573 passed, 1 failed, 1 skipped; 47 files | The failure is the incomplete-declaration regression; source changed during this run, so it is not a final all-green snapshot |
| Subsequent full MCP regression | 574 passed, 1 skipped; all 47 files passed | Started September 18 at 23:51 and finished September 19, 2026 (UTC+08:00); 699.12 seconds; no implementation edits during the run |
| Final workflow tests | 22 passed | Includes the predicate fix and legacy reserved/prepared recovery |
| Final closure/MCP/Issue regressions | 57 passed | 13 closure, 7 MCP workflow and 37 Issue-close tests; Issue requests are mocked |
| Final typecheck and build | Passed | `pnpm exec tsc --noEmit` and `pnpm build` in the MCP package |
| Final built CLI/MCP smoke | 16 scenarios passed | Rebuilt after the predicate fix; real subprocesses and isolated Git/data fixtures |
| Independent follow-up review | No new findings | Reviewer reports 7 in-memory assertion groups; 7 scoped file hashes unchanged |

The full rerun used `pnpm --filter contribbot-mcp test`;
`pnpm --filter contribbot-mcp typecheck` also passed during this verification. The one skipped test is
`candidate.test.ts`'s unstaged executable-bit case, explicitly skipped on Windows.
This does not verify that behavior on Linux/macOS. GitHub effects remain mocked.

An in-run and post-run aggregate SHA256 matched:
`bcfdc2c0faafee7d40d2ebdcb9354bb49c05fa208b15d499d15c1dbe86bb84c4`.
Its 142 inputs are files under `packages/mcp/src` and `packages/mcp/scripts`,
plus the MCP package, TypeScript, Vitest and tsdown configuration and the root
`pnpm-lock.yaml`. The fingerprint hashes compact JSON of sorted slash-normalized
paths and lowercase per-file SHA256 values. It is a code snapshot identifier,
not additional test or independent-review evidence.

The independent reviewer did not run Vitest or the CLI/MCP integration suite.
Their in-memory assertions and static review are distinct from the primary
agent's actual integration runs. The review was no-write requested and
fingerprint audited, not sandbox-enforced.

Reproduce focused verification from the MCP package:

```sh
pnpm exec vitest run src/core/execution/workflow.test.ts src/core/execution/closure.test.ts src/mcp/workflow.test.ts src/core/tools/linkage/issue-close.test.ts
pnpm typecheck
pnpm test:execution-smoke
```

Windows was exercised. Linux/macOS, real GitHub operations, live AI/user
acceptance and a deployed runtime were not tested. No claim is made that the
complete Phase 3 workflow or the final full repository suite has passed.

## Consultation And Next

Claude rounds 96 and 97 successfully continued the existing design session.
The adopted direction was to reuse versioned plans and checks, preserve stage
history without closing the Todo, and protect recovery of old pending closures.
Round 98, a follow-up compatibility question, failed with HTTP 403 and
`no active subscription`; it supplied no design approval or review.
The later B-specific round 99 timed out after 180 seconds with no response.
The runner exited and recorded failure; it is not an outstanding live consultation.
At the user's retry request, round 100 returned B design advice successfully in
about 121 seconds, with exit zero and the original session identity. Consultation
is available again for this call. The advice has not been adopted wholesale and
does not establish B implementation, user acceptance or migration permission.

Round 101 also succeeded in the same session. Claude withdrew the claim that
all prepared closures must finish before a later stop request can take effect.
The coordinator accepts preserving committed facts while distinguishing
reversible local preparation, but has not implemented a new precedence policy.
The user decision remains pending: when the remote Issue is already closed but
local Todo completion is not committed, should a later cancellation end the
Todo as cancelled after accounting for original effects, without reopening the
Issue? See the lifecycle design and round-101 coordinator note.

An isolated compatibility probe executed the actual HEAD legacy TodoStore class:
it ignored a top-level format marker, changed a fixture from paused to active,
and discarded the marker on save. The source fingerprint, injected helper limits
and unresolved B boundaries are recorded in section 9 of the lifecycle design.
This is evidence of an activation risk, not a new chosen storage format.

The next authorized order remains B, then D:

| Batch | Existing discussed direction | Note |
| --- | --- | --- |
| B | Durable pause/cancel intent, block new business operations, retain recovery, settle safely, resume with invalidated evidence | Not implemented; the linked-Issue cancellation decision above needs user confirmation before changing shared closure/replay behavior |
| D | Plan-owned deliverables, candidate/object-version-bound observations, independent PR progress | Not implemented; PR links still affect the old status in current code |
| Migration | Consider removing legacy enums after D validation | No real-data migration is authorized here |

CatPaw currently reports five preexisting board validation errors. This document
records progress without bypassing those checks, editing unrelated Work records
or treating an invalid board as completed.
