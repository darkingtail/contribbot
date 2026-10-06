from contribbot_agent.orchestrator import batch_needs_attention, parse_project_list, render_batch
from contribbot_agent.models import PatrolBatchResult
import pytest
from contribbot_agent import orchestrator
from contribbot_agent.patrol import ArchivedProjectError


def test_parse_project_list_reads_repository_names() -> None:
    markdown = """## Projects

| Project | Todos | Note |
| --- | --- | --- |
| darkingtail/contribbot | 1 | active |
| antdv-next/antdv-next | 2 | active |
"""
    assert parse_project_list(markdown) == ["darkingtail/contribbot", "antdv-next/antdv-next"]


def test_render_batch_keeps_project_failures_visible() -> None:
    result = PatrolBatchResult(projects=["owner/repo"], results=[], failures={"owner/repo": "offline"})
    output = render_batch(result)
    assert "owner/repo" in output
    assert "offline" in output
    assert batch_needs_attention(result) is True


def test_empty_successful_batch_is_quiet() -> None:
    result = PatrolBatchResult(projects=[], results=[], failures={})
    assert batch_needs_attention(result) is False


@pytest.mark.asyncio
async def test_explicit_archived_project_is_skipped_not_failed(monkeypatch) -> None:
    async def archived(self, repo):
        raise ArchivedProjectError("Project is archived; use project_restore.")
    monkeypatch.setattr(orchestrator.PatrolRunner, "run", archived)
    monkeypatch.setattr(orchestrator, "ContribbotMcpClient", lambda: object())
    result = await orchestrator.PatrolAllRunner(lambda: object()).run(["owner/repo"])
    assert result.results == []
    assert result.failures == {}
    assert "owner/repo" in result.skipped
    assert "skipped" in render_batch(result)
    assert batch_needs_attention(result) is False


@pytest.mark.asyncio
async def test_discovery_uses_default_active_project_list(monkeypatch) -> None:
    class FakeMcp:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def call_tool(self, name, arguments):
            assert (name, arguments) == ("project_list", {})
            return "| Project | Status | Note |\n| --- | --- | --- |\n| owner/active | active | retained |\n"
    monkeypatch.setattr(orchestrator, "ContribbotMcpClient", FakeMcp)
    assert await orchestrator.tracked_projects() == ["owner/active"]
