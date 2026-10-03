# contribbot Web UI

Local control room for tracked repositories and Phase 3 patrol reports.

```bash
pnpm web
```

Open <http://127.0.0.1:4173>.

The server uses Core's shared read-only loader for schema-v3 projects under
`~/.contribbot/projects/v1/<repository-digest>/`. Full repository identities are
displayed; project selection and refresh use the digest. The default view lists
active projects, with archived/all filters available.

Unreadable configs and Todo files produce diagnostics, not invented zero counts.
Patrol reports remain available. The server is report-only: it does not initialize
projects, migrate old directories, or modify GitHub, Todo files or knowledge.
