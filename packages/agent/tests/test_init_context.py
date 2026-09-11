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
