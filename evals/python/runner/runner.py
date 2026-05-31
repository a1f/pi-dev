import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import yaml

from runner.checks_static import run_checks
from runner.types import Case, CaseResult, CheckResult
from runner.validator_agent import run_validator_agent


EVAL_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_ROOT = EVAL_ROOT / "fixture"
CASES_DIR = EVAL_ROOT / "cases"
RESULTS_DIR = EVAL_ROOT / "results"


def _load_case(path: Path) -> Case:
    raw: dict[str, Any] = yaml.safe_load(path.read_text())
    return Case(
        id=path.stem,
        path=path,
        prompt=str(raw["prompt"]).strip(),
        expected_files=tuple(raw.get("expected_files", ())),
        hard_checks=tuple(raw.get("rubric", {}).get("hard", ())),
        soft_checks=tuple(raw.get("rubric", {}).get("soft", ())),
        timeout_seconds=int(raw.get("timeout_seconds", 600)),
    )


def _make_sandbox(*, case_id: str) -> Path:
    sandbox = Path(tempfile.mkdtemp(prefix=f"pi-eval-{case_id}-"))
    # Copy the fixture (skip __pycache__, .git if any).
    shutil.copytree(
        FIXTURE_ROOT,
        sandbox,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache", ".mypy_cache"),
    )
    # Init git so we have a clean baseline to diff against.
    subprocess.run(["git", "init", "-q"], cwd=sandbox, check=True)
    subprocess.run(["git", "add", "-A"], cwd=sandbox, check=True)
    subprocess.run(
        ["git", "-c", "user.name=eval", "-c", "user.email=eval@local",
         "commit", "-q", "-m", "fixture baseline"],
        cwd=sandbox,
        check=True,
    )
    return sandbox


def _have_coder_cli() -> str | None:
    explicit = os.environ.get("PI_DEV_CODER_CLI")
    if explicit:
        return explicit if shutil.which(explicit) else None
    return "pi" if shutil.which("pi") else None


def _run_coder(*, sandbox: Path, case: Case) -> str | None:
    """Run pi non-interactively on the case prompt. Returns error string on failure."""
    cli = _have_coder_cli()
    if cli is None:
        return "no coder CLI on PATH (set PI_DEV_CODER_CLI or install pi)"
    try:
        subprocess.run(
            [cli, "--print"],
            cwd=sandbox,
            input=case.prompt,
            capture_output=True,
            text=True,
            timeout=case.timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return f"coder timed out after {case.timeout_seconds}s"
    return None


def _diff(*, sandbox: Path) -> str:
    result = subprocess.run(
        ["git", "diff", "HEAD"],
        cwd=sandbox,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout


def run_case(*, case: Case, keep_sandbox: bool) -> CaseResult:
    sandbox = _make_sandbox(case_id=case.id)
    err: str | None = None
    diff = ""
    static: tuple[CheckResult, ...] = ()
    judge: tuple[CheckResult, ...] = ()
    try:
        err = _run_coder(sandbox=sandbox, case=case)
        if err is None:
            diff = _diff(sandbox=sandbox)
            static = run_checks(sandbox=sandbox, names=case.hard_checks)
            judge = run_validator_agent(
                sandbox=sandbox,
                diff=diff,
                soft_checks=case.soft_checks,
                timeout_seconds=case.timeout_seconds,
            )
    finally:
        if not keep_sandbox:
            shutil.rmtree(sandbox, ignore_errors=True)
        else:
            print(f"  (sandbox kept at {sandbox})", file=sys.stderr)
    return CaseResult(
        case_id=case.id,
        diff=diff,
        static=static,
        judge=judge,
        error=err,
    )


def _write_result(*, result: CaseResult) -> None:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out = RESULTS_DIR / f"{result.case_id}.json"
    payload = {
        "case_id": result.case_id,
        "score": result.score,
        "total": result.total,
        "error": result.error,
        "static": [{"name": c.name, "passed": c.passed, "detail": c.detail} for c in result.static],
        "judge": [{"name": c.name, "passed": c.passed, "detail": c.detail} for c in result.judge],
        "diff": result.diff,
    }
    out.write_text(json.dumps(payload, indent=2))


def _print_summary(*, results: list[CaseResult]) -> None:
    print()
    print(f"{'CASE':<40} {'SCORE':<10} {'NOTES'}")
    print("-" * 80)
    for result in results:
        score_cell = f"{result.score}/{result.total}"
        notes = result.error or ""
        if not notes:
            failed = [c.name for c in (*result.static, *result.judge) if not c.passed]
            if failed:
                notes = "failed: " + ", ".join(failed)
        print(f"{result.case_id:<40} {score_cell:<10} {notes}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run pi-dev Python evals.")
    parser.add_argument("case", nargs="?", help="Case id (e.g. 01-add-priority-type). Omit for all.")
    parser.add_argument("--keep-sandbox", action="store_true", help="Leave temp dirs for debugging.")
    args = parser.parse_args()

    if args.case:
        case_paths = [CASES_DIR / f"{args.case}.yaml"]
    else:
        case_paths = sorted(CASES_DIR.glob("*.yaml"))

    if not case_paths:
        print("no cases found", file=sys.stderr)
        return 1

    results: list[CaseResult] = []
    for path in case_paths:
        if not path.exists():
            print(f"case not found: {path}", file=sys.stderr)
            return 1
        case = _load_case(path)
        print(f"\n=== {case.id} ===")
        result = run_case(case=case, keep_sandbox=args.keep_sandbox)
        _write_result(result=result)
        results.append(result)

    _print_summary(results=results)
    failed = sum(1 for r in results if r.score < r.total or r.error)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
