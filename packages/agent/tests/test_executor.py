from __future__ import annotations

import json
from pathlib import Path

from contribbot_agent.executor import CommandResult, WorktreeExecutor


class FakeRunner:
    def __init__(self, results: list[CommandResult]) -> None:
        self.results = list(results)
        self.calls: list[tuple[list[str], Path, str | None]] = []

    def run(self, args: list[str], cwd: Path, *, input_text: str | None = None, timeout: int = 900) -> CommandResult:
        self.calls.append((args, cwd, input_text))
        return self.results.pop(0)


def ok(args: list[str], stdout: str = "") -> CommandResult:
    return CommandResult(args=args, returncode=0, stdout=stdout)


def executor(tmp_path: Path, results: list[CommandResult]) -> tuple[WorktreeExecutor, FakeRunner]:
    runner = FakeRunner(results)
    return WorktreeExecutor(runner=runner, codex="codex", state_root=tmp_path / "state"), runner


def assert_audit(result, tmp_path: Path) -> None:
    path = tmp_path / "state" / "remediation" / f"{result.run_id}.json"
    assert json.loads(path.read_text(encoding="utf-8"))["status"] == result.status
    assert Path(result.verification_path).exists()


def test_refuses_dirty_source_repository(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    item, runner = executor(tmp_path, [
        ok([], str(repo)),
        ok([], " M tracked.txt\n"),
    ])

    result = item.execute(repo, "Change the file")

    assert result.status == "failed"
    assert result.error == "Source repository is not clean."
    assert len(runner.calls) == 2
    assert_audit(result, tmp_path)


def test_fails_when_codex_produces_no_changes(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    item, runner = executor(tmp_path, [ok([], str(repo)), ok([]), ok([]), ok([]), ok([])])

    result = item.execute(repo, "Change the file")

    assert result.status == "failed"
    assert result.error == "Codex produced no changes."
    assert not any(call[0][:2] in (["git", "commit"], ["git", "push"]) for call in runner.calls)


def test_rejects_nested_protected_paths(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    item, _ = executor(tmp_path, [
        ok([], str(repo)), ok([]), ok([]), ok([]), ok([], " M config/.env\n"),
    ])

    result = item.execute(repo, "Change config")

    assert result.status == "failed"
    assert "config/.env" in result.error


def test_reports_failed_validation(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    item, _ = executor(tmp_path, [
        ok([], str(repo)), ok([]), ok([]), ok([]), ok([], " M src/app.py\n"),
        ok([], "diff --git a/src/app.py b/src/app.py"),
        CommandResult(args=[], returncode=1, stderr="tests failed"),
    ])

    result = item.execute(repo, "Fix app", validations=["pytest"])

    assert result.status == "failed"
    assert result.validations[0]["exit_code"] == 1
    assert result.error == "Validation failed: pytest"


def test_validates_changes_without_publishing(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    item, runner = executor(tmp_path, [
        ok([], str(repo)), ok([]), ok([]), ok([]), ok([], " M src/app.py\n?? tests/test_app.py\n"),
        ok([], "diff --git a/src/app.py b/src/app.py"),
        CommandResult(args=[], returncode=1, stdout="diff --git a/tests/test_app.py b/tests/test_app.py"),
        ok([], "2 passed"),
    ])

    result = item.execute(repo, "Fix app", validations=["pytest"])

    assert result.status == "validated"
    assert result.changed_paths == ["src/app.py", "tests/test_app.py"]
    assert result.validations[0]["output"] == "2 passed"
    flattened = [part for args, _, _ in runner.calls for part in args]
    assert "commit" not in flattened
    assert "push" not in flattened
    assert "pr" not in flattened
    assert Path(result.patch_path).read_text(encoding="utf-8").startswith("diff --git")
    assert "tests/test_app.py" in Path(result.patch_path).read_text(encoding="utf-8")
    assert "PUBLISHING: no commit" in Path(result.verification_path).read_text(encoding="utf-8")
    assert_audit(result, tmp_path)


def test_requires_repository_root(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    nested = repo / "src"
    nested.mkdir(parents=True)
    item, runner = executor(tmp_path, [ok([], str(repo))])

    result = item.execute(nested, "Change app")

    assert result.status == "failed"
    assert "root of a Git repository" in result.error
    assert len(runner.calls) == 1
