import json
import os
import shutil
import subprocess
from pathlib import Path

from runner.types import CheckResult


VALIDATOR_PROMPT_TEMPLATE = """\
You are a strict Python code reviewer evaluating a pi coding-agent's diff against a fixture lib.

Project rules (Python 3.12+):
- Types/dataclasses → types.py. Constants (Final[T]) → constants.py. __init__.py empty.
- Modern type syntax only: list[T], dict[K, V], T | None. No typing.List/Dict/Optional.
- All functions have keyword-only args (* as first param). No mutable defaults.
- Reuse existing helpers; don't re-implement near-duplicates.
- Comments explain WHY, only when non-obvious. No "what" / restating-the-code comments.
- No giant functions with deep if/else trees — split into named helpers.
- Tests: pytest only, mirror source layout, tests pass.
- TDD: when adding a feature, tests should exist for the new behavior.

Read the diff and the surrounding code in this fixture. Run `rg` / `cat` as needed.
You may run `pytest`, `mypy src`, `ruff check .` to verify claims.

Score each rule on the rubric STRICTLY. If you can't verify, mark fail.

Rubric for this case:
{rubric}

Output format (single JSON object, nothing else):
{{
  "results": [
    {{"name": "<rubric_check_name>", "passed": true|false, "detail": "<one-line reason>"}},
    ...
  ]
}}
"""


def _have_validator_cli() -> str | None:
    """Prefer `pi` (dogfooding), fall back to `claude`. Env override wins."""
    explicit = os.environ.get("PI_DEV_VALIDATOR_CLI")
    if explicit:
        return explicit if shutil.which(explicit) else None
    for candidate in ("pi", "claude"):
        if shutil.which(candidate):
            return candidate
    return None


def run_validator_agent(
    *,
    sandbox: Path,
    diff: str,
    soft_checks: tuple[str, ...],
    timeout_seconds: int = 600,
) -> tuple[CheckResult, ...]:
    if not soft_checks:
        return ()

    cli = _have_validator_cli()
    if cli is None:
        return tuple(
            CheckResult(name=n, passed=False, detail="no validator CLI on PATH (pi or claude)")
            for n in soft_checks
        )

    rubric_text = "\n".join(f"- {check}" for check in soft_checks)
    prompt = VALIDATOR_PROMPT_TEMPLATE.format(rubric=rubric_text)
    diff_blob = f"\n\n--- BEGIN DIFF ---\n{diff}\n--- END DIFF ---\n"
    full_input = prompt + diff_blob

    try:
        result = subprocess.run(
            [cli, "--print"],
            cwd=sandbox,
            input=full_input,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return tuple(
            CheckResult(name=n, passed=False, detail="validator timed out") for n in soft_checks
        )

    stdout = result.stdout.strip()
    # Parse the validator's JSON. The validator may include surrounding text;
    # extract the first {...} block.
    start = stdout.find("{")
    end = stdout.rfind("}")
    if start < 0 or end < 0:
        return tuple(
            CheckResult(name=n, passed=False, detail=f"validator non-JSON output: {stdout[:200]}")
            for n in soft_checks
        )
    try:
        parsed = json.loads(stdout[start : end + 1])
    except json.JSONDecodeError as exc:
        return tuple(
            CheckResult(name=n, passed=False, detail=f"validator JSON parse: {exc}")
            for n in soft_checks
        )

    by_name = {item["name"]: item for item in parsed.get("results", [])}
    return tuple(
        CheckResult(
            name=name,
            passed=bool(by_name.get(name, {}).get("passed", False)),
            detail=str(by_name.get(name, {}).get("detail", "no verdict")),
        )
        for name in soft_checks
    )
