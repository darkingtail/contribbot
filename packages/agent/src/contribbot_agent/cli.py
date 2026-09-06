from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Callable

from . import __version__
from .backend import Analyzer, CodexAnalyzer, RulesAnalyzer
from .config import load_config, save_default_config
from .executor import WorktreeExecutor
from .mcp_client import ContribbotMcpClient
from .models import KnowledgeCandidate, PatrolAction
from .orchestrator import PatrolAllRunner, batch_needs_attention, render_batch
from .patrol import PatrolRunner
from .scheduler import PatrolScheduler


def configure_console_encoding() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def add_backend_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--backend", choices=("codex", "rules"), default="codex")
    parser.add_argument("--model", help="Optional Codex model override.")
    parser.add_argument("--timeout", type=int, default=300, help="Codex analysis timeout in seconds.")
    parser.add_argument("--max-investigation-rounds", type=int, default=3)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="contribbot", description="Repository patrol agent for open-source maintenance.")
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(dest="command", required=True)

    patrol = commands.add_parser("patrol", help="Run one auditable repository patrol.")
    patrol.add_argument("repo", help='GitHub repository in "owner/repo" form.')
    add_backend_args(patrol)
    patrol.add_argument("--propose-knowledge", action="store_true")
    patrol.add_argument("--no-input", action="store_true")
    patrol.add_argument("--resume", metavar="RUN_ID", help="Resume pending actions from a recorded patrol Run without re-analyzing.")

    patrol_all = commands.add_parser("patrol-all", help="Patrol all tracked repositories sequentially.")
    patrol_all.add_argument("repos", nargs="*", help="Optional owner/repo list; defaults to project_list.")
    add_backend_args(patrol_all)

    schedule = commands.add_parser("patrol-schedule", help="Run configured patrols once or continuously.")
    schedule.add_argument("--once", action="store_true", help="Run one due patrol batch and exit.")
    schedule.add_argument("--config", help="Path to agent JSON config.")
    schedule.add_argument("--model", help="Optional Codex model override.")
    schedule.add_argument("--timeout", type=int, default=300)
    schedule.add_argument("--show-unchanged", action="store_true", help="Print batches even when no project needs attention.")

    init_config = commands.add_parser("init-config", help="Create an agent JSON config if missing.")
    init_config.add_argument("--config", help="Optional config path; defaults to ~/.contribbot/agent.json.")

    remediate = commands.add_parser("remediate", help="Let Codex modify an isolated worktree and validate it without publishing.")
    remediate.add_argument("repo_path", help="Path to a clean local Git repository root.")
    remediate.add_argument("--prompt", required=True, help="Implementation task for Codex.")
    remediate.add_argument("--base", default="HEAD", help="Git base ref for the worktree.")
    remediate.add_argument("--validate", action="append", default=[], help="Validation command; repeat for multiple commands.")
    remediate.add_argument("--timeout", type=int, default=900)
    return parser


def analyzer_factory(backend: str, model: str | None, timeout: int) -> Callable[[], Analyzer]:
    if backend == "rules":
        return RulesAnalyzer
    return lambda: CodexAnalyzer(model=model, timeout_seconds=timeout)


def confirm_knowledge(candidates: list[KnowledgeCandidate]) -> bool:
    print("\nKnowledge candidates:", file=sys.stderr)
    for candidate in candidates:
        print(f"- {candidate.action} {candidate.target}: {candidate.title}", file=sys.stderr)
    return input("Create these reviewable knowledge proposals? [y/N] ").strip().lower() in {"y", "yes"}


def confirm_action(action: PatrolAction) -> bool:
    print("\nRecommended action:", file=sys.stderr)
    print(f"- {action.title}", file=sys.stderr)
    print(f"  Reason: {action.reason}", file=sys.stderr)
    return input("Execute this action? [y/N] ").strip().lower() in {"y", "yes"}


async def run_patrol(args: argparse.Namespace) -> int:
    analyzer = analyzer_factory(args.backend, args.model, args.timeout)()
    runner = PatrolRunner(ContribbotMcpClient(), analyzer, args.max_investigation_rounds)
    if args.resume:
        result = await runner.resume(
            args.repo, args.resume, confirm_action=None if args.no_input else confirm_action,
        )
    else:
        result = await runner.run(
            args.repo,
            approve_knowledge=args.propose_knowledge,
            confirm_knowledge=None if args.no_input or args.propose_knowledge else confirm_knowledge,
            confirm_action=None if args.no_input else confirm_action,
        )
    print(result.report)
    print(f"\nRecorded patrol run: {result.run.id}", file=sys.stderr)
    return 0


async def run_patrol_all(args: argparse.Namespace) -> int:
    result = await PatrolAllRunner(
        analyzer_factory(args.backend, args.model, args.timeout), args.max_investigation_rounds
    ).run(args.repos or None)
    print(render_batch(result))
    return 1 if result.failures else 0


async def run_schedule(args: argparse.Namespace) -> int:
    from pathlib import Path
    config = load_config(Path(args.config) if args.config else None)
    factory = analyzer_factory(config.backend, args.model, args.timeout)
    scheduler = PatrolScheduler(config, factory)
    if args.once:
        result = await scheduler.run_once()
        if args.show_unchanged or batch_needs_attention(result):
            print(render_batch(result))
        return 0
    def display(result):
        if args.show_unchanged or batch_needs_attention(result):
            print(render_batch(result), flush=True)
    await scheduler.run_forever(display)
    return 0


def run_remediate(args: argparse.Namespace) -> int:
    from pathlib import Path

    print("Creating an isolated worktree. This command will not commit, push, or create a pull request.", file=sys.stderr)
    result = WorktreeExecutor().execute(
        Path(args.repo_path),
        args.prompt,
        base=args.base,
        validations=args.validate,
        timeout=args.timeout,
    )
    print(result.to_json())
    return 0 if result.status == "validated" else 1


def main() -> None:
    configure_console_encoding()
    args = build_parser().parse_args()
    try:
        if args.command == "patrol":
            raise SystemExit(asyncio.run(run_patrol(args)))
        if args.command == "patrol-all":
            raise SystemExit(asyncio.run(run_patrol_all(args)))
        if args.command == "patrol-schedule":
            raise SystemExit(asyncio.run(run_schedule(args)))
        if args.command == "init-config":
            from pathlib import Path
            print(save_default_config(Path(args.config) if args.config else None))
            raise SystemExit(0)
        if args.command == "remediate":
            raise SystemExit(run_remediate(args))
    except KeyboardInterrupt:
        print("Patrol cancelled.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as error:
        print(f"Patrol failed: {error}", file=sys.stderr)
        raise SystemExit(1)
