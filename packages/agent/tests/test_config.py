from pathlib import Path

from contribbot_agent.config import load_config, save_default_config


def test_agent_config_round_trip(tmp_path: Path) -> None:
    path = tmp_path / "agent.json"
    assert save_default_config(path) == path
    config = load_config(path)
    assert config.interval_minutes == 1440
    assert config.mode == "report_only"


def test_missing_config_uses_safe_report_only_defaults(tmp_path: Path) -> None:
    config = load_config(tmp_path / "missing.json")
    assert config.enabled is True
    assert config.mode == "report_only"
    assert config.repos == []
