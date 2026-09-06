from __future__ import annotations

from .models import ActionExecution, PatrolAnalysis, PatrolRun, PatrolSnapshot


def _cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\r", "").replace("\n", "<br>")


def render_report(run: PatrolRun, snapshot: PatrolSnapshot, analysis: PatrolAnalysis, proposal_results: list[str], actions: dict[str, ActionExecution] | None = None) -> str:
    actions = actions or {}
    lines = [
        "# Patrol Report", "",
        f"> Repo: `{snapshot.repo}` | Run: `{run.id}` | Status: `{run.status}` | Health: `{analysis.health}`", "",
        "## Summary", "", analysis.summary, "",
        "## Run", "",
        "| Status | Coverage | Investigation Rounds | Started | Completed | Note |",
        "| --- | --- | --- | --- | --- | --- |",
        f"| {run.status} | {'complete' if run.coverage_complete else 'partial'} | {run.investigation_rounds} | {run.started_at} | {run.completed_at or '—'} | Auditable run state |", "",
        "## Findings", "",
    ]
    if analysis.findings:
        lines += ["| Severity | Finding | Evidence | Impact | Note |", "| --- | --- | --- | --- | --- |"]
        for finding in analysis.findings:
            lines.append(f"| {finding.severity} | {_cell(finding.title)} | {_cell(finding.evidence)} | {_cell(finding.impact)} | Review before acting |")
    else:
        lines.append("_No actionable findings._")

    lines += ["", "## Recommended Actions", ""]
    if analysis.actions:
        lines += ["| ID | Kind | Safety | Status | Action | Reason | Suggested Command | Result |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
        for action in analysis.actions:
            execution = actions.get(action.title)
            lines.append(f"| {execution.id if execution else '—'} | {action.kind} | {action.safety} | {execution.status if execution else 'proposed'} | {_cell(action.title)} | {_cell(action.reason)} | {_cell(action.suggested_command)} | {_cell((execution.result or execution.error) if execution else '') or '—'} |")
    else:
        lines.append("_No follow-up actions proposed._")

    lines += ["", "## Knowledge", ""]
    if analysis.knowledge_used:
        lines += [
            "**Knowledge used in this decision:** " + ", ".join(f"`{name}`" for name in analysis.knowledge_used),
            "",
        ]
    if analysis.knowledge_candidates:
        lines += ["| Target | Action | Candidate | Status | Note |", "| --- | --- | --- | --- | --- |"]
        for index, candidate in enumerate(analysis.knowledge_candidates):
            status = "proposal created" if index < len(proposal_results) else "awaiting approval"
            lines.append(f"| `{candidate.target}` | {candidate.action} | {_cell(candidate.title)} | {status} | Canonical knowledge unchanged |")
    else:
        lines.append("_No durable repository knowledge identified in this run._")

    lines += ["", "## Observation Coverage", "", "| Source | Status | Note |", "| --- | --- | --- |"]
    for observation in snapshot.observations:
        note = observation.error if not observation.ok else "Included in analysis snapshot"
        lines.append(f"| `{observation.name}` | {'ok' if observation.ok else 'failed'} | {_cell(note)} |")
    lines.append(f"| `knowledge resources` | ok | {len(snapshot.knowledge)} entries included |")
    lines += ["", "## Safety Boundary", "", "Public GitHub writes and destructive Git operations require an explicit future approval path.", ""]
    return "\n".join(lines)
