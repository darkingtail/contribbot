from __future__ import annotations

import json
from typing import Any

import pytest

from contribbot_agent.models import PatrolAnalysis
from contribbot_agent.patrol import OBSERVATION_TOOLS, PatrolRunner


class FakeMcpClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def __aenter__(self) -> "FakeMcpClient":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        return None

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        self.calls.append((name, arguments))
        if name == "patrol_record":
            assert json.loads(arguments["snapshot_json"])["repo"] == "owner/repo"
            assert json.loads(arguments["analysis_json"])["health"] == "attention"
            assert isinstance(json.loads(arguments["trace_json"]), list)
            assert json.loads(arguments["run_json"])["status"] in {"succeeded", "partial"}
            assert isinstance(json.loads(arguments["actions_json"]), list)
            return "recorded"
        if name == "knowledge_propose_update":
            return "proposal created"
        if name == "todo_detail":
            return f"Todo implementation record for {arguments['item']}"
        return f"result from {name}"

    async def read_knowledge(self, repo: str) -> dict[str, str]:
        assert repo == "owner/repo"
        return {"ci": "# CI\n\nUse pnpm."}


class FakeAnalyzer:
    async def analyze(self, snapshot) -> PatrolAnalysis:
        assert snapshot.repo == "owner/repo"
        assert len(snapshot.observations) == len(OBSERVATION_TOOLS) + 1
        return PatrolAnalysis.model_validate(
            {
                "health": "attention",
                "summary": "One maintenance item needs attention.",
                "findings": [
                    {
                        "severity": "medium",
                        "title": "Pending maintenance",
                        "evidence": "todo_list contains one active item",
                        "impact": "The task may become stale.",
                    }
                ],
                "actions": [
                    {
                        "kind": "read",
                        "title": "Review the active todo",
                        "reason": "It is the next local maintenance step.",
                        "safety": "auto",
                        "suggested_command": "contribbot todo owner/repo",
                    }
                ],
                "knowledge_candidates": [
                    {
                        "target": "ci",
                        "action": "append",
                        "title": "Record the build command",
                        "rationale": "The command is stable across tasks.",
                        "proposed_content": "Run `pnpm build` before submitting.",
                    }
                ],
            }
        )


class CreateTodoAnalyzer:
    async def analyze(self, snapshot) -> PatrolAnalysis:
        return PatrolAnalysis.model_validate(
            {
                "health": "attention",
                "summary": "One follow-up should be tracked.",
                "findings": [],
                "actions": [
                    {
                        "kind": "create_todo",
                        "title": "Inspect PR #820 checks",
                        "reason": "The check state is unresolved.",
                        "safety": "confirm",
                        "suggested_command": "Create a local todo.",
                    }
                ],
                "knowledge_candidates": [],
            }
        )


@pytest.mark.asyncio
async def test_patrol_runs_the_closed_loop_and_records_audit_artifacts() -> None:
    mcp = FakeMcpClient()
    result = await PatrolRunner(mcp, FakeAnalyzer()).run(
        "owner/repo",
        approve_knowledge=True,
    )

    names = [name for name, _ in mcp.calls]
    assert names[0] == "repo_config"
    assert set(OBSERVATION_TOOLS).issubset(names)
    assert "knowledge_propose_update" in names
    assert names[-1] == "patrol_record"
    assert result.proposal_results == ["proposal created"]
    assert "# Patrol Report" in result.report
    assert "proposal created" in result.report
    assert "Public GitHub writes" in result.report
    assert result.run.status == "succeeded"


@pytest.mark.asyncio
async def test_patrol_keeps_knowledge_as_candidate_without_approval() -> None:
    mcp = FakeMcpClient()
    result = await PatrolRunner(mcp, FakeAnalyzer()).run(
        "owner/repo",
        approve_knowledge=False,
        confirm_knowledge=lambda _: False,
    )

    names = [name for name, _ in mcp.calls]
    assert "knowledge_propose_update" not in names
    assert names[-1] == "patrol_record"
    assert "awaiting approval" in result.report


@pytest.mark.asyncio
async def test_patrol_creates_todo_after_explicit_confirmation() -> None:
    mcp = FakeMcpClient()
    result = await PatrolRunner(mcp, CreateTodoAnalyzer()).run(
        "owner/repo",
        confirm_action=lambda _: True,
    )

    todo_calls = [arguments for name, arguments in mcp.calls if name == "todo_add"]
    assert todo_calls[0]["repo"] == "owner/repo"
    assert todo_calls[0]["text"] == "Inspect PR #820 checks"
    assert str(todo_calls[0]["ref"]).startswith("patrol-")
    detail_calls = [arguments for name, arguments in mcp.calls if name == "todo_detail"]
    assert detail_calls == [{"repo": "owner/repo", "item": todo_calls[0]["ref"]}]
    assert result.action_results == [
        f"result from todo_add\nVerified todo: {todo_calls[0]['ref']}"
    ]
    assert "result from todo_add" in result.report
    assert result.actions[0].status == "completed"


@pytest.mark.asyncio
async def test_patrol_marks_todo_action_failed_when_readback_fails() -> None:
    class MissingTodoMcp(FakeMcpClient):
        async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
            if name == "todo_detail":
                raise RuntimeError("Todo not found")
            return await super().call_tool(name, arguments)

    result = await PatrolRunner(MissingTodoMcp(), CreateTodoAnalyzer()).run(
        "owner/repo",
        confirm_action=lambda _: True,
    )

    assert result.actions[0].status == "failed"
    assert result.actions[0].error == "Todo not found"
    assert result.run.status == "partial"


@pytest.mark.asyncio
async def test_patrol_does_not_create_todo_without_confirmation() -> None:
    mcp = FakeMcpClient()
    result = await PatrolRunner(mcp, CreateTodoAnalyzer()).run(
        "owner/repo",
        confirm_action=lambda _: False,
    )

    assert not any(name == "todo_add" for name, _ in mcp.calls)
    assert result.action_results == []
    assert result.actions[0].status == "rejected"


class ResumeMcpClient(FakeMcpClient):
    def __init__(self, stored: dict[str, Any]) -> None:
        super().__init__()
        self.stored = stored

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        if name == "patrol_run_get":
            self.calls.append((name, arguments))
            return json.dumps(self.stored)
        return await super().call_tool(name, arguments)


@pytest.mark.asyncio
async def test_resume_executes_a_previously_skipped_action_without_reanalysis() -> None:
    analysis = await CreateTodoAnalyzer().analyze(None)
    action = analysis.actions[0]
    action_id = PatrolRunner._action_id("owner/repo", action)
    stored = {
        "run": {
            "id": "run-1", "repo": "owner/repo", "status": "succeeded",
            "started_at": "2026-09-06T00:00:00+00:00", "completed_at": "2026-09-06T00:01:00+00:00",
            "coverage_complete": True, "investigation_rounds": 0, "error": "",
        },
        "snapshot": {
            "repo": "owner/repo", "created_at": "2026-09-06T00:00:00+00:00",
            "observations": [], "knowledge": {},
        },
        "analysis": analysis.model_dump(mode="json"),
        "actions": [{
            "id": action_id, "kind": "create_todo", "title": action.title,
            "status": "skipped", "safety": "confirm", "approved_at": None,
            "completed_at": None, "result": "", "error": "",
        }],
        "trace": [],
        "report": "old",
    }
    mcp = ResumeMcpClient(stored)

    result = await PatrolRunner(mcp, FakeAnalyzer()).resume(
        "owner/repo", "run-1", confirm_action=lambda _: True,
    )

    names = [name for name, _ in mcp.calls]
    assert names == ["patrol_run_get", "todo_add", "todo_detail", "patrol_record"]
    assert result.actions[0].status == "completed"
    assert result.run.id == "run-1"
