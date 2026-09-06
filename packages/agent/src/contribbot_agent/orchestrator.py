from __future__ import annotations

import re
from collections.abc import Callable

from .backend import Analyzer
from .mcp_client import ContribbotMcpClient
from .models import PatrolBatchResult, PatrolResult, utc_now
from .patrol import PatrolRunner


def parse_project_list(markdown: str) -> list[str]:
    projects: list[str] = []
    for line in markdown.splitlines():
        if not line.startswith("|") or "---" in line or "Project" in line:
            continue
        first = line.strip("|").split("|", 1)[0].strip().strip("`")
        if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", first):
            projects.append(first)
    return projects


async def tracked_projects() -> list[str]:
    async with ContribbotMcpClient() as mcp:
        return parse_project_list(await mcp.call_tool("project_list", {}))


class PatrolAllRunner:
    def __init__(self, analyzer_factory: Callable[[], Analyzer], max_investigation_rounds: int = 3) -> None:
        self.analyzer_factory = analyzer_factory
        self.max_investigation_rounds = max_investigation_rounds

    async def run(self, repos: list[str] | None = None) -> PatrolBatchResult:
        projects = repos or await tracked_projects()
        results: list[PatrolResult] = []
        failures: dict[str, str] = {}
        for repo in projects:
            try:
                result = await PatrolRunner(
                    ContribbotMcpClient(), self.analyzer_factory(), self.max_investigation_rounds
                ).run(repo)
                results.append(result)
            except Exception as error:
                failures[repo] = str(error)
        return PatrolBatchResult(
            projects=projects,
            results=results,
            failures=failures,
            completed_at=utc_now(),
        )


def render_batch(result: PatrolBatchResult) -> str:
    lines = [
        "# Cross-project Patrol", "",
        f"> {len(result.projects)} projects · {len(result.results)} completed · {len(result.failures)} failed", "",
        "| Project | Run | Status | Health | Findings | Actions | Note |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for item in result.results:
        lines.append(f"| {item.run.repo} | `{item.run.id}` | {item.run.status} | {item.analysis.health} | {len(item.analysis.findings)} | {len(item.analysis.actions)} | report recorded |")
    for repo, error in result.failures.items():
        lines.append(f"| {repo} | — | failed | unknown | — | — | {error.replace('|', '\\|')} |")
    return "\n".join(lines)


def batch_needs_attention(result: PatrolBatchResult) -> bool:
    if result.failures:
        return True
    return any(
        item.run.status in {"partial", "failed"}
        or item.analysis.health in {"attention", "critical"}
        or bool(item.analysis.findings)
        or bool(item.analysis.actions)
        for item in result.results
    )
