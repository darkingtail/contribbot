from copy import deepcopy
import hashlib
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from contribbot_agent import init_context, orchestrator
from contribbot_agent.mcp_client import ContribbotMcpClient, McpToolResponse
from contribbot_agent.repository import RepositoryRef, parse_repository_ref, repository_data_path


REPO = RepositoryRef(
    platform="gitlab",
    instance="http://code.example.com:8080/gitlab",
    path="team/subgroup/app",
)
DIRECTORY = f"D:/isolated/projects/v1/{REPO.digest()}"
IDENTITY_VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "mcp/src/core/utils/__fixtures__/repository-key-v1.json"
    ).read_text(encoding="utf-8")
)


def initialization(repository=REPO):
    return {
        "schema_version": 1,
        "repository": repository.to_mcp(),
        "directory": DIRECTORY,
        "lifecycle": {"status": "active"},
        "tracking": {"status": "pending"},
    }


def project_list(repositories=None):
    return {
        "schema_version": 1,
        "filter": "active",
        "problems": [],
        "projects": [
            {"repository": repo.to_mcp(), "digest": repo.digest(), "status": "active"}
            for repo in ([REPO] if repositories is None else repositories)
        ],
    }


@pytest.fixture
def client(monkeypatch):
    value = AsyncMock()
    value.__aenter__.return_value = value
    prose = (
        "- Canonical repository: `github://github.com/wrong/project`\n"
        "<!-- contribbot:tracking-status=none -->"
    )
    value.call_tool.return_value = prose
    value.call_tool_response.return_value = McpToolResponse(
        text=prose, structured_content=initialization()
    )
    monkeypatch.setattr(init_context, "ContribbotMcpClient", lambda: value)
    monkeypatch.setattr(orchestrator, "ContribbotMcpClient", lambda: value)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    return value


@pytest.mark.asyncio
async def test_init_preserves_structured_identity_and_directory_not_prose(client):
    result = await init_context.initialize_context(REPO, no_input=True)
    assert f"- Data path: `{DIRECTORY}`" in result
    assert "Tracking confirmation remains pending" in result
    client.call_tool_response.assert_awaited_once_with(
        "project_init", {"repo": REPO.to_mcp()}
    )
    client.call_tool.assert_not_awaited()


@pytest.mark.asyncio
async def test_tracking_write_uses_the_structured_repository(client):
    confirmed = initialization()
    confirmed["tracking"] = {"status": "none"}
    client.call_tool_response.side_effect = [
        client.call_tool_response.return_value,
        McpToolResponse(text="updated", structured_content=confirmed),
    ]
    await init_context.initialize_context(REPO, no_tracking=True, no_input=True)
    client.call_tool.assert_awaited_once_with(
        "repo_config", {"repo": REPO.to_mcp(), "tracking": ""}
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [
        lambda value: None,
        lambda value: {**value, "schema_version": True},
        lambda value: {**value, "schema_version": 2},
        lambda value: {**value, "repository": "team/app"},
        lambda value: {**value, "repository": {**REPO.to_mcp(), "instance": "https://other.example"}},
        lambda value: {**value, "repository": {**REPO.to_mcp(), "path": "parent/app"}},
        lambda value: {**value, "directory": ""},
        lambda value: {**value, "tracking": {}},
        lambda value: {**value, "lifecycle": {"status": "unknown"}},
    ],
)
async def test_bad_init_metadata_stops_before_any_tracking_write(client, change):
    client.call_tool_response.return_value = McpToolResponse(
        text="Tracking is pending", structured_content=change(initialization())
    )
    with pytest.raises((ValueError, RuntimeError)):
        await init_context.initialize_context(REPO, no_tracking=True, no_input=True)
    client.call_tool.assert_not_awaited()


@pytest.mark.asyncio
async def test_discovery_error_is_not_retried_as_markdown(client):
    client.call_tool_structured.side_effect = RuntimeError("invalid project config")
    client.call_tool.return_value = "| Project | Note |\n| --- | --- |\n| owner/repo | old data |\n"
    with pytest.raises(RuntimeError, match="invalid project config"):
        await orchestrator.tracked_projects()
    client.call_tool.assert_not_awaited()


@pytest.mark.parametrize(
    "change",
    [
        lambda value: {**value, "schema_version": True},
        lambda value: {**value, "schema_version": 2},
        lambda value: {**value, "filter": "all"},
        lambda value: {**value, "projects": [{"repository": "owner/repo"}]},
        lambda value: {**value, "projects": [{**value["projects"][0], "digest": "0" * 64}]},
        lambda value: {**value, "projects": [{**value["projects"][0], "status": "archived"}]},
        lambda value: {**value, "projects": value["projects"] * 2},
    ],
)
def test_discovery_rejects_bad_structured_metadata(change):
    with pytest.raises(ValueError):
        orchestrator.parse_structured_projects(change(deepcopy(project_list())))


def test_discovery_keeps_a_real_empty_list_distinct_from_failure():
    assert orchestrator.parse_structured_projects(project_list([])) == []


@pytest.mark.asyncio
async def test_empty_explicit_batch_does_not_discover_projects(monkeypatch):
    discover = AsyncMock(return_value=[REPO])
    monkeypatch.setattr(orchestrator, "tracked_projects", discover)
    result = await orchestrator.PatrolAllRunner(lambda: object()).run([])
    discover.assert_not_awaited()
    assert result.projects == []


@pytest.mark.asyncio
async def test_same_display_name_does_not_overwrite_another_project_failure(monkeypatch):
    repos = [
        RepositoryRef(platform="gitlab", instance="https://code.example.com/gitlab", path="team/app"),
        RepositoryRef(platform="gitlab", instance="https://code.example.com", path="gitlab/team/app"),
    ]
    assert repos[0].display() == repos[1].display()

    async def fail(self, repo):
        raise RuntimeError(f"failed {repo.digest()}")

    monkeypatch.setattr(orchestrator.PatrolRunner, "run", fail)
    monkeypatch.setattr(orchestrator, "ContribbotMcpClient", lambda: object())
    result = await orchestrator.PatrolAllRunner(lambda: object()).run(repos)
    assert set(result.failures) == {repo.digest() for repo in repos}
    output = orchestrator.render_batch(result)
    for repo in repos:
        assert f"failed {repo.digest()}" in output
        assert f"{repo.platform} / {repo.instance} / {repo.path}" in output


@pytest.mark.parametrize("repository", [None, "owner/repo", {"platform": "github", "path": "owner/repo"}])
def test_client_never_silently_guesses_or_omits_explicit_repository(repository):
    with pytest.raises(ValueError):
        ContribbotMcpClient._normalize_arguments({"repo": repository})


def test_client_keeps_global_calls_and_complete_repositories():
    assert ContribbotMcpClient._normalize_arguments({}) == {}
    assert ContribbotMcpClient._normalize_arguments({"repo": REPO.to_mcp()}) == {
        "repo": REPO.to_mcp()
    }


@pytest.mark.parametrize("vector", IDENTITY_VECTORS["canonical"])
def test_repository_key_v1_normalizes_and_hashes_the_shared_vectors(vector):
    repo = RepositoryRef.model_validate(vector["input"])
    assert repo.to_mcp() == vector["expected"]
    key = json.dumps(
        ["repository-key-v1", repo.platform, repo.instance, repo.path],
        separators=(",", ":"),
    )
    assert repo.identity_key() == key
    assert repo.digest() == hashlib.sha256(key.encode("utf-8")).hexdigest()
    assert parse_repository_ref(vector["expected"]) == repo


@pytest.mark.parametrize("value", IDENTITY_VECTORS["invalid"])
def test_repository_key_v1_rejects_ambiguous_inputs(value):
    with pytest.raises(ValueError):
        RepositoryRef.model_validate(value)


@pytest.mark.parametrize("value", [
    "https://git\nhub.com/owner/repo",
    "https://github.com/owner/\trepo",
])
def test_public_repository_url_rejects_control_characters(value):
    from contribbot_agent.repository import parse_repository

    with pytest.raises(ValueError):
        parse_repository(value)


@pytest.mark.parametrize("directory", [
    "D:/isolated/projects/v1/other-digest",
    f"D:/isolated/projects/v2/{REPO.digest()}",
    f"D:/isolated/other/v1/{REPO.digest()}",
    f"D:/isolated/../projects/v1/{REPO.digest()}",
])
@pytest.mark.asyncio
async def test_init_rejects_unrelated_directory_before_tracking_write(client, directory):
    response = initialization()
    response["directory"] = directory
    client.call_tool_response.return_value = McpToolResponse(
        text="pending", structured_content=response,
    )
    with pytest.raises(ValueError, match="directory"):
        await init_context.initialize_context(REPO, no_tracking=True, no_input=True)
    client.call_tool.assert_not_awaited()


@pytest.mark.asyncio
async def test_knowledge_resource_read_rejects_noncanonical_identity_before_listing():
    client = ContribbotMcpClient()
    client._session = AsyncMock()
    with pytest.raises(ValueError):
        await client.read_knowledge("owner/repo")
    client._session.list_resources.assert_not_awaited()
    with pytest.raises(ValueError):
        repository_data_path("owner/repo")
