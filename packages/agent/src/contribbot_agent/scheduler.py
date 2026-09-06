from __future__ import annotations

import asyncio
from collections.abc import Callable

from .models import AgentConfig, PatrolBatchResult
from .orchestrator import PatrolAllRunner


class PatrolScheduler:
    def __init__(self, config: AgentConfig, analyzer_factory: Callable, sleep=asyncio.sleep) -> None:
        self.config = config
        self.analyzer_factory = analyzer_factory
        self.sleep = sleep

    async def run_once(self) -> PatrolBatchResult:
        runner = PatrolAllRunner(self.analyzer_factory, self.config.max_investigation_rounds)
        return await runner.run(self.config.repos or None)

    async def run_forever(self, on_result: Callable[[PatrolBatchResult], None] | None = None) -> None:
        while self.config.enabled:
            result = await self.run_once()
            if on_result:
                on_result(result)
            await self.sleep(self.config.interval_minutes * 60)
