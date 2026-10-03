from __future__ import annotations

import hashlib
import ipaddress
import json
import re
from typing import Any, Literal, TypeAlias
from urllib.parse import urlsplit

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, model_validator


RepositoryPlatform = Literal["github", "gitlab"]
RepositoryLike: TypeAlias = "RepositoryRef | str | dict[str, Any]"

_SEGMENT = re.compile(r"^[A-Za-z0-9_.-]+$")
_HOST = re.compile(r"^[A-Za-z0-9.-]+$")
_GIT_REMOTE = re.compile(r"^(?:git@|ssh://git@)", re.IGNORECASE)


def _reject_control_characters(value: str, *, label: str) -> None:
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
        raise ValueError(f"{label} contains a control character.")


def _reject_unsafe_path(path: str, *, label: str) -> None:
    if (
        "//" in path
        or "\\" in path
        or "%" in path
        or "?" in path
        or "#" in path
        or any(ord(char) < 0x20 or ord(char) == 0x7F for char in path)
        or any(part in {".", ".."} for part in path.split("/"))
    ):
        raise ValueError(f"{label} contains an unsafe path: {path}")


def normalize_instance(value: str) -> str:
    _reject_control_characters(value, label="Repository instance")
    raw = value.strip()
    if not raw:
        raise ValueError("Repository instance is required.")

    source = urlsplit(raw)
    if source.scheme not in {"http", "https"} or not source.netloc:
        raise ValueError(f"Repository instance must use http or https: {raw}")
    if "@" in source.netloc or "?" in raw or "#" in raw:
        raise ValueError("Repository instance cannot contain credentials, query, or fragment.")
    try:
        raw_hostname = source.hostname
        source.port
    except ValueError as error:
        raise ValueError(f"Invalid repository instance: {raw}") from error
    if not raw_hostname:
        raise ValueError(f"Invalid repository instance host: {raw}")

    _reject_unsafe_path(source.path, label="Repository instance")
    parsed = AnyHttpUrl(raw)
    hostname = parsed.host
    if not hostname or not _HOST.fullmatch(hostname):
        raise ValueError(f"Invalid repository instance host: {raw}")
    try:
        ipaddress.IPv4Address(hostname)
    except ipaddress.AddressValueError:
        pass
    else:
        if raw_hostname.lower() != hostname:
            raise ValueError(f"Non-canonical IPv4 repository instance host: {raw}")
    _reject_unsafe_path(parsed.path or "", label="Repository instance")
    instance = str(parsed).rstrip("/")
    if not instance.isascii():
        raise ValueError(f"Invalid repository instance: {raw}")
    public = {
        "github.com": "https://github.com",
        "gitlab.com": "https://gitlab.com",
    }.get(hostname)
    if public and instance != public:
        raise ValueError(f"Public repository instance must be its service root: {public}")
    return instance


def normalize_repository_path(platform: RepositoryPlatform, value: str) -> str:
    _reject_control_characters(value, label="Repository path")
    path = value.strip()
    if not path or path.startswith("/") or path.endswith("/"):
        raise ValueError("Repository path must be a non-empty relative path.")
    _reject_unsafe_path(path, label="Repository path")
    parts = path.split("/")
    if len(parts) < 2 or (platform == "github" and len(parts) != 2):
        raise ValueError(f"Invalid {platform} repository path: {value}")
    if any(not part or not _SEGMENT.fullmatch(part) for part in parts):
        raise ValueError(f"Invalid {platform} repository path: {value}")
    if parts[-1].endswith(".git"):
        raise ValueError("Repository path must not include a .git suffix.")
    return "/".join(parts)


def normalize_repository_values(
    platform: RepositoryPlatform,
    instance: str,
    path: str,
) -> tuple[RepositoryPlatform, str, str]:
    normalized_instance = normalize_instance(instance)
    if normalized_instance == "https://github.com" and platform != "github":
        raise ValueError("Repository platform github is required for https://github.com.")
    if normalized_instance == "https://gitlab.com" and platform != "gitlab":
        raise ValueError("Repository platform gitlab is required for https://gitlab.com.")
    return platform, normalized_instance, normalize_repository_path(platform, path)


class RepositoryRef(BaseModel):
    """Canonical repository identity shared with the schema v3 MCP server."""

    model_config = ConfigDict(extra="forbid")

    platform: RepositoryPlatform
    instance: str
    path: str

    @model_validator(mode="after")
    def normalize(self) -> "RepositoryRef":
        platform, instance, path = normalize_repository_values(
            self.platform,
            self.instance,
            self.path,
        )
        object.__setattr__(self, "platform", platform)
        object.__setattr__(self, "instance", instance)
        object.__setattr__(self, "path", path)
        return self

    def identity_key(self) -> str:
        return json.dumps(
            ["repository-key-v1", self.platform, self.instance, self.path],
            separators=(",", ":"),
        )

    def digest(self) -> str:
        return hashlib.sha256(self.identity_key().encode("utf-8")).hexdigest()

    def display(self) -> str:
        return f"{self.platform}://{self.instance.removeprefix('https://').removeprefix('http://')}/{self.path}"

    def web_url(self) -> str:
        return f"{self.instance}/{self.path}"

    def to_mcp(self) -> dict[str, str]:
        return self.model_dump(mode="json")


def _from_public_url(value: str) -> RepositoryRef:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"Unsupported repository URL: {value}")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Repository URL cannot contain credentials, query, or fragment.")
    try:
        hostname = parsed.hostname
    except ValueError as error:
        raise ValueError(f"Invalid repository URL: {value}") from error
    if hostname is None:
        raise ValueError(f"Invalid repository URL: {value}")
    hostname = hostname.lower()
    platform: RepositoryPlatform | None = {
        "github.com": "github",
        "gitlab.com": "gitlab",
    }.get(hostname)
    if platform is None:
        raise ValueError(
            "Self-hosted repository URLs must specify platform, instance, and path as an object."
        )
    instance = normalize_instance(f"{parsed.scheme}://{parsed.netloc}")
    return RepositoryRef(
        platform=platform,
        instance=instance,
        path=parsed.path.strip("/").removesuffix(".git"),
    )


def _from_ssh_url(value: str) -> RepositoryRef:
    match = re.match(
        r"^(?:git@([^:]+):|ssh://git@([^/]+)/)(.+)$",
        value,
        flags=re.IGNORECASE,
    )
    if not match:
        raise ValueError(f"Unsupported Git remote URL: {value}")
    hostname = (match.group(1) or match.group(2) or "").lower()
    platform: RepositoryPlatform | None = {
        "github.com": "github",
        "gitlab.com": "gitlab",
    }.get(hostname)
    if platform is None:
        raise ValueError(
            "Self-hosted Git remotes require an explicit RepositoryRef object."
        )
    return RepositoryRef(
        platform=platform,
        instance=f"https://{hostname}",
        path=(match.group(3) or "").removesuffix(".git"),
    )


def parse_repository(value: RepositoryLike) -> RepositoryRef:
    """Parse a user-facing repository value into the schema v3 identity."""

    if isinstance(value, RepositoryRef):
        return value
    if isinstance(value, dict):
        return RepositoryRef.model_validate(value)
    if not isinstance(value, str):
        raise ValueError("Repository must be a RepositoryRef object or a repository string.")

    _reject_control_characters(value, label="Repository input")
    input_value = value.strip()
    if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", input_value):
        return RepositoryRef(
            platform="github",
            instance="https://github.com",
            path=input_value,
        )
    if input_value.startswith(("http://", "https://")):
        return _from_public_url(input_value)
    if _GIT_REMOTE.match(input_value):
        return _from_ssh_url(input_value)
    raise ValueError(
        "Repository string must be GitHub owner/repo or a public repository URL; "
        "self-hosted repositories require a RepositoryRef object."
    )


def parse_repository_ref(value: Any) -> RepositoryRef:
    """Validate a canonical protocol identity without interpreting display text."""

    if isinstance(value, RepositoryRef):
        value = value.to_mcp()
    if not isinstance(value, dict):
        raise ValueError("Repository identity requires platform, instance, and path as an object.")
    repository = RepositoryRef.model_validate(value)
    if value != repository.to_mcp():
        raise ValueError("Repository identity is not canonical.")
    return repository


def repository_data_path(repository: RepositoryRef | dict[str, Any], root: str | None = None) -> str:
    from pathlib import Path

    base = Path(root).expanduser() if root else Path.home() / ".contribbot"
    return str(base / "projects" / "v1" / parse_repository_ref(repository).digest())
