#!/usr/bin/env bash
# Spawn a pi session for a feature branch.
#
# Creates (or reattaches) a git worktree at ../pi-dev-worktrees/<branch>
# and launches pi inside it. Default mode runs pi on the host; pass --docker
# to run inside the isolation container instead.
#
# Usage:
#   ./scripts/spawn.sh <branch> [--docker | --host] [-- <extra pi args>]
#
# Examples:
#   ./scripts/spawn.sh feat-skill-foo
#   ./scripts/spawn.sh feat-skill-foo --docker
#   ./scripts/spawn.sh feat-skill-foo -- --print "what does this repo do?"

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: spawn.sh <branch> [--docker | --host] [-- <pi args>]

Creates a git worktree at ../pi-dev-worktrees/<branch> and launches pi inside.

  --host     (default) Run pi on the host machine. Requires pi on PATH.
  --docker   Run pi inside the isolation container. Requires Docker.
  --         Everything after is forwarded to pi as additional CLI args.
  -h|--help  Show this message.
EOF
}

if [[ $# -lt 1 ]]; then
    usage
    exit 2
fi

case "$1" in
    -h|--help) usage; exit 0 ;;
esac

BRANCH="$1"
shift

USE_DOCKER=false
PI_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --docker) USE_DOCKER=true; shift ;;
        --host)   USE_DOCKER=false; shift ;;
        --) shift; PI_ARGS=("$@"); break ;;
        -h|--help) usage; exit 0 ;;
        *) echo "spawn: unknown argument: $1" >&2; usage; exit 2 ;;
    esac
done

# Validate branch name. Git is permissive but agents sometimes pass weird
# strings; reject anything that wouldn't make a sensible directory.
if [[ ! "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    echo "spawn: branch name '$BRANCH' contains invalid characters" >&2
    echo "       (allowed: letters, digits, dot, dash, underscore, slash)" >&2
    exit 2
fi

# Resolve paths off the script location, not $PWD, so spawn.sh works from
# anywhere.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
HOST_DEV_DIR="$(cd -- "$REPO_ROOT/.." &>/dev/null && pwd)"
WORKTREES_DIR="$HOST_DEV_DIR/pi-dev-worktrees"
WORKTREE_PATH="$WORKTREES_DIR/$BRANCH"

# Sanity check: the parent should be where worktrees can safely live.
if [[ ! -d "$REPO_ROOT/.git" && ! -f "$REPO_ROOT/.git" ]]; then
    echo "spawn: $REPO_ROOT is not a git checkout" >&2
    exit 1
fi

mkdir -p "$WORKTREES_DIR"

# Create the worktree, or reattach if it already exists.
if [[ -d "$WORKTREE_PATH" ]]; then
    echo "spawn: reattaching to existing worktree at $WORKTREE_PATH"
elif git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "spawn: branch $BRANCH exists, creating worktree from it"
    git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" "$BRANCH"
else
    echo "spawn: creating new branch $BRANCH off HEAD"
    git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WORKTREE_PATH"
fi

# Load .env (provider keys, optional GITHUB_TOKEN) if present.
if [[ -f "$REPO_ROOT/.env" ]]; then
    # shellcheck disable=SC1091
    set -a; . "$REPO_ROOT/.env"; set +a
fi

if $USE_DOCKER; then
    if ! command -v docker >/dev/null 2>&1; then
        echo "spawn: docker not found on PATH; install Docker Desktop or use --host" >&2
        exit 127
    fi
    if ! docker compose version >/dev/null 2>&1; then
        echo "spawn: 'docker compose' subcommand not available" >&2
        exit 127
    fi

    # Ensure the host's ~/.pi exists so the bind-mount doesn't fail on first
    # run (compose would error if the source dir is missing).
    mkdir -p "$HOME/.pi"

    # Ensure host ~/.gitconfig exists (read-only mount fails if source missing).
    if [[ ! -f "$HOME/.gitconfig" ]]; then
        echo "spawn: creating empty $HOME/.gitconfig (mount source needed)"
        : > "$HOME/.gitconfig"
    fi

    echo "spawn: launching pi in Docker (branch=$BRANCH, worktree=$WORKTREE_PATH)"

    # --build so edits to Dockerfile / container/*.sh are picked up. Cached
    # layers make this near-free when nothing changed.
    # Env-var prefix assignments must be contiguous with `exec` — no comments
    # mid-block, or the line-continuation chain breaks and they don't propagate.
    HOST_DEV_DIR="$HOST_DEV_DIR" \
    WORKTREE_NAME="$BRANCH" \
    PI_UID="$(id -u)" \
    PI_GID="$(id -g)" \
    exec docker compose \
        --project-directory "$REPO_ROOT" \
        -f "$REPO_ROOT/docker-compose.yml" \
        run --rm --build pi ${PI_ARGS[@]+"${PI_ARGS[@]}"}
else
    if ! command -v pi >/dev/null 2>&1; then
        cat >&2 <<EOF
spawn: pi not found on host PATH.

Install one of these ways on the host:
  curl -fsSL https://pi.dev/install.sh | sh
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent

Or pass --docker to use the containerized pi.
EOF
        exit 127
    fi

    echo "spawn: launching pi on host (branch=$BRANCH, worktree=$WORKTREE_PATH)"
    cd "$WORKTREE_PATH"
    exec pi ${PI_ARGS[@]+"${PI_ARGS[@]}"}
fi
