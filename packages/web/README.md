# contribbot Web UI

Local control room for tracked repositories and Phase 3 patrol reports.

```bash
pnpm web
```

Open <http://127.0.0.1:4173>.

The server reads the existing data under `~/.contribbot/{owner}/{repo}` and is
report-only. It does not modify GitHub, Todo files, or knowledge entries.
