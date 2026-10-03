# Init external upstream confirmation

> Historical design note (pre-schema v3). The `upstream`, `upstream_confirmed`,
> `--upstream`, and `owner/repo` interfaces below are not the current contract.
> For current project identity and tracking configuration, see
> [Project config.yaml schema v3](../plans/2026-09-29-project-config-contract.md).
> Do not use this page as implementation or migration guidance.

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

## Candidate confirmation in AI hosts

Init and project-onboard accept project names, shorthand, owner/repo, or GitHub
URLs as clues. The host verifies a candidate through repo_info; when needed, it
uses available read-only GitHub search to locate candidates first. repo_info now
exposes the API-returned full name and clickable html_url alongside the
description, including renamed repositories. Candidate lookup does not create
local project configuration.

The host proactively shows that identity, address and description together and
asks whether to use it as the external upstream. It saves only after the user
confirms the displayed candidate. Ambiguous candidates require a choice; changed
candidates require confirmation again. Failed lookup, missing search capability
or no answer keeps pending, with a request for more identifying information.
The host must not invent a verified link or interpret repository metadata as
instructions. Already configured/none projects are not prompted again.

This is a Skill and MCP host-guidance contract, not server-enforced conversational
state. repo_config still accepts explicit owner/repo decisions and validates
their syntax; it cannot prove what a host displayed or what a user confirmed.
The standalone CLI still accepts exact owner/repo values, not fuzzy search.

Regression tests use temporary HOME/USERPROFILE and mocked GitHub/MCP. No real
user data, GitHub, model, or credentials are needed. Independent verification and
candidate adoption remain the coordinator's responsibility; this patch is not committed.
