# Tasks lib — agent instructions

This is the test fixture for pi-dev's Python coding eval. Pi runs inside this
project per case to fulfil a PR-style request.

## Coding rules (Python 3.12+)

All edits must follow these. Static checks (mypy strict, ruff) and an
agentic validator score adherence — drift from any rule lowers the score.

- **Types**: every function/method has typed params + return. Modern syntax
  only: `list[T]`, `dict[K, V]`, `T | None` — never `List`, `Dict`, `Optional`.
- **File structure**:
  - All custom types / enums / dataclasses / Protocols → `types.py`
  - All constants → `constants.py` as `Final[T]`
  - `__init__.py` files stay empty
- **Dataclasses for structured data**: never return bare tuples; use a
  `@dataclass(frozen=True)` for multi-value returns.
- **Stateless methods → functions**. If a method doesn't use `self`,
  `@staticmethod` it; if it doesn't fit a class, leave it a module function.
- **Keyword-only args**: every function uses `*` as first param.
- **No mutable defaults**: `None` sentinel for optional mutable params.
- **Imports at top level**. No in-function imports. No `if TYPE_CHECKING:`.
- **Reuse existing helpers** instead of re-implementing. Grep before writing.
- **Comments**: one sentence WHY (non-obvious only). No "this function does X"
  comments. No `Args:`/`Returns:` blocks — type hints serve that.
- **Tests**: pytest only. Write tests first when adding features (TDD).
  Tests live in `tests/`, mirror source layout.
- **defaultdict for aggregation**, convert to `dict` before returning.

## Layout

```
src/tasks/
  __init__.py     # empty
  types.py        # Task, Project, TaskID
  constants.py    # DEFAULT_PAGE_SIZE, MAX_TAGS_PER_TASK, DB_PATH
  storage.py      # list_tasks, get_task, find_by_tag
  search.py       # search (returns a tuple — refactor target)
  cli.py          # main() command dispatcher
tests/
  test_storage.py
```

## How to run things

```sh
uv sync --extra dev      # or pip install -e ".[dev]"
ruff check .             # lint
mypy src                 # type check
pytest                   # tests
```
