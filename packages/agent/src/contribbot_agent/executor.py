from __future__ import annotations

import fnmatch
import json
import os
import shutil
import subprocess
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path


DEFAULT_FORBIDDEN = (".env", ".env.*", "*.pem", "*.key", ".git", ".git/*", ".sync-input", ".sync-checklist*")


@dataclass
class CommandResult:
    args: list[str]
    returncode: int
    stdout: str = ""
    stderr: str = ""


class CommandRunner:
    def run(self, args: list[str], cwd: Path, *, input_text: str | None = None, timeout: int = 900) -> CommandResult:
        result = subprocess.run(
            args,
            cwd=cwd,
            input=input_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
        return CommandResult(args=args, returncode=result.returncode, stdout=result.stdout, stderr=result.stderr)


@dataclass
class RemediationResult:
    run_id: str
    status: str
    branch: str
    worktree: str
    changed_paths: list[str]
    validations: list[dict[str, object]]
    error: str = ""
    patch_path: str = ""
    verification_path: str = ""

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2)


class WorktreeExecutor:
    """Let Codex edit an isolated worktree, then verify it without publishing."""

    def __init__(
        self,
        runner: CommandRunner | None = None,
        codex: str | None = None,
        state_root: Path | None = None,
    ) -> None:
        self.runner = runner or CommandRunner()
        self.codex = codex or shutil.which("codex") or "codex"
        self.state_root = state_root or Path.home() / ".contribbot"

    def execute(
        self,
        repo_path: Path,
        prompt: str,
        *,
        base: str = "HEAD",
        validations: list[str] | None = None,
        forbidden: tuple[str, ...] = DEFAULT_FORBIDDEN,
        timeout: int = 900,
    ) -> RemediationResult:
        repo_path = repo_path.resolve()
        run_id = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        branch = f"contribbot/remediate-{run_id}"
        worktree = self.state_root / "worktrees" / repo_path.name / run_id
        worktree.parent.mkdir(parents=True, exist_ok=True)

        root = self._run(["git", "rev-parse", "--show-toplevel"], repo_path)
        if root.returncode != 0 or Path(root.stdout.strip()).resolve() != repo_path:
            return self._finish(RemediationResult(run_id, "failed", branch, str(worktree), [], [], "repo_path must be the root of a Git repository."))

        clean = self._run(["git", "status", "--porcelain"], repo_path)
        if clean.stdout.strip():
            return self._finish(RemediationResult(run_id, "failed", branch, str(worktree), [], [], "Source repository is not clean."))

        prepared = self._run(["git", "worktree", "add", "-b", branch, str(worktree), base], repo_path)
        if prepared.returncode != 0:
            return self._finish(RemediationResult(run_id, "failed", branch, str(worktree), [], [], prepared.stderr or prepared.stdout))

        instructions = f"""{prompt}

Work only inside the current worktree. Do not commit, push, create a pull request,
change Git remotes, or modify protected secret/config files. Leave changes
uncommitted for contribbot to validate and for the maintainer to review.
"""
        codex = self._run(
            [self.codex, "exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never", "-"],
            worktree,
            input_text=instructions,
            timeout=timeout,
        )
        if codex.returncode != 0:
            return self._finish(RemediationResult(run_id, "failed", branch, str(worktree), [], [], codex.stderr or codex.stdout))

        status = self._run(["git", "status", "--porcelain", "--untracked-files=all"], worktree)
        changed = self._changed_paths(status.stdout)
        if not changed:
            return self._finish(RemediationResult(run_id, "failed", branch, str(worktree), [], [], "Codex produced no changes."))
        prohibited = [path for path in changed if self._is_forbidden(path, forbidden)]
        if prohibited:
            return self._finish(RemediationResult(run_id, "failed", branch, str(worktree), changed, [], f"Prohibited paths changed: {', '.join(prohibited)}"))

        patch_result = self._build_patch(worktree, status.stdout)
        if patch_result.returncode != 0:
            return self._finish(RemediationResult(run_id, "failed", branch, str(worktree), changed, [], patch_result.stderr or patch_result.stdout))
        if not patch_result.stdout.strip():
            return self._finish(RemediationResult(run_id, "failed", branch, str(worktree), changed, [], "Unable to produce a reviewable patch."))

        validation_results: list[dict[str, object]] = []
        for command in validations or []:
            args = ["powershell", "-NoProfile", "-Command", command] if os.name == "nt" else ["/bin/sh", "-lc", command]
            checked = self._run(args, worktree, timeout=timeout)
            validation_results.append({
                "command": command,
                "exit_code": checked.returncode,
                "output": (checked.stdout + checked.stderr)[-8000:],
            })
            if checked.returncode != 0:
                return self._finish(
                    RemediationResult(run_id, "failed", branch, str(worktree), changed, validation_results, f"Validation failed: {command}"),
                    patch=patch_result.stdout,
                )

        return self._finish(
            RemediationResult(run_id, "validated", branch, str(worktree), changed, validation_results),
            patch=patch_result.stdout,
        )

    def _run(self, args: list[str], cwd: Path, **kwargs) -> CommandResult:
        result = self.runner.run(args, cwd, **kwargs)
        if result.returncode != 0 and args[:2] == ["git", "status"]:
            raise RuntimeError(result.stderr or result.stdout or "git status failed")
        return result

    def _build_patch(self, worktree: Path, status_output: str) -> CommandResult:
        tracked = self._run(["git", "diff", "--binary", "--no-ext-diff", "HEAD"], worktree)
        if tracked.returncode != 0:
            return tracked
        parts = [tracked.stdout]
        for path in self._untracked_paths(status_output):
            added = self._run(["git", "diff", "--binary", "--no-index", "--", "NUL" if os.name == "nt" else "/dev/null", path], worktree)
            if added.returncode not in {0, 1}:
                return added
            parts.append(added.stdout)
        return CommandResult(args=["git", "diff", "combined"], returncode=0, stdout="".join(parts))

    @staticmethod
    def _changed_paths(output: str) -> list[str]:
        paths: list[str] = []
        for line in output.splitlines():
            if len(line) < 4:
                continue
            path = line[3:].strip()
            if " -> " in path:
                path = path.rsplit(" -> ", 1)[1]
            paths.append(path.strip('"'))
        return paths

    @staticmethod
    def _untracked_paths(output: str) -> list[str]:
        return [
            line[3:].strip().strip('"')
            for line in output.splitlines()
            if line.startswith("?? ") and len(line) >= 4
        ]

    @staticmethod
    def _is_forbidden(path: str, patterns: tuple[str, ...]) -> bool:
        normalized = path.replace("\\", "/").lstrip("./")
        segments = normalized.split("/")
        candidates = [normalized, *segments]
        return any(fnmatch.fnmatch(candidate, pattern) for candidate in candidates for pattern in patterns)

    def _finish(self, result: RemediationResult, patch: str = "") -> RemediationResult:
        root = self.state_root / "remediation"
        root.mkdir(parents=True, exist_ok=True)
        run_dir = root / result.run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        if patch:
            patch_path = run_dir / "changes.patch"
            patch_path.write_text(patch, encoding="utf-8")
            result.patch_path = str(patch_path)
        verification_path = run_dir / "VERIFICATION.txt"
        validation_lines = [
            f"- {item['command']}: exit {item['exit_code']}\n{item['output']}"
            for item in result.validations
        ]
        verification_path.write_text("\n".join([
            f"STATUS: {result.status}",
            f"BRANCH: {result.branch}",
            f"WORKTREE: {result.worktree}",
            f"CHANGED_PATHS: {', '.join(result.changed_paths) if result.changed_paths else '(none)'}",
            f"ERROR: {result.error or '(none)'}",
            "VALIDATIONS:",
            *(validation_lines or ["- (none)"]),
            "PUBLISHING: no commit, push, remote change, or pull request was performed",
            "",
        ]), encoding="utf-8")
        result.verification_path = str(verification_path)
        (run_dir / "result.json").write_text(result.to_json() + "\n", encoding="utf-8")
        (root / f"{result.run_id}.json").write_text(result.to_json() + "\n", encoding="utf-8")
        return result
