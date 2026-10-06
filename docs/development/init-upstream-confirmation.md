# Init external upstream confirmation

Initialization does not infer an external upstream from a repository name or fork parent.

| Stored configuration | Derived status | Note |
| --- | --- | --- |
| Nonempty upstream (including legacy configs) | configured | No repeated prompt; no migration needed |
| Null/missing upstream, upstream_confirmed: true | none | User explicitly chose no external upstream |
| Null/missing upstream without a true marker | pending | Ask; reading never silently confirms none |

Only explicit repo_config(upstream="owner/repo") or repo_config(upstream="") sets
upstream_confirmed: true. Other fields, including archive state and unknown keys,
are retained. Existing config reads do not rewrite bytes. New config discovery is
unchanged: it can read GitHub and create local configuration, but cannot determine
an external upstream decision. Fork and canonical names use the existing resolver
and the same canonical config.

MCP repo_config and project_init emit an exact machine-readable line:
<!-- contribbot:upstream-status=pending -->
The value is pending, configured, or none. This text marker is the CLI contract;
human prose is not parsed for status. Hosts should ask only when pending. A host
must persist an explicit no, not just skip the question.

CLI: contribbot init [repo] [--path PATH] [--upstream OWNER/REPO | --no-upstream] [--no-input]

On a TTY, pending initialization requests owner/repo or n/no; an empty answer,
EOF, or interrupted prompt leaves pending. Non-TTY and --no-input never prompt.
Explicit options also work noninteractively and are mutually exclusive. Invalid
explicit choices fail before opening MCP. Invalid interactive input cannot save
a decision. Existing two-positional-argument initialize_context calls remain valid.
After saving a choice the CLI rereads project_init. Older MCP servers without the
marker produce a status-unavailable notice rather than an inferred confirmation;
upgrade MCP for the full contract. No lifecycle restore, patrol, public write, or
tracking fetch is authorized by this confirmation.

Regression tests use temporary HOME/USERPROFILE and mocked GitHub/MCP. No real
user data, GitHub, model, or credentials are needed. Independent verification and
candidate adoption remain the coordinator's responsibility; this patch is not committed.
