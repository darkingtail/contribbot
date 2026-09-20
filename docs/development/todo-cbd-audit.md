# C/B/D Completion Audit

Date: 2026-09-19. Status: **C/B/D and six-state source implementation complete;
local verification passed**. This is not user acceptance, completion of the
tracking Todo, or permission to install, migrate, commit or push.

Latest decision: the user explicitly said "不用兼容，不用管老的".
The source change now removes the two old Todo states without read/write
compatibility or migration. Implementation and final verification are recorded
in [Todo six-state convergence](todo-six-state.md). This supersedes the pending
compatibility proposal below; historical test reports remain historical.
No runtime activation or personal-data deletion/conversion is authorized.

Final verification checkpoint: round-142 passed all 63 MCP files, **902 tests
passed, zero failed, one Windows-specific skip**. All 167 source/script/config
manifest entries still match the tested candidate. The final eight-file affected
regression passed 210 tests; built CLI/MCP smoke passed 28 scenarios, and six
additional built-handler/separate-CLI scenarios passed. Typecheck, build and
the two Web API tests passed. Final independent review found no remaining
actionable issue in its scoped recovery changes and guard dependencies.

The current-source requirement audit checked C's confirmed coverage and closure
gates, B's dispatch/settlement/resumption and original-result protection, D's
delivery validation and independent PR observations, and six-state inputs,
storage and consumers. The earlier two plain Issue recovery defects are fixed:
failed-read facts, exact live-retry ownership and zero-admission recovery now
retain unknown-write protection. No implementation blocker remains within this
scope. Native-host user acceptance and untested environments remain separate.

Goal: implement C (stage/task coverage and completion gates), B (pause request,
safe settlement, cancellation, continuation and stale evidence), D (plan-owned
deliverables and independent PR progress), then retire legacy Todo states
without compatibility, as subsequently directed by the user.

The previous increment implemented and verified B's explicitly approved prepared
Issue cancellation path. This audit then found a separate pause path missing.
The user approved its outcome; that incremental implementation and its expanded
local regression have now passed. Neither source work nor this audit authorizes
deployment. A subsequent frozen full MCP rerun on the current source passed
58 files, 798 tests, with one Windows-specific skip. That result predates the
current six-state change and does not validate it.

## Requirements And Evidence

| Requirement | Current evidence | Conclusion | Note |
| --- | --- | --- | --- |
| C: exact stage/task declaration | `workflow.ts` validates new proposals and includes declarations in the plan digest; `workflow.test.ts`, `closure.test.ts`, MCP workflow tests | Implemented; local verification recorded | Stage checks do not satisfy whole-task completion |
| C: do not rewrite old plans or completed outcomes | Historical coverage and closure replay regressions in `closure.test.ts` and `issue-close.test.ts` | Implemented; local verification recorded | Missing legacy coverage is not implicit whole-task approval |
| B: record stop before blocking new work | `assertControlAllows`, `assertDispatchAllowed`, `request_control`; PR/claim/check replay tests | Implemented; local verification recorded | A returned response may still be recorded after the stop request |
| B: settle pause and explicitly continue | `control.ts`, `local.test.ts`, built CLI/MCP smoke | Implemented for ordinary bound/unbound paths | Continue retains the execution, advances the epoch and requires fresh evidence |
| B: known-settled prepared Issue cancellation | Control-bound v2 reconciliation, dispatch journals and local stopped closure; 70 Issue regressions and two built smoke cases | Implemented for the approved rule | No Issue reopen, automatic done or archive; current state and historical results are separate |
| B: known-settled prepared Issue pause | Four RED-to-GREEN tests; final 222-test regression, 26 packaged scenarios, two actual-handler probes and independent memory review | Implemented; local verification passed | Separate v3 pause record; fresh yield/settlement and explicit continuation without redispatch |
| B: uncertain original operations | Journal/admission, real process and reconciliation tests | Deliberately remains pending | Missing evidence, timeouts or current Issue state do not prove the original operation ended |
| B: plain Issue call receives stop | Locked settlement gates; original-call and exact-retry accounting; failed GET and zero-admission regressions; final full run and six built-handler probes | Implemented; final scoped review and local regression passed | Unknown write results still block; no automatic Todo outcome or Issue reopen |
| D: plan-owned delivery model | `contracts.ts`, `verification.ts`, deliverables tests | Implemented | File/workspace, explicit local commit, remote branch and submitted/merged PR targets |
| D: required endpoint cannot be waived | Readiness plus closure gates, delivery and Issue completion regressions | Implemented | Verification gaps differ from missing required delivery |
| D: PR progress independent of lifecycle | `todo-pulls.ts`, `todo-pr-progress.ts`, linking/detail tests | Implemented | Display observations and ordinary associations do not auto-complete or cancel Todo |
| D: reported merge is not verified delivery | `remote-delivery.ts`, remote tests and documented real `gh` readbacks | Implemented within recorded scope | Fresh query/content checks required; no cache or self-reported merge substitutes for them |
| Retire Todo `pr_submitted` / `not_planned` after D | Six-state source change, explicit plain cancellation, current-operation guards and updated consumers; source search and final full run | Implemented; local verification passed | Breaking change approved; upstream enum retained; no live conversion, old-state readers or migration |

Implementation sources above are under `packages/mcp/src/core`; links to full
records: [coverage](todo-plan-coverage.md), [control](todo-control.md),
[delivery](todo-delivery.md), and the [lifecycle design](../plans/2026-09-18-todo-lifecycle-delivery-design.md).

## Confirmed Pause Decision

Concrete scenario: an authorized linked close was prepared; the user requests
pause before closing the Issue; positive dispatch records show no outstanding
request; Issue remains open. In the original implementation the pause fence
correctly prevented dispatch, but all settlement/recovery routes rejected while
`closing_id` remained. That availability gap is now fixed without bypassing
unknown-operation safety.

The proposed behavior is to account for the original invocation, withdraw only
the local completion reservation, retain the pause request and remote facts,
then freshly yield and settle pause. Continuing the Todo would not silently
redispatch the old Issue close; a new close decision would be required.
The user **confirmed this product rule** on 2026-09-19 with "可以".
The pre-change frozen suite then finished with 777 passes and one Windows skip.
Four new regressions reproduced the missing behavior before the implementation;
all four pass after adding the pause route. The final expanded 11-file
regression passed all 222 tests.

Claude round 130 supports that direction. The primary accepts the identified
gap but has not adopted every technical suggestion: historical close receipts
must not be erased; the immutable-record version strategy was not finalized
in that round. Round 131 subsequently reviewed the
approved rule: the primary adopts a separate pause-only v3 record, preserving
v1 continuation and v2 cancellation schemas and bytes. Both versions retain
historical close facts. New reconciliation under an active pause requires its
exact control and decision; completed historical replay remains readable.
Consultations and actual probes are in
`.catpaw/discussions/phase3-claude/round-130.*` and `round-131.*`.

## Historical Legacy State Proposal (Superseded)

The remainder of this section records the investigation and proposal **before**
the user's no-compatibility decision. It is not the current implementation or
an outstanding decision request. The old compatibility proposal was not adopted;
do not reintroduce migration or historical-state support as a completion gate.

Deleting enum strings is not the migration. The current code still uses them
in public inputs, storage, generated documents, statistics and interrupted
request recovery. `UpstreamItemStatus.pr_submitted` is a separate domain and
must not be changed as part of Todo state retirement.

| Decision or prerequisite | Why it remains necessary | Note |
| --- | --- | --- |
| New-input retirement versus historical reading | A caller should stop creating legacy state without making old tasks unreadable | Candidate direction only; no public schema restriction applied |
| Recover exact old stop/archive operations | `todo_update(status=not_planned)` currently restores some original interrupted intents | Removing the enum from input first would make that recovery unreachable |
| Replacement for new unmanaged/legacy stopping | Existing new-stop path still produces `not_planned`; an unstarted idea has no execution for `todo_control` | Do not create fictional work just to cancel it |
| New managed stopped reservations | A new `stopped` closure without cancel control still produces `not_planned` | Restricting `todo_update` alone does not retire new legacy writes |
| Historical status interpretation | `pr_submitted` alone does not prove readiness or completion; `not_planned` alone does not establish whether an investigation succeeded or a target was abandoned | No inferred bulk conversion to done/active/cancelled |
| Writer isolation and exact conversion preview | An earlier actual legacy-writer probe ignored a format marker and changed new state | Backups alone do not prevent another writer corrupting converted data |
| User approval for specific rollout/conversion | Source build, D validation and broad development approval do not select projects or migration choices | No live data conversion or runtime switch occurred |

This audit does not replace the original goal with “keep compatibility forever.”
Retirement remains unfinished pending its policy and safe implementation.
Automatic completion and a new task scheduler remain separately recorded
future ideas, not requirements silently added to C/B/D.

### Retirement Investigation: 2026-09-19

Claude rounds 132 and 133 succeeded in the existing session. The primary read
the source and ran six isolated source-handler characterizations. These are
observations of the current implementation, not tests of an implemented
retirement policy. Business source, installed runtime and personal data were
not changed.

| Observed route | Actual result | Note |
| --- | --- | --- |
| New `todo_update(status=pr_submitted)` | Still writes the old status | PR association itself no longer changes lifecycle |
| New unmanaged `todo_update(status=not_planned)` | Ends the execution, writes `not_planned`, leaves it unarchived | Needs a replacement before removing this new-operation route |
| Cancel an idea without an execution | Generic `cancelled` update and execution-bound control cannot do it directly | Both reject without altering Todo bytes; no execution is invented |
| New managed `stopped`, without cancel control | Writes `not_planned`; exact completion replay preserves bytes | New reservations and original historical recovery must be distinguished |
| Managed control-bound cancellation | Writes `cancelled`, leaves it unarchived | Reuse B rather than replacing its safety checks |
| Interrupted historical abandoned close/archive | Conflicting metadata rejected; exact retry removes the active duplicate, preserving original archive bytes | Probe actually caused archive success followed by active-file write failure |

Reproduction:
`pnpm --dir packages/mcp exec tsx ../../.catpaw/discussions/phase3-claude/round-132.legacy-probe.mjs`.
The report is `.catpaw/discussions/phase3-claude/round-132.legacy-probe.json`.
All six characterization assertions passed; zero network calls occurred and
the isolated temporary root was removed. The before/after 156-file source
fingerprint remains `32eedae3eef67ae63d3031c01276216b84660f1e2423c21d6a105c65cb8cbd22`.
The probe uses actual TypeScript handlers and filesystem storage, not the MCP
wire protocol; it does not prove migration, cross-platform or user acceptance.

### Proposed First Retirement Increment

This proposal awaits the user's confirmation of the compatibility boundary.
The six-state product direction is already confirmed and is not being reopened.
The remaining choice is whether to reject **new** legacy-status calls now,
while preserving old records and positively identified original recovery.
Existing callers that still send a new `not_planned` or `pr_submitted` update
will need the replacement action; this is a behavioral change, not just renaming.

| Surface | Proposed behavior | Note |
| --- | --- | --- |
| New ordinary status updates | Only `idea`, `backlog`, `active`; completion, pause and cancellation use dedicated gated actions | Do not permit generic writes of `done`, `paused` or `cancelled` |
| `pr_submitted` | Stop accepting new writes; preserve historical reading/filtering and independent PR progress | Do not change `UpstreamItemStatus.pr_submitted` |
| Unstarted/unmanaged cancellation | Explicit identity, snapshot and decision; check remote effects and relevant history before ending locally | An unstarted idea remains without an invented execution; existing execution/history must be preserved and correctly ended |
| New managed `stopped` reservation | Require the matching explicit cancel control and safe local settlement | Existing original reserved/prepared/completed identities retain their exact recovery behavior |
| `not_planned` transport compatibility | Retain a deprecated value solely for exact historical recovery or unchanged completed-result readback | Validate before metadata/note writes; reject new stops, changed requests and reopened-task reuse |
| Historical records | Keep original status and history visible; keep explicit restore/reopen usable | No conversion-on-read, inferred done/cancelled, or permanent freeze |
| Source versus rollout | Implement/test against isolated data first | No installed-runtime switch or personal-data conversion is authorized by this proposal |

A single "has legacy status or pending marker" predicate is insufficient.
Completed history allows unchanged result readback, not another close or note
write. An incomplete two-file operation needs matching identity, original intent
and content evidence; the marker itself is not permission to archive.
Managed reservations use their original execution/closure identity and exact
intent. A reopened task uses the new lifecycle path, not historical stop replay.

MCP validation occurs before handlers. Therefore the transitional transport
schema must still admit the deprecated recovery value even though the normal
new-status set excludes it. This increment does **not** claim full physical
enum deletion. Removing that transport value requires a working replacement
recovery entry point, verified across interrupted and completed history, and a
documented caller transition. Removing historical read support also requires
an approved conversion policy and verified handling of remaining old records.

Before adding unmanaged `cancelled`, generalize the linked Issue terminal guard:
`issue-close.ts` currently explicitly handles `done/not_planned`, with managed
history blocked earlier. New cancellation must not let a linked Issue operation
dispatch remote work and only later fail local completion. This is a required
dependency of the proposed new route, not a reproduced bug in a currently
supported unmanaged-cancellation path.

Implementation must update the storage guards, MCP schema/handler descriptions,
CLI recovery messages, Skills, generated records, Todo lists, project summaries,
Web counts and tool reference together. Check exported direct library writers
as well as MCP calls. Python source/tests contain no literal dependency on the
two Todo strings in this audit; that search is not a behavioral integration test.

Verification must cover new-write rejection before any mutation; unstarted,
unmanaged and managed cancellation; stale snapshots and retries after reopening;
unknown effects retaining protection; Issue guards before dispatch; exact old
two-file and reserved/prepared/finished recovery; preserved read bytes; filters
and consumer counts; unchanged upstream enum behavior; and built MCP/CLI paths.
Run relevant regression and independent checks on the resulting candidate.
Writer isolation and exact conversion preview remain prerequisites for a later
separately approved rollout, not problems solved by a format marker or backup.

Claude agreed with the separation and, after correction in round 133, withdrew
the overly broad replay predicate and the "reclassify or freeze forever" choice.
The primary does not adopt hiding recovery guidance or presenting two old values
as normal new-state options. Recovery should remain discoverable and explicitly
labelled. Consultation is design input, not independent implementation proof.
Detailed dispositions: `.catpaw/discussions/phase3-claude/round-133.coordinator.md`.

## Verification Snapshot

Pre-pause MCP source and scripts remained at 156 files with SHA-256
`f979edac5ba2eae5a0126b58373b1c693fdc532c2e2c003e9e089c1cf0af3a62`.
Algorithm: sorted repository-relative path, NUL, raw bytes, NUL.

That frozen full rerun passed: 58 files, 777 tests passed, one Windows skip,
2198.48 seconds. The fingerprint was checked again before adding pause tests.
The report is `.catpaw/discussions/phase3-claude/round-130.full-regression.json`.
This is a pre-pause baseline, not verification of the later implementation.
The preceding 159 affected tests, two dependency reruns and 24 packaged scenarios
also remain historical evidence with the control record's limitations.

The pause increment initially has four RED-to-GREEN tests, passing typecheck
and build, and independent memory-only review without actionable findings.
The two actual-handler packaged reproductions and the complete 26-scenario
built CLI/MCP smoke have now passed, along with the Web API regression.
The final 11-file regression passed 222 tests in 985.09 seconds, including
90 Issue cases. Its report is
`.catpaw/discussions/phase3-claude/round-131.regression.json`.
The final 156-file source/script fingerprint is
`32eedae3eef67ae63d3031c01276216b84660f1e2423c21d6a105c65cb8cbd22`,
checked before and after the expanded run. All required processes returned;
at that checkpoint no current-source complete 58-file rerun was claimed. The earlier 777-test
baseline is deliberately distinguished from this affected-surface verification.
No source edits occurred during either respective run.

### Historical Post-Pause Full Regression

On 2026-09-19, the same source/script fingerprint was verified immediately before
and after the complete MCP suite. The run exited 0: **58 files passed, 798 tests
passed, one skipped**, 1135.33 seconds. The skipped assertion is
`candidate capture against real Git repositories captures unstaged executable bit changes`,
which is disabled on Windows. The JSON report has no failed files or assertions.
Report: `.catpaw/discussions/phase3-claude/round-133.full-regression.json`;
SHA-256: `44c4c8ce193c6153bab04fb83d661c660bc1e5b20a1571cc7c89e6960c67ec78`.

```text
pnpm --dir packages/mcp exec vitest run --reporter=default --reporter=json --outputFile=../../.catpaw/discussions/phase3-claude/round-133.full-regression.json
```

This closes the post-pause full-MCP regression gap, not the legacy-retirement,
rollout or native-host acceptance gaps. The 26 packaged scenarios, two actual
handler probes and typecheck/build results remain separate earlier evidence on
the unchanged source, not commands rerun during this full-suite increment.

A separate actor also audited C/D's requirement-to-assertion mapping by source
reading, with no actionable finding in that scope. The primary checked the
cited assertion bodies and reproduced its 12-file hash aggregate. No tests or
network were run by that actor, so this is not an additional behavioral pass.
The scope, hashes and primary disposition are recorded in
`.catpaw/discussions/phase3-claude/round-133.coordinator.md`.
No source implementation changes, test weakening or new design decisions were
made while awaiting the user's retirement confirmation.

Native-host user acceptance, real Issue mutation, macOS/Linux and live
mixed-version conversion are not claimed. No commit, push, automatic Todo
completion/archive or migration is part of this audit.

## Final Current-Source Verification

The round-142 full report covers the final source, including all sixteen last
recovery regressions. It started at `2026-09-19T10:03:08.996Z`; its last test file
ended at `2026-09-19T10:19:59.792Z`. Parsed report: success, 63 files,
902 passed, zero failed, one skipped. No matching Vitest or smoke process
remained when the completed report was checked after context restoration.
The original exec session was no longer addressable, so its exit status was not
re-observed; the persisted full report, not the missing session, supplies this
pass result.

| Evidence | Final result | Note |
| --- | --- | --- |
| Full MCP suite | 902 passed, 1 Windows skip | `round-142.full-regression.json`; all 63 files passed |
| Affected-surface regression | 210 passed, 8 files | `round-142.regression.json`; separate run, not additional tests to add to the full count |
| Built CLI/MCP smoke | 28 scenarios passed | Isolated Git/data fixtures and simulated GitHub; no runtime activation |
| Plain Issue recovery probes | 6 scenarios passed | `round-142.plain-smoke.json`; pause/cancel crossed with failed GET, late zero-admission recovery and exact retry |
| Typecheck, build, Web API | Passed; 2 Web API tests | Previously completed on the unchanged source; not browser or deployment acceptance |
| Independent scoped review | No remaining actionable finding; 36 in-memory probes passed | Actor `01a0b8a4-9c74-76d1-824f-391a7478ed34`; mocked dependencies, not OS concurrency verification |
| Candidate freshness | 167/167 entries unchanged | Manifest includes source, scripts and configuration; docs and personal data are not part of this fingerprint |

Candidate: `.catpaw/discussions/phase3-claude/round-142.final-candidate.json`.
Aggregate SHA-256 of compact JSON of sorted `{path, sha256}` entries:
`1d3c706de41f250a3bd7fd541e66f05de626710d21ffd248a6947f72f3c71dbd`.
Full-report SHA-256:
`7ce7d76e009d90ff9a609ff743ac75c7a1459571c29f622e0ae3d15a7183190b`.
The skipped assertion is the real-Git unstaged executable-bit case, disabled on
Windows. Earlier failures and older green snapshots remain historical records.

Real GitHub read-only checks from D remain evidence only for their documented
targets and files. Live GitHub writes, native-host long-conversation acceptance,
macOS/Linux execution and a Windows-5.1-only full timing run were not verified.
Unknown original effects deliberately keep their safety fence; this is not a
promise of forced recovery without evidence. Compatibility/migration is excluded,
not an unfinished prerequisite. Automatic completion and scheduling remain
separate future work.

The tracking Todo remains active at Check, with no automatic completion or
archive. The preexisting five CatPaw board errors are not repaired or bypassed
by this audit. Next is user acceptance of this implementation and, under a
separate explicit decision, runtime activation or source submission.
