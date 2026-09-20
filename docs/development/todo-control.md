# Todo Stop Control

Batch B of the [lifecycle design](../plans/2026-09-18-todo-lifecycle-delivery-design.md).
Source implementation and local verification are complete, including prepared
and plain Issue stop accounting. The final full MCP run passed 902 tests across
63 files, with one Windows skip. This is not native-host user acceptance.
The [current C/B/D audit](todo-cbd-audit.md) and
[six-state record](todo-six-state.md) supersede historical progress notes below.
Old Todo-state compatibility and migration are excluded by the user's decision.

## Contract

| Action | Behavior | Note |
| --- | --- | --- |
| `todo_control` / local `apply(request_control)` | Record the explicit user pause/cancel decision and fence new work | Stable Todo/execution/control/request identities and expected revision required |
| Requested stop | Preserve running, unknown and returned operations and pending closure | Not yet paused or cancelled; original occupancy remains |
| `settle-pause` | Require settled operations, no pending closure, owner yield and actual local candidate | Unbound design work does not invent an attempt, command or check |
| `continue` | Explicitly withdraw a stop or resume a settled pause after accounting and inspection | Same execution/attempt; epoch advances and yield clears; old checks remain historical |
| `cancel-close` | Withdraw a reversible pending closure under the exact active control request | Original owner and revision required; not Todo cancellation, archive, remote mutation or rollback |
| Local `close(mode=stopped)` | Safely finish the matching explicit cancellation as cancelled | Decision must match; no automatic cancellation, rollback, GitHub mutation or archive |
| `resume` / `todo_resume` | Repair/read stored context only | Does not unpause, dispatch, inspect current files or grant acceptance |
| Plain cancellation | Explicit `todo_cancel` records cancelled without inventing an execution | Old Todo states are rejected; no migration or silent relabeling |

New source readers expose paused/cancelled in queries and preserve terminal state
on archival/restore. Generic status updates and activation cannot bypass active
control. A pause request can be superseded by an explicit cancellation; changing
one's decision to continue uses the local accounting path.

## Execution Safety

Exact request replay remains a historical readback, not a new dispatch permit.
Check callers, supervisor claims and final synchronous command spawn are fenced.
The spawn and stop-intent write share the Todo mutex; waiting for the command
occurs outside the lock. An admitted operation remains unresolved until its actual
result or explicit reconciliation accounts for it.

Observation, original result recovery, candidate collection/adoption, yield and
closure receipt/reconciliation remain available. A control request is the narrow
exception that can persist without accessing the original workspace: it does not
alter bindings, operations, registry metadata or occupancy.

Control settlement/resumption references immutable local artifacts and manifests.
Missing accounting evidence is not repaired by inventing a successful test.
Resume re-inspects files rather than assuming a historical paused flag proves
their current state.

Pending Issue closure is displayed as a concrete blocker. Neither a missing
receipt nor externally closed Issue proves the local Todo cancelled or completed.
The user confirmed the cancellation outcome on 2026-09-19; the current source
adds cancellation-specific `reconcile-close` with the exact active `control_id`
and decision. Ordinary continuation cannot override cancellation. A reversible
local reservation can instead use `cancel-close` before settlement. Exact replay
returns current state without acting on a newer reservation.

### PR And Claim Requests

Admission and completion of an asynchronous GitHub request are separate facts.
PR creation and claim comments now persist a bounded, closed-kind journal in
`.operations/remote-<Todo identity hash>.json` before dispatch. Stop intent does
not wait for the network mutex: the original response must be recorded first,
and local linkage must then finish before safe settlement or lifecycle release.
The guard also covers unbound/ordinary Todos, terminal updates, deletion,
archival and activation. A closing reservation fences new claim comments.

The original request payload and execution identity are retained. Exact retries
with a saved receipt repair linkage without another POST, including a claim
whose Issue is now closed. PR requests add a hidden `contribbot:pr-op` correlation
marker; claim uses its existing marker. A positive original-marker lookup can
recover a lost response. A listing with no match, an ambiguous match or a network
error never proves that nothing happened and never authorizes redispatch.
These markers are correlation records, not authentication or user approval.

Journal responses are immutable observations, not the latest PR state. Completed
journals remain as audit records across archival/deletion; no implicit purge is
introduced. Journal storage does not make an old writer enforce the new gates.
If a remote outcome cannot be recovered, the Todo remains explicitly blocked:
the proposed "user accepts unknown and releases it" policy has not been adopted.
This remaining product boundary is not silently treated as safe settlement.

## Compatibility And Verification

New fields are optional on historical reads. Old writers were experimentally
shown to ignore a format marker and overwrite a paused status. Therefore this
source work is tested in isolated stores, not activated against a mixed-version
live data root. Production writer isolation and authorized rollout are still
required before deployment.

Initial RED established missing control commands and pending-check replay
dispatch. Four reducer tests then passed with the existing 22 workflow tests.
New end-to-end tests initially failed on missing paused/cancelled projections;
the projections are now implemented and under regression.

Current verification results will be appended after the final source snapshot.
Real GitHub, real host dialogue, Linux/macOS, mixed-version rollout and independent
review are not implied by source-level tests.

## Current Verification

| Check | Result | Note |
| --- | --- | --- |
| Missing local withdrawal endpoint | RED, then GREEN | `cancel-close` plus wrong-owner/superseded-control cases |
| Issue cancellation and corrupted epoch findings | Targeted regressions pass | Preserve remote reservation; old checks stay historical |
| In-flight PR settlement | RED, then GREEN | Deferred mocked POST could previously settle pause |
| PR / claim / journal regressions | 25 tests pass | Includes RED/GREEN for delayed original PR response overwriting a newer association |
| Local/lifecycle/claim/PR regression snapshot | 58 tests pass | Before the final additional journal/claim cases |
| Typecheck and build | Pass | Source runtime only, not installation |
| Web project stats regression | 1 test passes | Includes new paused/cancelled counts |
| Built CLI/MCP smoke | 18 scenarios pass | Windows, scripted host/user; includes bound pause/continue/fresh checks and unbound design control |
| Full MCP suite | 605 passed, 2 failed, 1 Windows skip | 49 files, 1042.22s; started before the final replay fix and CLI expectation update |
| Fresh affected-surface rerun | 61 passed, 7 files | CLI discovery, PR/claim, journals, control, request schema and MCP server; 22.82s |

Independent follow-up reproduced the in-flight PR/claim gap and a claim dispatch
while already closing. It also confirmed the three earlier review fixes using
in-memory probes. The journal implementation then received its own focused review.
No-write was requested and audited, not sandbox-enforced.

Journal review found that an already-linked request could overwrite a later PR
association on replay. A new disk-backed handler regression reproduced the
problem, then passed after linkage began re-reading the journal under the Todo
mutex and treating `linked` as mutation-free history. Claim replay uses the same
guard. The narrow independent follow-up repeated the memory-only PR race and
confirmed both delayed response and exact replay preserve the newer association
with zero additional Todo updates. Claim guard was source-verified only.

The full run's two failures were the old CLI allowed-action expectation (missing
`request_control`) and the PR replay regression against the runtime loaded before
its fix. Both were reproduced separately, fixed and included in the fresh
61-test pass. The full run is intentionally not relabeled as all green; the
final CLI test-only correction was not followed by another 17-minute full run.
The Windows skip concerns unstaged executable-bit observation, not pause logic.

Reproduction commands:

```text
pnpm --filter contribbot-mcp exec vitest run --maxWorkers=1
pnpm --filter contribbot-mcp exec vitest run src/cli/execution.test.ts src/core/tools/linkage/pr-create.test.ts src/core/tools/core/todo-claim.test.ts src/core/storage/remote-effects.test.ts src/core/execution/request-help.test.ts src/core/execution/control.test.ts src/mcp/server.test.ts --maxWorkers=1
pnpm --filter contribbot-mcp exec tsc --noEmit
pnpm --filter contribbot-mcp build
node packages/mcp/scripts/execution-smoke.mjs
node --test packages/web/server.test.mjs
```

Independent final replay audit fingerprints (SHA-256):

| Source | SHA-256 | Note |
| --- | --- | --- |
| `pr-create.ts` | `9b47f71641240f346affbe36978d8f4a466ca6390cd7a0af7954f5e61dbcaa91` | Delayed original and replay probes passed |
| `todo-claim.ts` | `a4cb0ae8b686280b902e85df999191e7cb5b1f856c5c362c32338150292d2486` | Linked-replay guard source-verified |
| `remote-effects.ts` | `eb0a90c04d62bc2e532a1ee59245cd07d4c5f5622770fdec9d6f292daffe5930` | No-write audit unchanged |

Next: resolve D's reported-versus-read-back remote delivery evidence boundary,
then implement its confirmed contract without removing legacy enums. See the
round-107 coordinator note and the lifecycle design's current progress section.

Update, 2026-09-19: the user has resolved that evidence-policy question. Reported
merges remain pending verification until an actual query confirms the required
remote delivery. The earlier Next is historical, not a reason to ask again.
Implementation still needs the remote observation/closure contract. The existing
Claude consultation session is currently unavailable; recovery diagnostics and
a source-linked handoff are in
`.catpaw/discussions/phase3-claude/round-120.coordinator.md` and
`.catpaw/discussions/phase3-claude/continuation-handoff.md`.
The unresolved B remote-effect gates above remain unchanged.

Later on 2026-09-19, the user approved retaining the predecessor and starting a
successor consultation. Rounds 121/122 succeeded, and D's explicit remote
readback paths have been implemented. Current verification and remaining scope
are recorded in [Todo delivery](todo-delivery.md#d-增量远端交付核验).
The old consultation outage is no longer a blocker. This does not resolve or
silently remove B's pending-Issue cancellation and unknown-outcome safeguards.

## Prepared Issue Cancellation: Confirmed Outcome

On 2026-09-19, rounds 123/124 examined the actual workflow transitions.
There was a missing safe route, not just an untested edge: active cancellation
blocks `reconcile_closure`, while a prepared Issue closure blocks
`cancel_closure`; its remaining reservation prevents settling the cancellation.
The same restriction can affect an operation that was prepared but not dispatched.
The original negative test remains: reconciliation without the matching
cancellation control and decision cannot release the reservation.

The outcome was **explicitly confirmed by the user on 2026-09-19** ("这个可以按照你的建议").
The implementation and local regression for this increment are complete. It preserves the user's
explicit cancellation. After proving no dispatch or accounting for all original
effects, withdraw/reconcile the old closing intent and finish only the local
Todo as cancelled, retaining remote facts. No automatic done/archive, Issue
reopen, code rollback or repeated public action. Unknown original effects
remain unresolved; absent journals/markers and timeouts are not proof of safety.

This scenario starts with an explicitly authorized linked Issue/Todo close and
a later explicit cancellation. It does not turn an externally closed Issue into
permission to cancel or complete a still-running local Todo.

Claude initially proposed superseding cancellation with the remote fact; the
coordinator rejected that. After reading workflow.ts, Claude acknowledged the
missing route and supported retaining the cancellation. Its suggestion that a
missing dispatch-intent alone can prove no dispatch is also not accepted.
Precise dispatch provenance and compatibility need design, not a bypass flag.
The original journal/lock evidence alone is insufficient.

Discussion and dispositions:
`.catpaw/discussions/phase3-claude/round-124.coordinator.md`.
The previous request for this product decision is resolved, not a reason to ask
again. Round 125 timed out without a response; rounds 126/127 returned and were
reviewed before the respective implementation decisions. No runtime installation,
live migration or GitHub mutation is authorized.

### Cancellation Reconciliation

| Boundary | Current source behavior | Note |
| --- | --- | --- |
| New managed Issue journal | Versioned dispatch ledger, exact closure/comment binding, write admission before API call | Admission and dispatch gate share the Todo transaction; Issue mutex remains outside |
| Returned response after cancel | Record the original result before local completion is attempted | Cancellation fences new effects, not recording facts |
| Cancellation reconciliation | Require exact active control/decision, original owner/attempt/machine/revision, current candidate and actual host/user report | Report prose is not authentication or proof of process termination |
| Dispatch accounting | Require an initialized ledger and a returned result for every admitted effect | Zero admissions is meaningful only with positive initialization and dispatch fences |
| Missing/legacy/unknown provenance | Keep reservation pending, including legacy closed observations | No timeout release, manual force override or invented no-dispatch evidence |
| Remote facts | Immutable version 2 record separates historical closed receipt and current Issue/comment observation | Current state may be open; comment listing is limited, not evidence of absence or authorship |
| Successful reconciliation | Withdraw only old completion intent, advance epoch, clear yield, retain cancel request | Fresh yield and matching local stopped close still required |
| Local stopped close | Produce cancelled, unarchived; require intact operation-accounting evidence | Missing feature tests/delivery differs from missing evidence that original work settled |
| Exact retry | Verify immutable original record and clean only its matching journal | No second public effect or deletion of a newer journal |
| Unbound Issue close | Reject new Issue target without a bound attempt | Unbound local cancellation still supported; no automatic legacy rewrite |

The dispatcher must not infer settlement from a closed Issue. Round 127 rejected
an earlier hypothesis that legacy `closed` journals necessarily came from the
original API response: they can also be written after a read-only query. Both
that historical fact and any saved remote receipt are retained, but neither
replaces missing dispatch provenance.

Compatibility retains version 1 continuation artifacts and their exact replay.
New cancellation evidence is version 2; old hashes are not rewritten. A mixed
old/new writer installation is not validated, and this source change is not a
runtime rollout. Unknown legacy requests need a separately designed recovery
path if their genuine original outcome becomes recoverable.

Round 128 also closed a new-metadata bypass through normal continuation. New
Issue reservations persist `issue_dispatch: journal-v1` in the workflow before
publication; deleting the journal cannot downgrade them to pre-ledger history.
Both normal-continuation creation and verification inspect the immutable
journal snapshot when new dispatch metadata is required or present. A known
unreturned admission cannot become "settled" merely through observed CLOSED.
Genuine historical v1 records without either metadata remain under their old
contract; reading does not inject the new marker or rewrite their hashes.

Verification so far: the three main timing cases and two missing-accounting
cases failed before implementation, then all five passed. Thirteen additional
cases had twelve passes and exposed the legacy-closed loophole; it was fixed
after round 127. Final regression, source fingerprint and independent review
results will be recorded below, without relabeling those historical failures.

### Retry And Missing-Record Boundaries

Round 129 and independent review found three concrete gaps. Four regressions
reproduced them before fixes, then all four passed (29.87 seconds). Expanded
regression subsequently passed as recorded below.

| Case | Behavior | Note |
| --- | --- | --- |
| Public retry loses its journal or dispatch field | Refuse before GitHub reads or writes; retain the original reservation | Never recreate an empty ledger or downgrade a marked closure |
| First preparation crashes before journal publication | Keep pending on retry | Preparation and journal are separate writes; no fabricated no-dispatch proof or force override |
| Original comment response is saved, marker later disappears | Reuse the exact closure/comment-bound response without another POST | Report historical success, not current visibility |
| Marker is visible but original admission has no result | Keep pending | Marker matching does not settle the original invocation |
| Unbound design work loses pause/resume evidence | Reject stopped preparation and finalization | No workspace is invented; the error preserves the missing receipt detail |
| Genuine unmarked legacy replay | Preserve its legacy contract without adding new empty provenance | It does not gain eligibility for the new cancellation route |

Claude supported saved-response reuse and unbound history verification, and
recommended atomically storing the workflow marker and journal. The coordinator
did not adopt that storage expansion: artifact publication does not atomically
commit the Todo index. The conservative interruption gap above is retained and
tested. This is a recovery limitation, not a claim that records cannot be lost.
The disposition is in `round-126.coordinator.md`, including rounds 127-129.

### Increment Verification

2026-09-19, latest implementation and expanded regressions:

| Check | Result | Note |
| --- | --- | --- |
| First full MCP run | 763 passed, 3 failed, 1 Windows skip; 2298.64s | Mixed/pre-final source; not a final all-green run |
| Earlier eight-file run | 146 passed, 4 failed; 647.49s | Stale request-help snapshot plus three Issue test timeouts; history retained |
| Final eight-file regression | 159 passed; 707.33s | Includes all 70 Issue cases, 25 local cases and the corrected request-help snapshot |
| Isolated dependency-change rerun | 2 passed; 15.16s | Original assertions and timeouts unchanged; 39 other cases intentionally filtered out |
| Typecheck and build | Passed | Current implementation; not runtime activation |
| Expanded built CLI/MCP smoke | 24 scenarios passed, exit 0 | Includes observed-open and observed-closed cancellation, using seeded dispatch records and simulated GETs |
| Web API regression | 1 passed | Project lifecycle API; not browser/user acceptance |
| Independent follow-up | Three findings addressed; no actionable residual finding | Source inspection only; four implementation hashes unchanged |
| Script syntax, relative links, tracked diff whitespace | Passed | 13 local links in three documents; no claim of repository-wide content review |

The full run's two dependency cases exceeded their 15-second test limits; one
also encountered `EBUSY` during temporary-directory cleanup. They passed
serially without weakening checks. This does not establish immunity to
resource contention. Its third failure was the newly reproduced unbound
control-history hole using the pre-fix loaded implementation; both preparation
and finalization now pass in the final regression. The earlier affected run's
snapshot mismatch and three timeout cases also pass in that final run.

Machine-readable final test reports:
`.catpaw/discussions/phase3-claude/round-129.regression.json` and
`round-129.dependency-recheck.json` in the same directory. The full historical
run is not silently relabeled as passing. No final full-suite rerun is claimed.

Latest MCP source/script fingerprint, 156 files:
`f979edac5ba2eae5a0126b58373b1c693fdc532c2e2c003e9e089c1cf0af3a62`.
Algorithm: sort repository-relative paths under `packages/mcp/src` and
`packages/mcp/scripts`; hash each path, NUL, raw file bytes, NUL in order.
The expanded smoke script was edited separately while the eight-file regression
ran; its implementation and Vitest inputs did not change during that run.

This increment does not verify native host conversation, source-Skill runtime
activation, real Issue mutation, macOS/Linux or mixed-version deployment.
Historical v1 compatibility is tested, not a migration of personal records.
No commit, push, installation, automatic Todo completion or archival was done.

The built cancellation cases use the public MCP control endpoint, separate CLI
processes for reconciliation/replay/yield/stopped closure, and an unchanged real
fixture file. They assert that reconciliation alone leaves Todo active with
cancel intent, stopped closure yields cancelled without archive, exact replay
does not requery, and final local closure performs no further remote request.
The simulated HTTP layer rejects non-GET requests instead of forwarding them.
This proves the packaged input/behavior path, not a live GitHub mutation.

Commands for the final affected checks:

```text
pnpm --filter contribbot-mcp exec vitest run src/core/tools/linkage/issue-close.test.ts src/core/execution/control.test.ts src/core/execution/closure.test.ts src/core/execution/local.test.ts src/core/execution/workflow.test.ts src/core/execution/request-help.test.ts src/mcp/server.test.ts src/core/storage/todo-workflow.test.ts --maxWorkers=1
pnpm --filter contribbot-mcp exec vitest run src/core/execution/checks.test.ts -t "does not pass when a declared dependency is" --maxWorkers=1
pnpm --filter contribbot-mcp exec tsc --noEmit
pnpm --filter contribbot-mcp build
node packages/mcp/scripts/execution-smoke.mjs
node --test packages/web/server.test.mjs
```

## Prepared Issue Pause

The user confirmed this separate outcome on 2026-09-19 after the open-Issue
pause deadlock was reproduced. A positively settled original close can now be
reconciled under its exact active pause request. This withdraws only the local
completion reservation, retains Issue/comment facts, clears yield and advances
the evidence epoch. It does not make the Todo paused or completed by itself.
The owner yields the actual candidate again, then uses `settle-pause`.
Explicit `continue` resumes the same execution/attempt without redispatching
the original close. A new Issue close needs a new explicit decision and identity.

| Boundary | Behavior | Note |
| --- | --- | --- |
| Zero admissions / returned comment | Allow reconciliation with positive dispatch provenance and actual accounting | Not inferred from absence of a marker |
| Returned close | Preserve the historical closed receipt and current Issue observation separately | A reopened Issue does not erase the earlier result |
| Unknown / missing / legacy provenance | Remain pending | Current CLOSED and report wording cannot settle unknown requests |
| New reconciliation during any stop | Require exact active control and decision | Cannot use unbound continuation to bypass the current pause/cancel decision |
| Historical successful replay | Read unchanged v1/v2/v3 evidence before new-action guards | Does not modify a later pause, cancellation or newer journal |
| Pause record format | New pause-only v3; v1 continuation and v2 cancellation schemas retained | Existing bytes are not rewritten; not mixed-writer rollout proof |
| Missing reconciliation evidence | Refuse settlement and continuation | Not an ordinary feature-test gap |

Claude round 131 reviewed these changes after the user's confirmation. The
primary adopted v3 isolation, exact control binding and receipt preservation.
Independent actor `01a0b580-f4bb-7b91-85db-a441210544b5` found no actionable issue
in a narrow source review and executed memory-only probes of timing, replay,
supersession, partial persistence, unknown provenance and historical versions.
It used storage, artifacts, locks, candidate and GitHub doubles; its readiness
adapter ran the actual accounting validators but not the full verifier.
It did not prove disk durability, packaged input handling or live GitHub behavior.
The four reviewed implementation hashes matched before/after and in the
primary's subsequent readback. No-write was requested and audited, not an OS
sandbox guarantee. Full details are in `round-131.coordinator.md`.

Four initial regressions failed for the intended defects, then passed after
implementation. Typecheck and build passed. Two actual-handler built checks
also passed: the same zero-admission and returned-comment cases reproduced in
round 130 now reconcile, yield, settle pause, continue and reject redispatch.
Their dispatch journals are created by the actual handler, not hand-seeded.
All HTTP is simulated and temporary Git/data roots are removed after checking.
The report is `.catpaw/discussions/phase3-claude/round-131.pause-smoke.json`.

The complete built CLI/MCP smoke passed all 26 scenarios; its four Issue stop
cases use simulated returned-response journals and separate CLI processes,
including pause with readback OPEN and CLOSED. The two actual-handler tests
above separately cover real journal construction before close dispatch.
The Web API regression also passed.

### Final Pause Verification

| Check | Result | Note |
| --- | --- | --- |
| Initial RED / focused GREEN | Four intended failures, then four passes | Missing route and missing exact pause binding both reproduced |
| Expanded source regression | 11 files, 222 tests passed; 985.09s | Includes all 90 Issue cases and ordinary control, coverage, closure, MCP and lifecycle regressions |
| Packaged CLI/MCP smoke | 26 scenarios passed, exit 0 | Simulated GitHub, scripted host/user, isolated data |
| Actual-handler packaged probe | Two scenarios passed, exit 0 | Original zero-admission and returned-comment defects; journals produced by the actual handler |
| Typecheck / build / Web API | Passed / passed / one test passed | Build only, not runtime activation |
| Independent review | No actionable finding; bounded memory probes passed | Limits and hashes above remain applicable |
| Hygiene | 22 relative links, six edited source/script whitespace checks, configured `git diff --check` passed | Git emits existing LF/CRLF conversion warnings; untracked files checked separately |

The final source regression report is
`.catpaw/discussions/phase3-claude/round-131.regression.json`.
Its SHA-256 is `cf02ad5b54d7121273cf17a69879460e5c036998dc4b789ca5f5f7c823721acd`.
The 156 source/script files remained at
`32eedae3eef67ae63d3031c01276216b84660f1e2423c21d6a105c65cb8cbd22`
before and after the expanded regression, using the path/NUL/raw-bytes/NUL
algorithm described above. No test assertions or timeouts were weakened.

The pre-change frozen full suite passed 777 tests with one Windows skip in
58 files (2198.48 seconds); it does not cover this subsequent increment.
At that checkpoint there was no new complete 58-file run after the pause implementation.
Native-host acceptance, live GitHub mutation, macOS/Linux and mixed-version
runtime deployment remain unverified. No migration, installation, commit,
push or automatic Todo completion/archive occurred.

```text
pnpm --filter contribbot-mcp exec vitest run src/core/tools/linkage/issue-close.test.ts src/core/execution/control.test.ts src/core/execution/workflow.test.ts src/core/execution/local.test.ts src/core/execution/closure.test.ts src/core/execution/request-help.test.ts src/mcp/workflow.test.ts src/mcp/server.test.ts src/core/storage/todo-workflow.test.ts src/core/storage/todo-projection.test.ts src/core/tools/core/todo-lifecycle.test.ts --maxWorkers=1
node packages/mcp/scripts/execution-smoke.mjs
node .catpaw/discussions/phase3-claude/round-131.pause-smoke.mjs
```

### Subsequent Full Regression

2026-09-19: the unchanged post-pause source now has a complete MCP rerun:
58 files passed, **798 tests passed, one Windows skip**, 1135.33 seconds,
exit 0. The skipped case concerns unstaged executable-bit capture. No assertion,
timeout or source file changed during the run. The same 156-file fingerprint
above was checked before and after. The earlier 777-pass baseline remains
historical and is not relabelled.

Report: `.catpaw/discussions/phase3-claude/round-133.full-regression.json`,
SHA-256 `44c4c8ce193c6153bab04fb83d661c660bc1e5b20a1571cc7c89e6960c67ec78`.
Command and independent C/D requirement audit limits are recorded in the
[current completion audit](todo-cbd-audit.md#current-source-full-regression).
This does not authorize legacy-state changes, real data conversion or deployment.
