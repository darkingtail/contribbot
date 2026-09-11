from __future__ import annotations

import re
import subprocess
from pathlib import Path

from .mcp_client import ContribbotMcpClient


def canonical_repo_from_context(context: str, fallback: str) -> str:
    match = re.search(r"^- Canonical repository: `([^`]+)`$", context, re.MULTILINE)
    return match.group(1) if match else fallback


def normalize_repo_url(value: str) -> str:
    value = value.strip().removesuffix("/").removesuffix(".git")
    if value.startswith("git@") and ":" in value:
        value = value.split(":", 1)[1]
    else:
        value = re.sub(r"^https?://[^/]+/", "", value)
        value = re.sub(r"^ssh://git@[^/]+/", "", value)
    parts = value.split("/")
    if len(parts) != 2 or not all(re.fullmatch(r"[A-Za-z0-9_.-]+", part) for part in parts):
        raise ValueError(f"Unable to derive owner/repo from remote URL: {value}")
    return "/".join(parts)


def detect_local_repo(path: Path | None = None) -> tuple[Path, str]:
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


async def initialize_context(repo: str | None = None, path: Path | None = None) -> str:
    root = path.resolve() if path else Path.cwd().resolve()
    if repo is None:
        root, repo = detect_local_repo(path)

    async with ContribbotMcpClient() as mcp:
        context = await mcp.call_tool("project_init", {"repo": repo})

    canonical_repo = canonical_repo_from_context(context, repo)
    data_path = Path.home() / ".contribbot" / canonical_repo
    return "\n".join([
        "# Contribbot Context Initialized", "",
        f"- Requested repository: `{repo}`",
        f"- Canonical repository: `{canonical_repo}`",
        f"- Local path: `{root}`",
        f"- Data path: `{data_path}`", "",
        context,
    ])
