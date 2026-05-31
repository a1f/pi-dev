import ast
import shutil
import subprocess
from pathlib import Path

from runner.types import CheckResult


def _run(*, cmd: list[str], cwd: Path, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def check_ruff(*, sandbox: Path) -> CheckResult:
    if not shutil.which("ruff"):
        return CheckResult(name="ruff", passed=False, detail="ruff not on PATH")
    result = _run(cmd=["ruff", "check", "."], cwd=sandbox)
    return CheckResult(
        name="ruff",
        passed=result.returncode == 0,
        detail=(result.stdout + result.stderr).strip()[:2000],
    )


def check_mypy(*, sandbox: Path) -> CheckResult:
    if not shutil.which("mypy"):
        return CheckResult(name="mypy", passed=False, detail="mypy not on PATH")
    result = _run(cmd=["mypy", "src"], cwd=sandbox)
    return CheckResult(
        name="mypy",
        passed=result.returncode == 0,
        detail=(result.stdout + result.stderr).strip()[:2000],
    )


def check_pytest(*, sandbox: Path) -> CheckResult:
    if not shutil.which("pytest"):
        return CheckResult(name="pytest", passed=False, detail="pytest not on PATH")
    result = _run(cmd=["pytest", "-q"], cwd=sandbox, timeout=300)
    return CheckResult(
        name="pytest",
        passed=result.returncode == 0,
        detail=(result.stdout + result.stderr).strip()[:2000],
    )


def check_keyword_only_args(*, sandbox: Path) -> CheckResult:
    """Every new function in src/ uses `*` to force keyword-only args."""
    violations: list[str] = []
    for py_path in (sandbox / "src").rglob("*.py"):
        if py_path.name == "__init__.py":
            continue
        try:
            tree = ast.parse(py_path.read_text())
        except SyntaxError as exc:
            violations.append(f"{py_path.name}: parse error: {exc}")
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            if node.name.startswith("_"):
                continue
            args = node.args
            non_kw_positional = [a.arg for a in args.args if a.arg not in {"self", "cls"}]
            if non_kw_positional and not args.kwonlyargs:
                violations.append(
                    f"{py_path.relative_to(sandbox)}:{node.lineno} {node.name} has positional args"
                )
    return CheckResult(
        name="keyword_only_args",
        passed=not violations,
        detail="\n".join(violations[:20]),
    )


def check_no_typing_legacy(*, sandbox: Path) -> CheckResult:
    """Reject `from typing import List/Dict/Optional/Tuple/Set/FrozenSet`."""
    legacy = {"List", "Dict", "Optional", "Tuple", "Set", "FrozenSet"}
    violations: list[str] = []
    for py_path in (sandbox / "src").rglob("*.py"):
        try:
            tree = ast.parse(py_path.read_text())
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "typing":
                bad = [n.name for n in node.names if n.name in legacy]
                if bad:
                    violations.append(
                        f"{py_path.relative_to(sandbox)}:{node.lineno} imports {bad} from typing"
                    )
    return CheckResult(
        name="no_typing_legacy",
        passed=not violations,
        detail="\n".join(violations[:20]),
    )


def check_init_empty(*, sandbox: Path) -> CheckResult:
    violations: list[str] = []
    for init in (sandbox / "src").rglob("__init__.py"):
        content = init.read_text().strip()
        if content and not all(line.startswith("#") for line in content.splitlines()):
            violations.append(str(init.relative_to(sandbox)))
    return CheckResult(
        name="init_empty",
        passed=not violations,
        detail=", ".join(violations),
    )


def check_constants_in_constants_py(*, sandbox: Path) -> CheckResult:
    """Module-level constants with `Final[T]` annotations should live in constants.py."""
    violations: list[str] = []
    for py_path in (sandbox / "src").rglob("*.py"):
        if py_path.name in {"constants.py", "__init__.py"}:
            continue
        try:
            tree = ast.parse(py_path.read_text())
        except SyntaxError:
            continue
        for node in tree.body:
            if not isinstance(node, ast.AnnAssign):
                continue
            ann = node.annotation
            label = ast.unparse(ann) if hasattr(ast, "unparse") else ""
            if "Final" in label:
                target = ast.unparse(node.target) if hasattr(ast, "unparse") else "?"
                violations.append(
                    f"{py_path.relative_to(sandbox)}:{node.lineno} {target}: {label}"
                )
    return CheckResult(
        name="constants_in_constants_py",
        passed=not violations,
        detail="\n".join(violations[:20]),
    )


def check_dataclasses_in_types_py(*, sandbox: Path) -> CheckResult:
    """@dataclass classes should live in types.py."""
    violations: list[str] = []
    for py_path in (sandbox / "src").rglob("*.py"):
        if py_path.name in {"types.py", "__init__.py"}:
            continue
        try:
            tree = ast.parse(py_path.read_text())
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            for dec in node.decorator_list:
                src = ast.unparse(dec) if hasattr(ast, "unparse") else ""
                if "dataclass" in src:
                    violations.append(
                        f"{py_path.relative_to(sandbox)}:{node.lineno} class {node.name}"
                    )
    return CheckResult(
        name="dataclasses_in_types_py",
        passed=not violations,
        detail="\n".join(violations[:20]),
    )


# Registry: check-name → callable
STATIC_CHECKS = {
    "ruff": check_ruff,
    "mypy": check_mypy,
    "pytest": check_pytest,
    "keyword_only_args": check_keyword_only_args,
    "no_typing_legacy": check_no_typing_legacy,
    "init_empty": check_init_empty,
    "constants_in_constants_py": check_constants_in_constants_py,
    "dataclasses_in_types_py": check_dataclasses_in_types_py,
}


def run_checks(*, sandbox: Path, names: tuple[str, ...]) -> tuple[CheckResult, ...]:
    results: list[CheckResult] = []
    for name in names:
        check = STATIC_CHECKS.get(name)
        if check is None:
            results.append(CheckResult(name=name, passed=False, detail="unknown check"))
            continue
        try:
            results.append(check(sandbox=sandbox))
        except subprocess.TimeoutExpired:
            results.append(CheckResult(name=name, passed=False, detail="check timed out"))
        except Exception as exc:
            results.append(CheckResult(name=name, passed=False, detail=f"check error: {exc}"))
    return tuple(results)
