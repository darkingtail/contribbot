from __future__ import annotations

import json
from pathlib import Path

from .models import AgentConfig


def default_config_path() -> Path:
    return Path.home() / ".contribbot" / "agent.json"


def load_config(path: Path | None = None) -> AgentConfig:
    config_path = path or default_config_path()
    if not config_path.exists():
        return AgentConfig()
    return AgentConfig.model_validate(json.loads(config_path.read_text(encoding="utf-8")))


def save_default_config(path: Path | None = None) -> Path:
    config_path = path or default_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    if not config_path.exists():
        config_path.write_text(AgentConfig().model_dump_json(indent=2) + "\n", encoding="utf-8")
    return config_path
