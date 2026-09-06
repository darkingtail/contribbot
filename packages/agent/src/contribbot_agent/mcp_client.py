from __future__ import annotations

import os
import shutil
from contextlib import AsyncExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


@dataclass(frozen=True)
class McpServerConfig:
    command: str
    args: list[str]
    cwd: str | None = None


def default_mcp_server() -> McpServerConfig:
    for parent in Path(__file__).resolve().parents:
        server_entry = parent / "packages" / "mcp" / "src" / "mcp" / "index.ts"
        tsx_entry = parent / "packages" / "mcp" / "node_modules" / "tsx" / "dist" / "cli.mjs"
        if server_entry.exists() and tsx_entry.exists():
            return McpServerConfig(
                command=shutil.which("node") or "node",
                args=[str(tsx_entry), str(server_entry)],
                cwd=str(parent),
            )

    return McpServerConfig(
        command=shutil.which("npx") or "npx",
        args=["-y", "contribbot-mcp@latest"],
    )


class ContribbotMcpClient:
    def __init__(
        self,
        config: McpServerConfig | None = None,
        max_content_chars: int = 16_000,
    ) -> None:
        self.config = config or default_mcp_server()
        self.max_content_chars = max_content_chars
        self._stack: AsyncExitStack | None = None
        self._session: ClientSession | None = None

    async def __aenter__(self) -> "ContribbotMcpClient":
        self._stack = AsyncExitStack()
        streams = await self._stack.enter_async_context(
            stdio_client(
                StdioServerParameters(
                    command=self.config.command,
                    args=self.config.args,
                    cwd=self.config.cwd,
                    env={**os.environ, "CONTRIBBOT_QUIET": "1"},
                )
            )
        )
        self._session = await self._stack.enter_async_context(
            ClientSession(streams[0], streams[1])
        )
        await self._session.initialize()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        if self._stack:
            await self._stack.aclose()
        self._stack = None
        self._session = None

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        session = self._require_session()
        result = await session.call_tool(name, arguments)
        text = "\n".join(
            block.text for block in result.content if hasattr(block, "text")
        ).strip()
        if result.isError:
            raise RuntimeError(text or f"MCP tool {name} failed.")
        return self._truncate(text)

    async def read_knowledge(self, repo: str) -> dict[str, str]:
        session = self._require_session()
        listed = await session.list_resources()
        prefix = f"knowledge://{repo}/"
        resources = [
            resource for resource in listed.resources if str(resource.uri).startswith(prefix)
        ]

        knowledge: dict[str, str] = {}
        for resource in resources:
            result = await session.read_resource(resource.uri)
            text = "\n".join(
                content.text for content in result.contents if hasattr(content, "text")
            ).strip()
            knowledge[str(resource.uri).removeprefix(prefix)] = self._truncate(text)
        return knowledge

    def _require_session(self) -> ClientSession:
        if not self._session:
            raise RuntimeError("MCP client is not connected.")
        return self._session

    def _truncate(self, value: str) -> str:
        if len(value) <= self.max_content_chars:
            return value
        omitted = len(value) - self.max_content_chars
        return f"{value[:self.max_content_chars]}\n\n[truncated {omitted} characters]"
