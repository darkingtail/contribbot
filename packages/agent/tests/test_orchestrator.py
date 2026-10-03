from contribbot_agent.orchestrator import batch_needs_attention, parse_structured_projects, render_batch
from contribbot_agent.models import PatrolBatchResult, ProjectProblem
import pytest
from contribbot_agent import orchestrator
from contribbot_agent.patrol import ArchivedProjectError
from contribbot_agent.repository import parse_repository


OWNER_REPO = parse_repository("owner/repo")
OWNER_ACTIVE = parse_repository("owner/active")


def test_parse_project_list_reads_complete_identities() -> None:
    repositories = [
        parse_repository("darkingtail/contribbot"),
        parse_repository("antdv-next/antdv-next"),
    ]
    assert parse_structured_projects({
        "schema_version": 1,
        "filter": "active",
        "problems": [],
        "projects": [
            {"repository": repo.to_mcp(), "digest": repo.digest(), "status": "active"}
            for repo in repositories
        ],
    }) == repositories


def test_render_batch_keeps_project_failures_visible() -> None:
    result = PatrolBatchResult(
        projects=[OWNER_REPO],
        results=[],
        failures={OWNER_REPO.digest(): "offline"},
    )
    output = render_batch(result)
    assert OWNER_REPO.path in output
    assert OWNER_REPO.instance in output
    assert "offline" in output
    assert batch_needs_attention(result) is True


def test_empty_successful_batch_is_quiet() -> None:
    result = PatrolBatchResult(projects=[], results=[], failures={})
    assert batch_needs_attention(result) is False


def test_parse_project_list_keeps_discovery_problems_visible() -> None:
    discovery = orchestrator.parse_project_discovery({
        "schema_version": 1,
        "filter": "active",
        "projects": [],
        "problems": [{
            "code": "config_invalid",
            "directory": "D:/projects/broken",
            "message": "Invalid schema v3 repository config.",
        }],
    })
    assert discovery.projects == []
    assert discovery.problems == [ProjectProblem(
        code="config_invalid",
        directory="D:/projects/broken",
        message="Invalid schema v3 repository config.",
    )]


@pytest.mark.asyncio
async def test_explicit_archived_project_is_skipped_not_failed(monkeypatch) -> None:
    async def archived(self, repo):
        raise ArchivedProjectError("Project is archived; use project_restore.")
    monkeypatch.setattr(orchestrator.PatrolRunner, "run", archived)
    monkeypatch.setattr(orchestrator, "ContribbotMcpClient", lambda: object())
    result = await orchestrator.PatrolAllRunner(lambda: object()).run([OWNER_REPO])
    assert result.results == []
    assert result.failures == {}
    assert OWNER_REPO.digest() in result.skipped
    assert "skipped" in render_batch(result)
    assert batch_needs_attention(result) is False


@pytest.mark.asyncio
async def test_discovery_uses_default_active_project_list(monkeypatch) -> None:
    class FakeMcp:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def call_tool_structured(self, name, arguments):
            assert (name, arguments) == ("project_list", {})
            return {
                "schema_version": 1,
                "filter": "active",
                "problems": [],
                "projects": [{
                    "repository": OWNER_ACTIVE.to_mcp(),
                    "digest": OWNER_ACTIVE.digest(),
                    "status": "active",
                }],
            }
    monkeypatch.setattr(orchestrator, "ContribbotMcpClient", FakeMcp)
    discovery = await orchestrator.tracked_projects()
    assert discovery.projects == [OWNER_ACTIVE]
    assert discovery.problems == []
