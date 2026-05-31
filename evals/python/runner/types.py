from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Case:
    id: str
    path: Path
    prompt: str
    expected_files: tuple[str, ...]
    hard_checks: tuple[str, ...]
    soft_checks: tuple[str, ...]
    timeout_seconds: int = 600


@dataclass(frozen=True)
class CheckResult:
    name: str
    passed: bool
    detail: str = ""


@dataclass(frozen=True)
class CaseResult:
    case_id: str
    diff: str
    static: tuple[CheckResult, ...]
    judge: tuple[CheckResult, ...]
    error: str | None = None

    @property
    def score(self) -> int:
        return sum(1 for c in (*self.static, *self.judge) if c.passed)

    @property
    def total(self) -> int:
        return len(self.static) + len(self.judge)


@dataclass(frozen=True)
class RunSummary:
    cases: tuple[CaseResult, ...] = field(default_factory=tuple)
