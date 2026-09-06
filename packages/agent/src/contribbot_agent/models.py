from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Observation(StrictModel):
    name: str
    ok: bool
    content: str
    error: str = ""


class PatrolSnapshot(StrictModel):
    repo: str
    created_at: str
    observations: list[Observation]
    knowledge: dict[str, str]

    @classmethod
    def create(cls, repo: str, observations: list[Observation], knowledge: dict[str, str]) -> "PatrolSnapshot":
        return cls(repo=repo, created_at=utc_now(), observations=observations, knowledge=knowledge)


Severity = Literal["critical", "high", "medium", "low", "info"]
Health = Literal["healthy", "attention", "critical", "unknown"]
SafetyLevel = Literal["auto", "confirm", "manual"]
ActionKind = Literal["read", "create_todo", "knowledge_proposal", "local_write", "public_write", "destructive"]
ActionStatus = Literal["proposed", "approved", "executing", "completed", "failed", "rejected", "skipped"]
RunStatus = Literal["queued", "observing", "analyzing", "investigating", "awaiting_confirmation", "executing", "verifying", "succeeded", "partial", "failed", "cancelled"]
KnowledgeAction = Literal["create", "append", "revise"]
InvestigationTool = Literal["pr_summary", "pr_review_comments", "actions_status", "issue_detail", "commit_detail", "compare_refs"]


class PatrolFinding(StrictModel):
    severity: Severity
    title: str
    evidence: str
    impact: str


class PatrolAction(StrictModel):
    kind: ActionKind
    title: str
    reason: str
    safety: SafetyLevel
    suggested_command: str

    @model_validator(mode="after")
    def enforce_safety_floor(self) -> "PatrolAction":
        if self.kind in {"create_todo", "knowledge_proposal", "public_write"} and self.safety == "auto":
            self.safety = "confirm"
        if self.kind == "destructive":
            self.safety = "manual"
        return self


class InvestigationRequest(StrictModel):
    tool: InvestigationTool
    reason: str
    pr_number: int | None = Field(default=None, ge=1)
    issue_number: int | None = Field(default=None, ge=1)
    sha: str | None = None
    base: str | None = None
    head: str | None = None

    @model_validator(mode="after")
    def validate_tool_arguments(self) -> "InvestigationRequest":
        if self.tool in {"pr_summary", "pr_review_comments", "actions_status"} and self.pr_number is None:
            raise ValueError(f"{self.tool} requires pr_number")
        if self.tool == "issue_detail" and self.issue_number is None:
            raise ValueError("issue_detail requires issue_number")
        if self.tool == "commit_detail" and not self.sha:
            raise ValueError("commit_detail requires sha")
        if self.tool == "compare_refs" and (not self.base or not self.head):
            raise ValueError("compare_refs requires base and head")
        return self


class ActionExecution(StrictModel):
    id: str
    kind: ActionKind
    title: str
    status: ActionStatus = "proposed"
    safety: SafetyLevel
    approved_at: str | None = None
    completed_at: str | None = None
    result: str = ""
    error: str = ""


class KnowledgeCandidate(StrictModel):
    target: str = Field(pattern=r"^[\w][\w.\-]*$")
    action: KnowledgeAction
    title: str
    rationale: str
    proposed_content: str


class PatrolAnalysis(StrictModel):
    health: Health
    summary: str
    findings: list[PatrolFinding]
    investigation_requests: list[InvestigationRequest] = Field(default_factory=list)
    actions: list[PatrolAction]
    knowledge_candidates: list[KnowledgeCandidate]
    knowledge_used: list[str] = Field(default_factory=list)


class TraceEvent(StrictModel):
    timestamp: str
    phase: Literal["observe", "analyze", "investigate", "plan", "act", "ask", "learn", "verify"]
    action: str
    status: Literal["started", "completed", "failed", "skipped", "pending"]
    detail: str

    @classmethod
    def create(cls, phase: str, action: str, status: str, detail: str) -> "TraceEvent":
        return cls(timestamp=utc_now(), phase=phase, action=action, status=status, detail=detail)


class PatrolRun(StrictModel):
    id: str
    repo: str
    status: RunStatus = "queued"
    started_at: str = Field(default_factory=utc_now)
    completed_at: str | None = None
    coverage_complete: bool = True
    investigation_rounds: int = 0
    error: str = ""


class PatrolResult(StrictModel):
    run: PatrolRun
    report: str
    analysis: PatrolAnalysis
    actions: list[ActionExecution]
    proposal_results: list[str]
    record_result: str

    @property
    def run_id(self) -> str:
        return self.run.id

    @property
    def action_results(self) -> list[str]:
        return [item.result or f"failed: {item.error}" for item in self.actions if item.status in {"completed", "failed"}]


class PatrolBatchResult(StrictModel):
    started_at: str = Field(default_factory=utc_now)
    completed_at: str | None = None
    projects: list[str]
    results: list[PatrolResult]
    failures: dict[str, str]


class AgentConfig(StrictModel):
    enabled: bool = True
    interval_minutes: int = Field(default=1440, ge=1)
    repos: list[str] = Field(default_factory=list)
    mode: Literal["report_only", "interactive"] = "report_only"
    backend: Literal["codex", "rules"] = "codex"
    max_investigation_rounds: int = Field(default=3, ge=0, le=10)
