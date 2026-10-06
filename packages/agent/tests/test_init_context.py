import pytest

from contribbot_agent.init_context import canonical_repo_from_context, normalize_repo_url


@pytest.mark.parametrize(
    ("remote", "expected"),
    [
        ("https://github.com/antdv-next/antdv-next.git", "antdv-next/antdv-next"),
        ("git@github.com:antdv-next/antdv-next.git", "antdv-next/antdv-next"),
        ("ssh://git@github.com/antdv-next/antdv-next", "antdv-next/antdv-next"),
    ],
)
def test_normalize_repo_url(remote: str, expected: str) -> None:
    assert normalize_repo_url(remote) == expected


def test_normalize_repo_url_rejects_invalid_remote() -> None:
    with pytest.raises(ValueError):
        normalize_repo_url("https://github.com/antdv-next")


def test_canonical_repo_from_context_prefers_parent_repo() -> None:
    context = "- Requested repository: `darkingtail/antdv-next`\n- Canonical repository: `antdv-next/antdv-next`"

    assert canonical_repo_from_context(context, "darkingtail/antdv-next") == "antdv-next/antdv-next"


from unittest.mock import AsyncMock
from contribbot_agent import init_context


@pytest.fixture
def fake_mcp(monkeypatch):
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.call_tool.return_value = "- Canonical repository: \x60owner/repo\x60\n<!-- contribbot:upstream-status=pending -->"
    monkeypatch.setattr(init_context, "ContribbotMcpClient", lambda: client)
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    return client


@pytest.mark.asyncio
async def test_noninteractive_pending_does_not_write(fake_mcp):
    result = await init_context.initialize_context("fork/repo")
    assert "pending" in result
    assert "--no-upstream" in result
    fake_mcp.call_tool.assert_awaited_once_with("project_init", {"repo": "fork/repo"})


@pytest.mark.asyncio
@pytest.mark.parametrize("options,value", [({"upstream": "external/repo"}, "external/repo"), ({"no_upstream": True}, "")])
async def test_explicit_choice_writes_canonical(fake_mcp, options, value):
    await init_context.initialize_context("fork/repo", **options)
    assert any(call.args == ("repo_config", {"repo": "owner/repo", "upstream": value}) for call in fake_mcp.call_tool.await_args_list)


@pytest.mark.asyncio
@pytest.mark.parametrize("answer", ["", "n", "external/repo", EOFError(), KeyboardInterrupt()])
async def test_tty_answers_and_cancellation(fake_mcp, monkeypatch, answer):
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    def respond(prompt):
        if isinstance(answer, BaseException):
            raise answer
        return answer
    monkeypatch.setattr("builtins.input", respond)
    await init_context.initialize_context("fork/repo")
    writes = [c for c in fake_mcp.call_tool.await_args_list if c.args[0] == "repo_config"]
    expected = "" if answer == "n" else answer
    if answer in ("n", "external/repo"):
        assert len(writes) == 1
        assert writes[0].args[1] == {"repo": "owner/repo", "upstream": expected}
    else:
        assert writes == []


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["configured", "none"])
async def test_confirmed_does_not_prompt(fake_mcp, monkeypatch, status):
    fake_mcp.call_tool.return_value = f"<!-- contribbot:upstream-status={status} -->"
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _: pytest.fail("unexpected prompt"))
    await init_context.initialize_context("owner/repo")
    assert fake_mcp.call_tool.await_count == 1


@pytest.mark.asyncio
async def test_no_input_never_prompts(fake_mcp, monkeypatch):
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _: pytest.fail("unexpected prompt"))
    await init_context.initialize_context("owner/repo", no_input=True)
    assert fake_mcp.call_tool.await_count == 1


def test_init_cli_flags():
    from contribbot_agent.cli import build_parser
    parser = build_parser()
    assert parser.parse_args(["init", "--no-upstream", "--no-input"]).no_upstream
    assert parser.parse_args(["init", "--upstream", "other/repo"]).upstream == "other/repo"
    with pytest.raises(SystemExit):
        parser.parse_args(["init", "--upstream", "other/repo", "--no-upstream"])


@pytest.mark.asyncio
@pytest.mark.parametrize("options", [{"upstream": " "}, {"upstream": "../repo"}, {"upstream": "owner/repo", "no_upstream": True}])
async def test_invalid_explicit_choice_fails_before_mcp(fake_mcp, options):
    with pytest.raises(ValueError):
        await init_context.initialize_context("owner/repo", **options)
    fake_mcp.call_tool.assert_not_awaited()


@pytest.mark.asyncio
async def test_invalid_tty_choice_never_writes(fake_mcp, monkeypatch):
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _: "not-a-repo")
    with pytest.raises(ValueError):
        await init_context.initialize_context("owner/repo")
    fake_mcp.call_tool.assert_awaited_once_with("project_init", {"repo": "owner/repo"})


@pytest.mark.asyncio
async def test_missing_machine_marker_never_guesses_from_prose(fake_mcp, monkeypatch):
    fake_mcp.call_tool.return_value = "upstream pending? none? Ask the user"
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _: pytest.fail("guessed status from prose"))
    result = await init_context.initialize_context("owner/repo")
    assert "status unavailable" in result
    assert fake_mcp.call_tool.await_count == 1


@pytest.mark.asyncio
async def test_explicit_choice_rereads_confirmed_state(fake_mcp):
    fake_mcp.call_tool.side_effect = [
        "- Canonical repository: \x60owner/repo\x60\n<!-- contribbot:upstream-status=pending -->",
        "<!-- contribbot:upstream-status=none -->",
        "- Canonical repository: \x60owner/repo\x60\n<!-- contribbot:upstream-status=none -->",
    ]
    result = await init_context.initialize_context("fork/repo", no_upstream=True, no_input=True)
    assert "<!-- contribbot:upstream-status=none -->" in result
    assert "pending" not in result
    assert fake_mcp.call_tool.await_args_list[-1].args == ("project_init", {"repo": "owner/repo"})


def test_cli_main_forwards_init_options(monkeypatch, capsys):
    from contribbot_agent import cli
    run = AsyncMock(return_value="confirmed none")
    monkeypatch.setattr(cli, "initialize_context", run)
    monkeypatch.setattr(cli, "configure_console_encoding", lambda: None)
    monkeypatch.setattr("sys.argv", ["contribbot", "init", "owner/repo", "--no-upstream", "--no-input"])
    with pytest.raises(SystemExit) as result:
        cli.main()
    assert result.value.code == 0
    run.assert_awaited_once_with("owner/repo", None, upstream=None, no_upstream=True, no_input=True)
    assert capsys.readouterr().out == "confirmed none\n"
