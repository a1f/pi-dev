# Python coding eval

Local-only eval suite for pi's Python coding skill. Each "case" is a
PR-style task; the runner spawns pi in a sandboxed copy of the fixture
lib, captures the diff, then scores it with both automated checks AND an
agentic validator (a separate pi invocation acting as a strict reviewer).

Not wired to CI. Intended for ad-hoc local runs while iterating on the
coder skill.

## How a case runs

```
1. mktemp -d                                        # fresh sandbox per case
2. cp -r fixture/ <sandbox>/                        # known-good fixture state
3. git init + commit                                # baseline for diff
4. pi --print "<case prompt>"                       # coder agent runs to completion
5. git diff HEAD                                    # capture changes
6. run automated checks (ruff, mypy, pytest, AST)   # mechanical rules
7. spawn validator agent (pi --print) with rubric   # soft rules (slop, reuse, size)
8. write evals/python/results/<case>.json
9. rm -rf <sandbox>                                 # unless --keep-sandbox
```

## Run it

Inside the dev VM, with `pi` on PATH:

```sh
./run.sh                                    # all cases
./run.sh 01-add-priority-type               # single case
./run.sh --keep-sandbox 04-add-feature-reuse-existing
```

A different CLI for the coder or validator (e.g. `claude`) can be selected
via env:

```sh
PI_DEV_CODER_CLI=claude PI_DEV_VALIDATOR_CLI=claude ./run.sh 01-add-priority-type
```

Results land in `results/<case>.json` (gitignored). A summary table prints
at the end.

## Layout

```
evals/python/
├── README.md                # this file
├── run.sh                   # entrypoint wrapper
├── runner/
│   ├── runner.py            # orchestrator
│   ├── checks_static.py     # ruff / mypy / pytest / AST checks
│   ├── validator_agent.py   # spawns pi/claude as strict reviewer
│   └── types.py             # Case, CheckResult, CaseResult
├── fixture/                 # tasks lib pi operates on per case (copied to tmp)
│   ├── pyproject.toml
│   ├── AGENTS.md            # project rules pi reads at startup
│   ├── src/tasks/           # types.py, constants.py, storage.py, search.py, cli.py
│   └── tests/
├── cases/                   # 10 PR scenarios (currently 2; expand as you go)
│   ├── 01-add-priority-type.yaml
│   └── 04-add-feature-reuse-existing.yaml
└── results/                 # per-case JSON (gitignored)
```

## Case YAML schema

```yaml
prompt: |
  <the PR description pi receives>
expected_files:                        # informational; not enforced
  - src/tasks/types.py
timeout_seconds: 600
rubric:
  hard:                                # checked by checks_static.py
    - ruff
    - mypy
    - pytest
    - keyword_only_args
    - no_typing_legacy
    - init_empty
    - dataclasses_in_types_py
    - constants_in_constants_py
  soft:                                # judged by validator_agent.py
    - reused_existing_helper
    - no_slop_comments
    - reasonable_function_size
    - <whatever else this case cares about>
```

The validator agent reads the diff, runs the fixture's tools as needed
(pytest/ruff/mypy/rg), and emits a JSON verdict for each soft rule.

## Adding a new case

1. Pick the rule(s) you want to test
2. Plant temptation in the fixture if needed (e.g. a near-duplicate function
   pi should find and reuse, or a tuple-return pi should refactor)
3. Write `cases/NN-<slug>.yaml` with prompt + rubric
4. Run `./run.sh NN-<slug>` and inspect `results/NN-<slug>.json`

The fixture is small and shared across cases. Plant temptations
thoughtfully so cases don't interfere; if needed, add per-case patches in
`cases/NN-<slug>.patch` that the runner applies post-baseline (TODO when
needed).

## What this eval does NOT cover

- Multi-commit TDD ordering (we only check tests exist + pass in final state)
- Long-horizon multi-PR work (each case is single-shot)
- Cross-language polyglot diff editing (see Aider Polyglot for that)
- Real SWE-bench-style repo issues (separate, heavier eval)

This is the **rule-conformance** layer. Aider Polyglot and SWE-bench
subsets are appropriate follow-up layers.
