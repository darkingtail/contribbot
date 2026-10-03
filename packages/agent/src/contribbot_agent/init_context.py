from __future__ import annotations

import subprocess
import sys
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .mcp_client import ContribbotMcpClient
from .repository import RepositoryLike, RepositoryRef, parse_repository, parse_repository_ref


@dataclass(frozen=True)
class ProjectContext:
    repository: RepositoryRef
    directory: str
    tracking_status: str


def parse_project_context(value: Any, requested: RepositoryRef) -> ProjectContext:
    if not isinstance(value, dict) or type(value.get("schema_version")) is not int or value["schema_version"] != 1:
        raise ValueError("project_init requires structuredContent schema_version 1.")
    repository = parse_repository_ref(value.get("repository"))
    # GitHub may return canonical casing, but never a different project or instance.
    same_path = repository.path == requested.path or (
        requested.platform == "github" and repository.path.lower() == requested.path.lower()
    )
    if repository.platform != requested.platform or repository.instance != requested.instance or not same_path:
        raise ValueError("project_init returned a different repository identity.")
    directory = value.get("directory")
    if not isinstance(directory, str) or not directory.strip():
        raise ValueError("project_init returned no usable data directory.")
    parts = re.split(r"[/\\]", directory)
    if ".." in parts or parts[-3:] != ["projects", "v1", repository.digest()]:
        raise ValueError("project_init directory does not match the repository identity.")
    lifecycle = value.get("lifecycle")
    if not isinstance(lifecycle, dict) or lifecycle.get("status") not in ("active", "archived"):
        raise ValueError("project_init returned an invalid lifecycle status.")
    tracking = value.get("tracking")
    if not isinstance(tracking, dict) or tracking.get("status") not in ("pending", "configured", "none"):
        raise ValueError("project_init returned an invalid tracking status.")
    return ProjectContext(repository, directory, tracking["status"])


def normalize_repo_url(value: str) -> RepositoryRef:
    """Parse a local Git remote into the schema v3 repository identity."""
    try:
        return parse_repository(value)
    except ValueError as error:
        raise ValueError(f"Unable to derive a schema v3 repository identity from remote URL: {value}") from error


def detect_local_repo(path: Path | None = None) -> tuple[Path, RepositoryRef]:
    cwd = (path or Path.cwd()).resolve()
    try:
        root = Path(subprocess.check_output(
            ["git", "-C", str(cwd), "rev-parse", "--show-toplevel"],
            text=True, stderr=subprocess.STDOUT,
        ).strip())
        remote = subprocess.check_output(
            ["git", "-C", str(root), "remote", "get-url", "origin"],
            text=True, stderr=subprocess.STDOUT,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "output", "") or str(error)
        raise ValueError(
            f"Current directory is not an origin-backed Git repository: {detail.strip()}"
        ) from error
    return root, normalize_repo_url(remote)


def validate_tracking(values: list[RepositoryLike]) -> list[RepositoryRef]:
    if not values:
        raise ValueError("Tracking requires at least one repository; use --no-tracking to explicitly choose none.")
    return [parse_repository(value) for value in values]


def parse_tracking_prompt(answer: str) -> list[RepositoryRef] | None | str:
    """Parse an interactive tracking decision without treating silence as 'none'."""
    answer = answer.strip()
    if not answer:
        return None
    if answer.lower() in {"n", "no", "none"}:
        return ""
    values = [item.strip() for item in answer.split(",") if item.strip()]
    return validate_tracking(values)


async def initialize_context(
    repo: RepositoryLike | None = None, path: Path | None = None, *,
    tracking: list[RepositoryLike] | None = None, no_tracking: bool = False, no_input: bool = False,
) -> str:
    if tracking is not None and no_tracking:
        raise ValueError("--tracking and --no-tracking are mutually exclusive.")
    choice: list[RepositoryRef] | str | None
    choice = validate_tracking(tracking) if tracking is not None else ("" if no_tracking else None)
    root = path.resolve() if path else Path.cwd().resolve()
    if repo is None:
        root, repo = detect_local_repo(path)
    repository = parse_repository(repo)

    async with ContribbotMcpClient() as mcp:
        response = await mcp.call_tool_response("project_init", {"repo": repository.to_mcp()})
        metadata = parse_project_context(response.structured_content, repository)
        canonical_repo = metadata.repository
        if choice is None and metadata.tracking_status == "pending" and not no_input and sys.stdin.isatty():
            try:
                answer = input(
                    "Track repositories continuously? Enter owner/repo or URL "
                    "(comma-separated), n for none, or Enter to leave pending: "
                )
                choice = parse_tracking_prompt(answer)
            except (EOFError, KeyboardInterrupt):
                # A missing answer must never become an explicit 'none'.
                pass
        if choice is not None:
            tracking_value: list[dict[str, str]] | str
            tracking_value = (
                "" if choice == ""
                else [source.to_mcp() for source in choice]
            )
            await mcp.call_tool("repo_config", {"repo": canonical_repo.to_mcp(), "tracking": tracking_value})
            response = await mcp.call_tool_response("project_init", {"repo": canonical_repo.to_mcp()})
            metadata = parse_project_context(response.structured_content, canonical_repo)
        context = response.text
        if metadata.tracking_status == "pending":
            context += "\nTracking confirmation remains pending / 未确认. Use --tracking REPOSITORY or --no-tracking to record a decision."

    return "\n".join([
        "# Contribbot Context Initialized", "",
        f"- Requested repository: `{repository.display()}`",
        f"- Canonical repository: `{metadata.repository.display()}`",
        f"- Local path: `{root}`",
        f"- Data path: `{metadata.directory}`", "",
        context,
    ])
