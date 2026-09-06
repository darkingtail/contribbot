from contribbot_agent.orchestrator import batch_needs_attention, parse_project_list, render_batch
from contribbot_agent.models import PatrolBatchResult


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
