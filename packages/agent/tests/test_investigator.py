from __future__ import annotations

from typing import Any

import pytest

from contribbot_agent.investigator import Investigator
from contribbot_agent.models import PatrolAnalysis


class FakeMcp:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        self.calls.append((name, arguments))
        return f"evidence from {name}"


def analysis_with_pr() -> PatrolAnalysis:
    return PatrolAnalysis.model_validate({
        "health": "attention",
        "summary": "PR #820 needs investigation.",
        "findings": [],
        "actions": [],
        "knowledge_candidates": [],
    })


def analysis_with_structured_requests() -> PatrolAnalysis:
    return PatrolAnalysis.model_validate({
        "health": "attention",
        "summary": "A concrete object needs evidence.",
        "findings": [],
        "investigation_requests": [
            {"tool": "pr_review_comments", "pr_number": 42, "reason": "Check unresolved review feedback."},
            {"tool": "commit_detail", "sha": "abc123", "reason": "Inspect the change."},
            {"tool": "compare_refs", "base": "main", "head": "feature", "reason": "Measure divergence."},
        ],
        "actions": [],
        "knowledge_candidates": [],
    })


@pytest.mark.asyncio
async def test_investigator_collects_pr_and_check_evidence_once() -> None:
    mcp = FakeMcp()
    investigator = Investigator(mcp)

    first = await investigator.investigate("owner/repo", analysis_with_pr())
    second = await investigator.investigate("owner/repo", analysis_with_pr())

    assert [item.name for item in first] == ["pr_summary#820", "actions_status#820"]
    assert second == []
    assert ("pr_summary", {"repo": "owner/repo", "pr_number": 820}) in mcp.calls
    assert ("actions_status", {"repo": "owner/repo", "pr_number": 820}) in mcp.calls


@pytest.mark.asyncio
async def test_investigator_prefers_structured_requests() -> None:
    mcp = FakeMcp()
    observations = await Investigator(mcp).investigate("owner/repo", analysis_with_structured_requests())

    assert [item.name for item in observations] == [
        "pr_review_comments#42", "commit_detail#abc123", "compare_refs#main...feature"
    ]
    assert ("commit_detail", {"repo": "owner/repo", "ref": "abc123"}) in mcp.calls
    assert ("compare_refs", {"repo": "owner/repo", "base": "main", "head": "feature"}) in mcp.calls
