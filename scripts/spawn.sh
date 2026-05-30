#!/usr/bin/env bash
# Spawn a pi session for a feature branch.
#
# Creates (or reattaches) a git worktree at ../pi-dev-worktrees/<branch>
# and launches pi inside it. Default mode runs pi on the host; pass --docker
# to run inside the isolation container instead.
#
# Usage:
#   ./scripts/spawn.sh <branch> [--docker | --host] [--no-firewall] [-- <pi args>]
#
# Examples:
#   ./scripts/spawn.sh feat-skill-foo
#   ./scripts/spawn.sh feat-skill-foo --docker
#   ./scripts/spawn.sh feat-skill-foo --docker --no-firewall   # debug only
#   ./scripts/spawn.sh feat-skill-foo -- --print "what does this repo do?"

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: spawn.sh <branch> [--docker | --host] [--no-firewall] [-- <pi args>]

Creates a git worktree at ../pi-dev-worktrees/<branch> and launches pi inside.

  --host          (default) Run pi on the host machine. Requires pi on PATH.
  --docker        Run pi inside the isolation container. Requires Docker.
  --no-firewall   (--docker only) Skip the egress allowlist init. ONLY for
                  debugging — container will have unrestricted internet.
  --              Everything after is forwarded to pi as additional CLI args.
  -h|--help       Show this message.
EOF
}

# --- git wrapper: neutralize attacker-controlled worktree config ----------
# Worktree-local git config is writable from inside the container (the agent
# can `git config core.hooksPath ./hooks` or set fsmonitor). Subsequent host
# git invocations on that worktree would execute the agent's code. Always
# pass -c flags that override the dangerous knobs.
git_safe() {
    git \
        -c core.hooksPath=/dev/null \
        -c core.fsmonitor= \
        -c protocol.file.allow=user \
        "$@"
}

# --- arg parsing -----------------------------------------------------------
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
NO_FIREWALL=false
PI_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --docker)       USE_DOCKER=true; shift ;;
        --host)         USE_DOCKER=false; shift ;;
        --no-firewall)  NO_FIREWALL=true; shift ;;
        --) shift; PI_ARGS=("$@"); break ;;
        -h|--help) usage; exit 0 ;;
        *) echo "spawn: unknown argument: $1" >&2; usage; exit 2 ;;
    esac
done

# --- branch name validation ------------------------------------------------
# Tightened to:
#   - require first char to be [A-Za-z0-9] (no leading `-` → blocks git
#     option-injection via something like `git worktree add -b -x …`)
#   - reject `..` segments anywhere (blocks path traversal out of
#     pi-dev-worktrees/)
#   - keep allowed set narrow: letters, digits, `._-` and `/` for nesting
if [[ ! "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
    echo "spawn: branch name '$BRANCH' is invalid" >&2
    echo "       (must start with alnum; allowed chars: A-Z a-z 0-9 . _ - /)" >&2
    exit 2
fi
if [[ "$BRANCH" == *..* ]] || [[ "$BRANCH" == */..* ]] || [[ "$BRANCH" == */.. ]] || [[ "$BRANCH" == ../* ]]; then
    echo "spawn: branch name '$BRANCH' contains a '..' segment (rejected)" >&2
    exit 2
fi

# --- path resolution -------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
HOST_DEV_DIR="$(cd -- "$REPO_ROOT/.." &>/dev/null && pwd)"
WORKTREES_DIR="$HOST_DEV_DIR/pi-dev-worktrees"
WORKTREE_PATH="$WORKTREES_DIR/$BRANCH"

if [[ ! -d "$REPO_ROOT/.git" && ! -f "$REPO_ROOT/.git" ]]; then
    echo "spawn: $REPO_ROOT is not a git checkout" >&2
    exit 1
fi

mkdir -p "$WORKTREES_DIR"

# --- worktree setup --------------------------------------------------------
if [[ -d "$WORKTREE_PATH" ]]; then
    echo "spawn: reattaching to existing worktree at $WORKTREE_PATH"
elif git_safe -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "spawn: branch $BRANCH exists, creating worktree from it"
    git_safe -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" "$BRANCH"
else
    echo "spawn: creating new branch $BRANCH off HEAD"
    git_safe -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WORKTREE_PATH"
fi

# --- .env: PARSE, don't source ---------------------------------------------
# Sourcing executes shell, which is RCE on host if the agent (RW on pi-dev/)
# plants a malicious .env. Parse strictly: only export VAR=value lines whose
# key matches a safe identifier shape.
if [[ -f "$REPO_ROOT/.env" ]]; then
    while IFS='=' read -r key value; do
        # strip surrounding whitespace
        key="${key#"${key%%[![:space:]]*}"}"
        key="${key%"${key##*[![:space:]]}"}"
        # skip blank lines and comments
        [[ -z "$key" || "$key" == \#* ]] && continue
        # strict identifier: uppercase + digits + underscore, must start with letter or _
        if [[ ! "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
            echo "spawn: .env: skipping non-identifier key '$key'" >&2
            continue
        fi
        # strip optional surrounding double-quotes from value (single literal layer)
        if [[ "$value" =~ ^\"(.*)\"$ ]]; then
            value="${BASH_REMATCH[1]}"
        elif [[ "$value" =~ ^\'(.*)\'$ ]]; then
            value="${BASH_REMATCH[1]}"
        fi
        export "$key=$value"
    done < "$REPO_ROOT/.env"
fi

# --- launch ---------------------------------------------------------------
if $USE_DOCKER; then
    if ! command -v docker >/dev/null 2>&1; then
        echo "spawn: docker not found on PATH; install Docker Desktop or use --host" >&2
        exit 127
    fi
    if ! docker compose version >/dev/null 2>&1; then
        echo "spawn: 'docker compose' subcommand not available" >&2
        exit 127
    fi

    # Ensure all bind-mount sources exist on host (compose errors if missing).
    # ~/.pi/agent/skills and extensions are RO-mounted into the container.
    if [[ ! -d "$HOME/.pi" ]]; then
        echo "spawn: creating $HOME/.pi (mount source needed; first-time setup)"
    fi
    mkdir -p "$HOME/.pi/agent/skills" "$HOME/.pi/agent/extensions"
    if [[ ! -f "$HOME/.gitconfig" ]]; then
        echo "spawn: creating empty $HOME/.gitconfig (mount source needed)"
        : > "$HOME/.gitconfig"
    fi

    # Force-zero PI_DISABLE_FIREWALL unless --no-firewall was explicitly
    # passed. Stops an inherited shell var from silently disabling the
    # firewall on every subsequent run.
    if $NO_FIREWALL; then
        DISABLE_FIREWALL=1
        echo "spawn: WARNING — --no-firewall passed; egress will be unrestricted"
    else
        DISABLE_FIREWALL=0
    fi

    echo "spawn: launching pi in Docker (branch=$BRANCH, worktree=$WORKTREE_PATH)"

    # --build so edits to Dockerfile / container/*.sh are picked up. Cached
    # layers make this near-free when nothing changed.
    # Env-var prefix assignments must be contiguous with `exec` — no comments
    # mid-block, or the line-continuation chain breaks and they don't propagate.
    HOST_PI_DEV="$REPO_ROOT" \
    HOST_WORKTREES_DIR="$WORKTREES_DIR" \
    WORKTREE_NAME="$BRANCH" \
    PI_UID="$(id -u)" \
    PI_GID="$(id -g)" \
    PI_DISABLE_FIREWALL="$DISABLE_FIREWALL" \
    exec docker compose \
        --project-directory "$REPO_ROOT" \
        -f "$REPO_ROOT/docker-compose.yml" \
        run --rm --build pi ${PI_ARGS[@]+"${PI_ARGS[@]}"}
else
    if $NO_FIREWALL; then
        echo "spawn: --no-firewall only applies to --docker mode (ignoring)" >&2
    fi
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
