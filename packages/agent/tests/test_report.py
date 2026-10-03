from contribbot_agent.models import PatrolAnalysis, PatrolRun, PatrolSnapshot
from contribbot_agent.report import render_report
from contribbot_agent.repository import parse_repository


def test_report_preserves_inline_code_in_suggested_steps() -> None:
    snapshot = PatrolSnapshot.create("owner/repo", [], {})
    analysis = PatrolAnalysis.model_validate(
        {
            "health": "attention",
            "summary": "Inspect maintenance automation.",
            "findings": [],
            "actions": [
                {
                    "kind": "read",
                    "title": "Inspect workflows",
                    "reason": "No runs were found.",
                    "safety": "auto",
                    "suggested_command": "Inspect `.github/workflows/` without modifying it.",
                }
            ],
            "knowledge_candidates": [],
            "knowledge_used": ["ci-conventions"],
        }
    )

    run = PatrolRun(id="run-1", repo=parse_repository("owner/repo"), status="succeeded")
    report = render_report(run, snapshot, analysis, [])

    assert "Inspect `.github/workflows/` without modifying it." in report
    assert "`Inspect `.github/workflows/`" not in report
    assert "Knowledge used in this decision" in report
    assert "`ci-conventions`" in report
