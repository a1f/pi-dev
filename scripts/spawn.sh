#!/usr/bin/env bash
# Spawn a pi session in a git worktree.
#
# Creates (or reattaches) a git worktree at ../pi-dev-worktrees/<branch>
# and execs pi inside it.
#
# Designed to run inside a dedicated dev VM (Proxmox or similar): the VM
# itself is the security boundary. See docs/vm-setup.md for VM hardening
# notes (egress allowlist, sysctls, non-root user).
#
# Usage:
#   ./scripts/spawn.sh <branch> [-- <pi args>]

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: spawn.sh <branch> [-- <pi args>]

Creates a git worktree at ../pi-dev-worktrees/<branch> and execs pi inside.

  --         Everything after is forwarded to pi as additional CLI args.
  -h|--help  Show this message.
EOF
}

# --- git wrapper: neutralize attacker-controlled worktree config -----------
# Pi can write to worktree-local git config; without these overrides a
# malicious core.hooksPath / core.sshCommand / core.editor / core.pager
# would execute on the operator's next `spawn.sh` or `reap.sh` invocation.
# Still relevant inside a single VM: keeps a compromised session from
# RCE-ing the operator's shell when they reap another session.
git_safe() {
    GIT_CONFIG_NOSYSTEM=1 \
    git \
        -c core.hooksPath=/dev/null \
        -c core.fsmonitor= \
        -c core.sshCommand=/bin/false \
        -c core.editor=/bin/false \
        -c core.pager=cat \
        -c core.askpass=/bin/false \
        -c credential.helper= \
        -c gpg.program=/bin/true \
        -c protocol.file.allow=user \
        "$@"
}

# --- arg parsing -----------------------------------------------------------
if [[ $# -lt 1 ]]; then
    usage
    exit 2
fi

case "$1" in -h|--help) usage; exit 0 ;; esac

BRANCH="$1"
shift

PI_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --) shift; PI_ARGS=("$@"); break ;;
        -h|--help) usage; exit 0 ;;
        *) echo "spawn: unknown argument: $1" >&2; usage; exit 2 ;;
    esac
done

# --- branch name validation ------------------------------------------------
# Must start with alnum (blocks leading `-` git-option-injection and `^..`
# traversal). No embedded `..` segments. Narrow allowed charset.
if [[ ! "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
    echo "spawn: branch name '$BRANCH' is invalid" >&2
    echo "       (must start with alnum; allowed chars: A-Z a-z 0-9 . _ - /)" >&2
    exit 2
fi
if [[ "$BRANCH" == *..* ]] || [[ "$BRANCH" == */..* ]] || [[ "$BRANCH" == */.. ]]; then
    echo "spawn: branch name '$BRANCH' contains a '..' segment (rejected)" >&2
    exit 2
fi

# --- path resolution -------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
WORKTREES_DIR="$(cd -- "$REPO_ROOT/.." &>/dev/null && pwd)/pi-dev-worktrees"
WORKTREE_PATH="$WORKTREES_DIR/$BRANCH"

if [[ ! -d "$REPO_ROOT/.git" && ! -f "$REPO_ROOT/.git" ]]; then
    echo "spawn: $REPO_ROOT is not a git checkout" >&2
    exit 1
fi

mkdir -p "$WORKTREES_DIR"

# --- worktree setup --------------------------------------------------------
existing_wt=$(git_safe -C "$REPO_ROOT" worktree list --porcelain \
    | awk -v branch="refs/heads/$BRANCH" '
        /^worktree /{ wt = substr($0, 10) }
        $1 == "branch" && $2 == branch { print wt; exit }
    ')

if [[ -d "$WORKTREE_PATH" ]]; then
    echo "spawn: reattaching to existing worktree at $WORKTREE_PATH"
elif [[ -n "$existing_wt" ]]; then
    echo "spawn: branch '$BRANCH' is already checked out at $existing_wt" >&2
    echo "       reap that worktree first or use a different branch name" >&2
    exit 1
elif git_safe -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "spawn: branch $BRANCH exists, creating worktree from it"
    git_safe -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" "$BRANCH"
else
    echo "spawn: creating new branch $BRANCH off HEAD"
    git_safe -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WORKTREE_PATH"
fi

# --- .env: PARSE, don't source ---------------------------------------------
# Sourcing executes shell — RCE if a session plants a malicious .env.
# Strict parser: only `^[A-Z_][A-Z0-9_]*=...` lines. Tolerates `export FOO=...`.
if [[ -f "$REPO_ROOT/.env" ]]; then
    while IFS='=' read -r key value; do
        key="${key#"${key%%[![:space:]]*}"}"
        key="${key%"${key##*[![:space:]]}"}"
        [[ -z "$key" || "$key" == \#* ]] && continue
        if [[ "$key" =~ ^export[[:space:]]+(.+)$ ]]; then
            key="${BASH_REMATCH[1]}"
            key="${key#"${key%%[![:space:]]*}"}"
            key="${key%"${key##*[![:space:]]}"}"
        fi
        if [[ ! "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
            echo "spawn: .env: skipping non-identifier key '$key'" >&2
            continue
        fi
        if [[ "$value" =~ ^\"(.*)\"$ ]]; then
            value="${BASH_REMATCH[1]}"
        elif [[ "$value" =~ ^\'(.*)\'$ ]]; then
            value="${BASH_REMATCH[1]}"
        fi
        value="${value%$'\r'}"
        export "$key=$value"
    done < "$REPO_ROOT/.env"
fi

# --- launch ----------------------------------------------------------------
if ! command -v pi >/dev/null 2>&1; then
    cat >&2 <<EOF
spawn: pi not found on PATH.

This script assumes you're running inside the dev VM with pi installed.
See docs/vm-setup.md for the install steps. Quick install:
  curl -fsSL https://pi.dev/install.sh | sh
EOF
    exit 127
fi

echo "spawn: launching pi (branch=$BRANCH, worktree=$WORKTREE_PATH)"
cd "$WORKTREE_PATH"
exec pi ${PI_ARGS[@]+"${PI_ARGS[@]}"}
