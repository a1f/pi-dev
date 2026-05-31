#!/usr/bin/env bash
# Local-only runner for the Python coding eval.
#
# Usage:
#   ./run.sh                     # all cases
#   ./run.sh 01-add-priority-type    # single case
#   ./run.sh --keep-sandbox 04-reuse-existing   # keep temp dir for inspection
#
# Requirements on the host where this runs (the VM):
#   - pi (or `claude`) on PATH for the coder + validator agents
#   - python 3.12, pytest, mypy, ruff (fixture tooling)
#   - PyYAML for the runner

set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$HERE"

export PYTHONPATH="$HERE:${PYTHONPATH:-}"
exec python -m runner.runner "$@"
