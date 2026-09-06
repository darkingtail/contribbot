from __future__ import annotations

import re

from .mcp_client import ContribbotMcpClient
from .models import Observation, PatrolAnalysis


class Investigator:
    """Bounded evidence collector for findings that name concrete GitHub objects."""

    def __init__(self, mcp: ContribbotMcpClient) -> None:
        self.mcp = mcp
        self.seen: set[tuple[str, str]] = set()

    async def investigate(self, repo: str, analysis: PatrolAnalysis) -> list[Observation]:
        requests = self._structured_requests(repo, analysis)
        if not requests:
            requests = self._legacy_requests(repo, analysis)

        observations: list[Observation] = []
        for tool, arguments, name in requests:
            key = (tool, name)
            if key in self.seen:
                continue
            self.seen.add(key)
            try:
                content = await self.mcp.call_tool(tool, arguments)
                observations.append(Observation(name=name, ok=True, content=content))
            except Exception as error:
                observations.append(Observation(name=name, ok=False, content="", error=str(error)))
        return observations

    @staticmethod
    def _structured_requests(repo: str, analysis: PatrolAnalysis) -> list[tuple[str, dict[str, object], str]]:
        requests: list[tuple[str, dict[str, object], str]] = []
        for request in analysis.investigation_requests:
            arguments: dict[str, object] = {"repo": repo}
            suffix = ""
            if request.pr_number is not None:
                arguments["pr_number"] = request.pr_number
                suffix = str(request.pr_number)
            elif request.issue_number is not None:
                arguments["issue_number"] = request.issue_number
                suffix = str(request.issue_number)
            elif request.sha:
                arguments["ref"] = request.sha
                suffix = request.sha[:12]
            elif request.base and request.head:
                arguments.update({"base": request.base, "head": request.head})
                suffix = f"{request.base}...{request.head}"
            requests.append((request.tool, arguments, f"{request.tool}#{suffix}"))
        return requests

    @staticmethod
    def _legacy_requests(repo: str, analysis: PatrolAnalysis) -> list[tuple[str, dict[str, object], str]]:
        text = "\n".join(
            [analysis.summary]
            + [f"{item.title}\n{item.evidence}\n{item.impact}" for item in analysis.findings]
            + [f"{item.title}\n{item.reason}\n{item.suggested_command}" for item in analysis.actions]
        )
        requests: list[tuple[str, dict[str, object], str]] = []
        for raw in re.findall(r"(?:PR|pull request)\s*#?(\d+)", text, flags=re.IGNORECASE):
            number = int(raw)
            requests.extend([
                ("pr_summary", {"repo": repo, "pr_number": number}, f"pr_summary#{number}"),
                ("actions_status", {"repo": repo, "pr_number": number}, f"actions_status#{number}"),
            ])
        for raw in re.findall(r"issue\s*#?(\d+)", text, flags=re.IGNORECASE):
            number = int(raw)
            requests.append(("issue_detail", {"repo": repo, "issue_number": number}, f"issue_detail#{number}"))

        return requests
