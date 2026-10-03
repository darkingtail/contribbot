from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .backend import Analyzer
from .mcp_client import ContribbotMcpClient
from .models import ProjectDiscovery, ProjectProblem, PatrolBatchResult, PatrolResult, utc_now
from .patrol import ArchivedProjectError, PatrolRunner
from .repository import RepositoryLike, RepositoryRef, parse_repository, parse_repository_ref


def parse_project_discovery(value: Any) -> ProjectDiscovery:
    if not isinstance(value, dict):
        raise ValueError("project_list structuredContent must be an object.")
    if type(value.get("schema_version")) is not int or value["schema_version"] != 1:
        raise ValueError("project_list requires structuredContent schema_version 1.")
    if value.get("filter") != "active":
        raise ValueError("project_list must return the requested active projects filter.")
    entries = value.get("projects")
    if not isinstance(entries, list):
        raise ValueError("project_list structuredContent has no projects array.")
    problem_entries = value.get("problems")
    if not isinstance(problem_entries, list):
        raise ValueError("project_list structuredContent has no problems array.")

    projects: list[RepositoryRef] = []
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or "repository" not in entry:
            raise ValueError("project_list structuredContent contains an invalid project entry.")
        repository = parse_repository_ref(entry["repository"])
        digest = repository.digest()
        if entry.get("digest") != digest or entry.get("status") != "active":
            raise ValueError("project_list returned a mismatched digest or inactive project.")
        if digest in seen:
            raise ValueError("project_list returned a duplicate repository identity.")
        seen.add(digest)
        projects.append(repository)

    problems: list[ProjectProblem] = []
    for entry in problem_entries:
        if not isinstance(entry, dict):
            raise ValueError("project_list structuredContent contains an invalid project problem.")
        try:
            problem = ProjectProblem.model_validate(entry)
        except Exception as error:
            raise ValueError("project_list structuredContent contains an invalid project problem.") from error
        if "repository" in entry and entry["repository"] is not None:
            repository = parse_repository_ref(entry["repository"])
            if problem.repository != repository:
                raise ValueError("project_list returned a non-canonical problem repository.")
        problems.append(problem)

    return ProjectDiscovery(projects=projects, problems=problems)


def parse_structured_projects(value: Any) -> list[RepositoryRef]:
    """Compatibility helper for callers that only need healthy project identities."""
    return parse_project_discovery(value).projects


async def tracked_projects() -> ProjectDiscovery:
    async with ContribbotMcpClient() as mcp:
        return parse_project_discovery(await mcp.call_tool_structured("project_list", {}))


class PatrolAllRunner:
    def __init__(self, analyzer_factory: Callable[[], Analyzer], max_investigation_rounds: int = 3) -> None:
        self.analyzer_factory = analyzer_factory
        self.max_investigation_rounds = max_investigation_rounds

    async def run(self, repos: list[RepositoryLike] | None = None) -> PatrolBatchResult:
        if repos is None:
            discovery = await tracked_projects()
            discovered_projects = discovery.projects
            discovery_problems = discovery.problems
        else:
            discovered_projects = repos
            discovery_problems = []
        projects = [parse_repository(repo) for repo in discovered_projects]
        results: list[PatrolResult] = []
        failures: dict[str, str] = {}
        skipped: dict[str, str] = {}
        for repo in projects:
            key = repo.digest()
            try:
                result = await PatrolRunner(
                    ContribbotMcpClient(), self.analyzer_factory(), self.max_investigation_rounds
                ).run(repo)
                results.append(result)
            except ArchivedProjectError as error:
                skipped[key] = str(error)
            except Exception as error:
                failures[key] = str(error)
        return PatrolBatchResult(
            projects=projects,
            results=results,
            failures=failures,
            discovery_problems=discovery_problems,
            skipped=skipped,
            completed_at=utc_now(),
        )


def render_batch(result: PatrolBatchResult) -> str:
    lines = [
        "# Cross-project Patrol", "",
        f"> {len(result.projects)} projects · {len(result.results)} completed · {len(result.failures)} failed · {len(result.skipped)} skipped · {len(result.discovery_problems)} discovery problem(s)", "",
        "| Project | Run | Status | Health | Findings | Actions | Note |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for item in result.results:
        lines.append(f"| {item.run.repo.display()} | `{item.run.id}` | {item.run.status} | {item.analysis.health} | {len(item.analysis.findings)} | {len(item.analysis.actions)} | report recorded |")
    names = {repo.digest(): f"{repo.platform} / {repo.instance} / {repo.path}" for repo in result.projects}
    for key, error in result.failures.items():
        lines.append(f"| {names[key]} | — | failed | unknown | — | — | {error.replace('|', '\\|')} |")
    for key, reason in result.skipped.items():
        lines.append(f"| {names[key]} | — | skipped | — | — | — | {reason.replace('|', '\\|')} |")
    if result.discovery_problems:
        lines.extend([
            "",
            "## Project Discovery Diagnostics",
            "",
            "| Code | Directory | Repository | Message | Note |",
            "| --- | --- | --- | --- | --- |",
        ])
        for problem in result.discovery_problems:
            repository = problem.repository.display() if problem.repository else "—"
            lines.append(
                f"| {problem.code} | {problem.directory.replace('|', '\\|')} | "
                f"{repository.replace('|', '\\|')} | {problem.message.replace('|', '\\|')} | "
                "Direct inspection required; no data was modified |",
            )
    return "\n".join(lines)


def batch_needs_attention(result: PatrolBatchResult) -> bool:
    if result.failures or result.discovery_problems:
        return True
    return any(
        item.run.status in {"partial", "failed"}
        or item.analysis.health in {"attention", "critical"}
        or bool(item.analysis.findings)
        or bool(item.analysis.actions)
        for item in result.results
    )
