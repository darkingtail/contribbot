from unittest.mock import AsyncMock

import pytest

from contribbot_agent import init_context
from contribbot_agent.init_context import normalize_repo_url, parse_project_context
from contribbot_agent.mcp_client import McpToolResponse
from contribbot_agent.repository import parse_repository


REPO = parse_repository("owner/repo")

def context_response(status="pending", repository=REPO, text=None):
    return McpToolResponse(
        text=text if text is not None else f"Tracking: {status}",
        structured_content={
            "schema_version": 1,
            "repository": repository.to_mcp(),
            "directory": f"/isolated/projects/v1/{repository.digest()}",
            "lifecycle": {"status": "active"},
            "tracking": {"status": status},
        },
    )


@pytest.mark.parametrize(
    ("remote", "expected"),
    [
        ("https://github.com/antdv-next/antdv-next.git", "antdv-next/antdv-next"),
        ("git@github.com:antdv-next/antdv-next.git", "antdv-next/antdv-next"),
        ("ssh://git@github.com/antdv-next/antdv-next", "antdv-next/antdv-next"),
    ],
)
def test_normalize_repo_url(remote: str, expected: str) -> None:
    assert normalize_repo_url(remote) == parse_repository(expected)


def test_normalize_repo_url_rejects_invalid_remote() -> None:
    with pytest.raises(ValueError):
        normalize_repo_url("https://github.com/antdv-next")


def test_context_never_switches_to_the_parent_repo() -> None:
    value = context_response(repository=parse_repository("antdv-next/antdv-next"))
    with pytest.raises(ValueError, match="different repository"):
        parse_project_context(value.structured_content, parse_repository("darkingtail/antdv-next"))


def test_context_accepts_canonical_github_casing() -> None:
    canonical = parse_repository("Owner/Repo")
    value = context_response(repository=canonical)
    assert parse_project_context(value.structured_content, REPO).repository == canonical


@pytest.fixture
def fake_mcp(monkeypatch):
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.call_tool_response.return_value = context_response()
    monkeypatch.setattr(init_context, "ContribbotMcpClient", lambda: client)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    return client


@pytest.mark.asyncio
async def test_noninteractive_pending_does_not_write(fake_mcp):
    result = await init_context.initialize_context("owner/repo")
    assert "pending" in result
    assert "--no-tracking" in result
    fake_mcp.call_tool_response.assert_awaited_once_with(
        "project_init",
        {"repo": REPO.to_mcp()},
    )
    fake_mcp.call_tool.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("options", "value"),
    [({"tracking": ["external/repo"]}, ["external/repo"]), ({"no_tracking": True}, "")],
)
async def test_explicit_choice_writes_canonical(fake_mcp, options, value):
    await init_context.initialize_context("owner/repo", **options)
    expected_tracking = (
        value
        if value == ""
        else [parse_repository(source).to_mcp() for source in value]
    )
    assert any(
        call.args
        == (
            "repo_config",
            {"repo": REPO.to_mcp(), "tracking": expected_tracking},
        )
        for call in fake_mcp.call_tool.await_args_list
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", ["", "n", "external/repo", EOFError(), KeyboardInterrupt()])
async def test_tty_answers_and_cancellation(fake_mcp, monkeypatch, answer):
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)

    def respond(prompt):
        if isinstance(answer, BaseException):
            raise answer
        return answer

    monkeypatch.setattr("builtins.input", respond)
    await init_context.initialize_context("owner/repo")
    writes = [c for c in fake_mcp.call_tool.await_args_list if c.args[0] == "repo_config"]
    if answer == "n":
        expected = ""
    elif answer == "external/repo":
        expected = [parse_repository(answer).to_mcp()]
    else:
        expected = None
    if expected is not None:
        assert len(writes) == 1
        assert writes[0].args[1] == {
            "repo": REPO.to_mcp(),
            "tracking": expected,
        }
    else:
        assert writes == []


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["configured", "none"])
async def test_confirmed_does_not_prompt(fake_mcp, monkeypatch, status):
    fake_mcp.call_tool_response.return_value = context_response(status)
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _: pytest.fail("unexpected prompt"))
    await init_context.initialize_context("owner/repo")
    assert fake_mcp.call_tool_response.await_count == 1
    fake_mcp.call_tool.assert_not_awaited()


@pytest.mark.asyncio
async def test_no_input_never_prompts(fake_mcp, monkeypatch):
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _: pytest.fail("unexpected prompt"))
    await init_context.initialize_context("owner/repo", no_input=True)
    assert fake_mcp.call_tool_response.await_count == 1
    fake_mcp.call_tool.assert_not_awaited()


def test_init_cli_flags():
    from contribbot_agent.cli import build_parser

    parser = build_parser()
    assert parser.parse_args(["init", "--no-tracking", "--no-input"]).no_tracking
    assert parser.parse_args(["init", "--tracking", "other/repo"]).tracking == ["other/repo"]
    with pytest.raises(SystemExit):
        parser.parse_args(["init", "--tracking", "other/repo", "--no-tracking"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "options",
    [
        {"tracking": [" "]},
        {"tracking": ["../repo"]},
        {"tracking": ["owner/repo"], "no_tracking": True},
    ],
)
async def test_invalid_explicit_choice_fails_before_mcp(fake_mcp, options):
    with pytest.raises(ValueError):
        await init_context.initialize_context("owner/repo", **options)
    fake_mcp.call_tool.assert_not_awaited()
    fake_mcp.call_tool_response.assert_not_awaited()


@pytest.mark.asyncio
async def test_invalid_tty_choice_never_writes(fake_mcp, monkeypatch):
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _: "not-a-repo")
    with pytest.raises(ValueError):
        await init_context.initialize_context("owner/repo")
    fake_mcp.call_tool_response.assert_awaited_once_with(
        "project_init",
        {"repo": REPO.to_mcp()},
    )
    fake_mcp.call_tool.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_metadata_never_guesses_from_prose(fake_mcp, monkeypatch):
    fake_mcp.call_tool_response.return_value = McpToolResponse(
        text="tracking pending? none? Ask the user"
    )
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _: pytest.fail("guessed status from prose"))
    with pytest.raises(ValueError, match="structuredContent"):
        await init_context.initialize_context("owner/repo")
    assert fake_mcp.call_tool_response.await_count == 1
    fake_mcp.call_tool.assert_not_awaited()


@pytest.mark.asyncio
async def test_explicit_choice_rereads_confirmed_state(fake_mcp):
    fake_mcp.call_tool_response.side_effect = [context_response(), context_response("none")]
    result = await init_context.initialize_context("owner/repo", no_tracking=True, no_input=True)
    assert "Tracking: none" in result
    assert "pending" not in result
    assert fake_mcp.call_tool_response.await_args_list[-1].args == (
        "project_init",
        {"repo": REPO.to_mcp()},
    )


def test_cli_main_forwards_init_options(monkeypatch, capsys):
    from contribbot_agent import cli

    run = AsyncMock(return_value="confirmed none")
    monkeypatch.setattr(cli, "initialize_context", run)
    monkeypatch.setattr(cli, "configure_console_encoding", lambda: None)
    monkeypatch.setattr(
        "sys.argv",
        ["contribbot", "init", "owner/repo", "--no-tracking", "--no-input"],
    )
    with pytest.raises(SystemExit) as result:
        cli.main()
    assert result.value.code == 0
    run.assert_awaited_once_with(
        "owner/repo",
        None,
        tracking=None,
        no_tracking=True,
        no_input=True,
    )
    assert capsys.readouterr().out == "confirmed none\n"
