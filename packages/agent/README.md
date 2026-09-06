# contribbot-agent

The Phase 3 patrol runtime for contribbot.

```bash
uv sync --project packages/agent
uv run --project packages/agent contribbot patrol darkingtail/contribbot
```

The first patrol implementation:

1. reads repository state through `contribbot-mcp`;
2. asks Codex for a structured assessment and action plan;
3. saves the report, source snapshot, analysis, and trace locally;
4. optionally creates reviewable knowledge proposals after confirmation;
5. never performs public GitHub writes.

A report-only Run can later resume its pending actions without repeating the
observation and model-analysis stages:

```bash
uv run --project packages/agent contribbot patrol owner/repo --resume RUN_ID
```

Use `--backend rules` for an offline collection smoke test. It gathers and
records the same repository snapshot without model-backed judgment.

## Phase 3 commands

Run all locally tracked repositories from any directory:

```bash
uv run --project packages/agent contribbot patrol-all --backend rules --max-investigation-rounds 0
```

Create a scheduler configuration without touching the default path:

```bash
uv run --project packages/agent contribbot init-config --config .contribbot-agent.json
uv run --project packages/agent contribbot patrol-schedule --once --config .contribbot-agent.json
```

The scheduler defaults to `report_only`; configure `repos` explicitly for a
repeatable unattended run. A scheduled run records one auditable Run per
repository and isolates failures between repositories. It produces no output
when nothing needs attention; pass `--show-unchanged` for a full batch report.

Each recorded run includes `snapshot.json`, `analysis.json`, `trace.json`,
`run.json`, `actions.json`, and the human-readable `report.md`.

## Controlled remediation

The remediation command is the first worktree-based executor:

```bash
uv run --project packages/agent contribbot remediate C:/src/my-repo \
  --prompt "Fix the failing test and add coverage." \
  --validate "pnpm test"
```

It requires a clean repository root, creates a separate worktree and branch,
lets Codex edit only that worktree, checks changed paths, runs validation, and
writes `result.json`, `changes.patch`, and `VERIFICATION.txt` under
`~/.contribbot/remediation/{run-id}/`. It intentionally does not commit, push,
change remotes, or create a pull request.
