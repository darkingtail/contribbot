from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from collections.abc import Callable
from datetime import datetime

from .backend import Analyzer
from .investigator import Investigator
from .mcp_client import ContribbotMcpClient
from .models import (
    ActionExecution,
    KnowledgeCandidate,
    Observation,
    PatrolAction,
    PatrolResult,
    PatrolRun,
    PatrolSnapshot,
    TraceEvent,
    utc_now,
)
from .report import render_report


OBSERVATION_TOOLS = (
    "project_dashboard",
    "todo_list",
    "upstream_list",
    "actions_status",
    "security_overview",
    "knowledge_proposals",
)


class PatrolRunner:
    def __init__(self, mcp: ContribbotMcpClient, analyzer: Analyzer, max_investigation_rounds: int = 3) -> None:
        self.mcp = mcp
        self.analyzer = analyzer
        self.max_investigation_rounds = max_investigation_rounds

    async def run(
        self,
        repo: str,
        approve_knowledge: bool = False,
        confirm_knowledge: Callable[[list[KnowledgeCandidate]], bool] | None = None,
        confirm_action: Callable[[PatrolAction], bool] | None = None,
    ) -> PatrolResult:
        run = PatrolRun(id=self._run_id(), repo=repo)
        trace: list[TraceEvent] = []
        actions: list[ActionExecution] = []
        proposal_results: list[str] = []

        async with self.mcp:
            run.status = "observing"
            observations = await self._collect_observations(repo, trace)
            try:
                knowledge = await self.mcp.read_knowledge(repo)
                trace.append(TraceEvent.create("observe", "knowledge resources", "completed", f"Loaded {len(knowledge)} entries."))
            except Exception as error:
                knowledge = {}
                trace.append(TraceEvent.create("observe", "knowledge resources", "failed", str(error)))
            run.coverage_complete = all(item.ok for item in observations)

            snapshot = PatrolSnapshot.create(repo, observations, knowledge)
            run.status = "analyzing"
            analysis = await self._analyze(snapshot, trace)

            investigator = Investigator(self.mcp)
            for round_number in range(1, self.max_investigation_rounds + 1):
                new_evidence = await investigator.investigate(repo, analysis)
                if not new_evidence:
                    break
                run.status = "investigating"
                run.investigation_rounds = round_number
                snapshot.observations.extend(new_evidence)
                for item in new_evidence:
                    trace.append(TraceEvent.create("investigate", item.name, "completed" if item.ok else "failed", item.error or "Follow-up evidence collected."))
                run.status = "analyzing"
                analysis = await self._analyze(snapshot, trace, label=f"investigation round {round_number}")

            trace.append(TraceEvent.create("plan", "maintenance actions", "completed", f"Produced {len(analysis.actions)} actions."))
            actions = [
                ActionExecution(id=self._action_id(repo, item), kind=item.kind, title=item.title, safety=item.safety)
                for item in analysis.actions
            ]
            by_title = {item.title: item for item in actions}
            await self._execute_actions(repo, run, analysis.actions, actions, trace, confirm_action)

            candidates = analysis.knowledge_candidates
            should_propose = approve_knowledge
            if candidates and not should_propose and confirm_knowledge:
                run.status = "awaiting_confirmation"
                should_propose = confirm_knowledge(candidates)
            if candidates and should_propose:
                run.status = "executing"
                for candidate in candidates:
                    proposal_results.append(await self.mcp.call_tool("knowledge_propose_update", {
                        "repo": repo, "target": candidate.target, "action": candidate.action,
                        "source_type": "patrol", "source_ref": run.id, "title": candidate.title,
                        "rationale": candidate.rationale, "proposed_content": candidate.proposed_content,
                    }))
                trace.append(TraceEvent.create("learn", "knowledge proposals", "completed", f"Created {len(proposal_results)} proposals."))
            elif candidates:
                trace.append(TraceEvent.create("learn", "knowledge proposals", "skipped", "Candidates were not approved."))
            else:
                trace.append(TraceEvent.create("learn", "knowledge proposals", "skipped", "No durable knowledge candidate."))

            failed_actions = any(item.status == "failed" for item in actions)
            run.status = "partial" if failed_actions or not run.coverage_complete else "succeeded"
            run.completed_at = utc_now()
            report = render_report(run, snapshot, analysis, proposal_results, by_title)
            record_result = await self.mcp.call_tool("patrol_record", {
                "repo": repo,
                "run_id": run.id,
                "report": report,
                "snapshot_json": snapshot.model_dump_json(),
                "analysis_json": analysis.model_dump_json(),
                "trace_json": json.dumps([event.model_dump(mode="json") for event in trace], ensure_ascii=False),
                "run_json": run.model_dump_json(),
                "actions_json": json.dumps([item.model_dump(mode="json") for item in actions], ensure_ascii=False),
            })

        return PatrolResult(run=run, report=report, analysis=analysis, actions=actions, proposal_results=proposal_results, record_result=record_result)

    async def resume(
        self,
        repo: str,
        run_id: str,
        confirm_action: Callable[[PatrolAction], bool] | None = None,
    ) -> PatrolResult:
        async with self.mcp:
            stored = json.loads(await self.mcp.call_tool("patrol_run_get", {"repo": repo, "run_id": run_id}))
            run = PatrolRun.model_validate(stored["run"])
            if run.repo != repo or run.id != run_id:
                raise ValueError("Stored patrol Run identity does not match the requested repo/run_id.")
            snapshot = PatrolSnapshot.model_validate(stored["snapshot"])
            from .models import PatrolAnalysis
            analysis = PatrolAnalysis.model_validate(stored["analysis"])
            prior = {item.id: item for item in (ActionExecution.model_validate(value) for value in stored["actions"])}
            trace = [TraceEvent.model_validate(value) for value in stored["trace"]]
            actions = []
            for proposal in analysis.actions:
                action_id = self._action_id(repo, proposal)
                actions.append(prior.get(action_id) or ActionExecution(
                    id=action_id, kind=proposal.kind, title=proposal.title, safety=proposal.safety,
                ))
            trace.append(TraceEvent.create("plan", "resume patrol run", "started", run_id))
            await self._execute_actions(repo, run, analysis.actions, actions, trace, confirm_action, resume=True)
            failed_actions = any(item.status == "failed" for item in actions)
            run.status = "partial" if failed_actions or not run.coverage_complete else "succeeded"
            run.completed_at = utc_now()
            trace.append(TraceEvent.create("plan", "resume patrol run", "completed", run.status))
            report = render_report(run, snapshot, analysis, [], {item.title: item for item in actions})
            record_result = await self._record(run, snapshot, analysis, actions, trace, report)
        return PatrolResult(
            run=run, report=report, analysis=analysis, actions=actions,
            proposal_results=[], record_result=record_result,
        )

    async def _execute_actions(
        self,
        repo: str,
        run: PatrolRun,
        proposals: list[PatrolAction],
        actions: list[ActionExecution],
        trace: list[TraceEvent],
        confirm_action: Callable[[PatrolAction], bool] | None,
        resume: bool = False,
    ) -> None:
        for proposal, execution in zip(proposals, actions, strict=True):
            if execution.status in {"completed", "rejected"}:
                if resume:
                    trace.append(TraceEvent.create("act", proposal.title, "skipped", f"Already {execution.status}."))
                continue
            if proposal.kind != "create_todo":
                execution.status = "skipped" if proposal.safety == "auto" else "proposed"
                continue
            run.status = "awaiting_confirmation"
            execution.status = "proposed"
            if not confirm_action:
                execution.status = "skipped"
                trace.append(TraceEvent.create("ask", proposal.title, "skipped", "Interactive approval disabled."))
                continue
            if not confirm_action(proposal):
                execution.status = "rejected"
                trace.append(TraceEvent.create("ask", proposal.title, "skipped", "Maintainer rejected the action."))
                continue
            execution.status = "approved"
            execution.approved_at = utc_now()
            run.status = "executing"
            execution.status = "executing"
            trace.append(TraceEvent.create("act", proposal.title, "started", "Creating local todo."))
            try:
                create_result = await self.mcp.call_tool(
                    "todo_add", {"repo": repo, "text": proposal.title, "ref": execution.id}
                )
                run.status = "verifying"
                verification = await self.mcp.call_tool("todo_detail", {"repo": repo, "item": execution.id})
                if not verification.strip():
                    raise RuntimeError("Todo verification returned an empty result.")
                execution.result = f"{create_result}\nVerified todo: {execution.id}"
                execution.error = ""
                execution.status = "completed"
                execution.completed_at = utc_now()
                trace.append(TraceEvent.create("verify", proposal.title, "completed", f"Read back todo {execution.id}."))
            except Exception as error:
                execution.status = "failed"
                execution.error = str(error)
                execution.completed_at = utc_now()
                trace.append(TraceEvent.create("verify", proposal.title, "failed", str(error)))

    async def _record(self, run, snapshot, analysis, actions, trace, report) -> str:
        return await self.mcp.call_tool("patrol_record", {
            "repo": run.repo,
            "run_id": run.id,
            "report": report,
            "snapshot_json": snapshot.model_dump_json(),
            "analysis_json": analysis.model_dump_json(),
            "trace_json": json.dumps([event.model_dump(mode="json") for event in trace], ensure_ascii=False),
            "run_json": run.model_dump_json(),
            "actions_json": json.dumps([item.model_dump(mode="json") for item in actions], ensure_ascii=False),
        })

    async def _collect_observations(self, repo: str, trace: list[TraceEvent]) -> list[Observation]:
        config = await self._observe("repo_config", repo)
        observed = await asyncio.gather(*(self._observe(tool, repo) for tool in OBSERVATION_TOOLS))
        items = [config, *observed]
        for item in items:
            trace.append(TraceEvent.create("observe", item.name, "completed" if item.ok else "failed", item.error or "Observation collected."))
        return items

    async def _analyze(self, snapshot: PatrolSnapshot, trace: list[TraceEvent], label: str = "repository snapshot"):
        trace.append(TraceEvent.create("analyze", label, "started", snapshot.repo))
        analysis = await self.analyzer.analyze(snapshot)
        trace.append(TraceEvent.create("analyze", label, "completed", analysis.summary))
        return analysis

    async def _observe(self, tool: str, repo: str) -> Observation:
        arguments: dict[str, object] = {"repo": repo}
        if tool == "knowledge_proposals":
            arguments["status"] = "pending"
        try:
            return Observation(name=tool, ok=True, content=await self.mcp.call_tool(tool, arguments))
        except Exception as error:
            return Observation(name=tool, ok=False, content="", error=str(error))

    @staticmethod
    def _run_id() -> str:
        stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
        return f"{stamp}-{uuid.uuid4().hex[:6]}"

    @staticmethod
    def _action_id(repo: str, action: PatrolAction) -> str:
        identity = f"{repo}\0{action.kind}\0{action.title}".encode()
        return f"patrol-{hashlib.sha256(identity).hexdigest()[:12]}"
