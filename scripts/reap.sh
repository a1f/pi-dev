#!/usr/bin/env bash
# Clean up pi-dev worktrees.
#
# Usage:
#   ./scripts/reap.sh                 # list worktrees with status
#   ./scripts/reap.sh <branch>        # remove one worktree (prompt if dirty)
#   ./scripts/reap.sh --merged        # remove worktrees whose branch is merged to origin/main
#   ./scripts/reap.sh --all           # remove all (prompts per branch)

set -euo pipefail

usage() {
    cat <<'EOF'
Usage: reap.sh [<branch> | --merged | --all | --list]

  no args / --list   List worktrees with dirty / merge status.
  <branch>           Remove that specific worktree + its branch (prompts if dirty).
  --merged           Remove any worktree whose branch is merged to origin/main.
  --all              Remove every worktree (prompts per branch).
  -h | --help        Show this message.
EOF
}

# --- git wrapper: neutralize attacker-controlled worktree config -----------
# Kept in sync with the wrapper in spawn.sh. Worktree-local git config is
# writable from inside the container; without these overrides a malicious
# core.hooksPath, core.sshCommand, core.editor, core.pager, etc. would
# trigger host RCE on the next host-side `git diff` / `worktree remove` etc.
# GIT_CONFIG_NOSYSTEM also drops /etc/gitconfig as defense-in-depth.
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

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
HOST_DEV_DIR="$(cd -- "$REPO_ROOT/.." &>/dev/null && pwd)"
WORKTREES_DIR="$HOST_DEV_DIR/pi-dev-worktrees"

ACTION="${1:---list}"

# Show help before any filesystem checks so reap.sh --help works pre-bootstrap.
case "$ACTION" in
    -h|--help) usage; exit 0 ;;
esac

if [[ ! -d "$WORKTREES_DIR" ]]; then
    echo "reap: no worktree directory at $WORKTREES_DIR (nothing to do)"
    exit 0
fi

is_dirty() {
    local wt="$1"
    [[ -d "$wt" ]] || return 1
    if ! git_safe -C "$wt" diff --quiet 2>/dev/null \
       || ! git_safe -C "$wt" diff --cached --quiet 2>/dev/null \
       || [[ -n "$(git_safe -C "$wt" ls-files --others --exclude-standard 2>/dev/null)" ]]; then
        return 0
    fi
    return 1
}

is_merged() {
    local branch="$1"
    git_safe -C "$REPO_ROOT" merge-base --is-ancestor "refs/heads/$branch" origin/main 2>/dev/null
}

list_worktrees() {
    printf '%-32s  %-10s  %-10s  %s\n' BRANCH DIRTY MERGED PATH
    while IFS= read -r line; do
        local wt_path="${line%% *}"
        # Path-prefix filter: only worktrees that are STRICTLY children of
        # $WORKTREES_DIR. The previous `grep -F` was a substring match and
        # would have matched a sibling like `pi-dev-worktrees-archive/foo`.
        [[ "$wt_path" == "$WORKTREES_DIR"/* ]] || continue

        local branch dirty merged
        branch="$(git_safe -C "$wt_path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
        if [[ "$branch" == "HEAD" ]]; then
            # Detached HEAD: rev-parse returns the literal "HEAD". Treat as
            # detached so the "merged" check (which would have looked up
            # refs/heads/HEAD and silently said no) doesn't mislead.
            branch="(detached)"
            merged="n/a"
        else
            if is_merged "$branch"; then merged="yes"; else merged="no"; fi
        fi
        dirty="clean"
        if is_dirty "$wt_path"; then dirty="DIRTY"; fi
        printf '%-32s  %-10s  %-10s  %s\n' "$branch" "$dirty" "$merged" "$wt_path"
    done < <(git_safe -C "$REPO_ROOT" worktree list --porcelain \
                | awk '/^worktree /{print $2}')
}

remove_one() {
    local branch="$1"
    local wt_path="$WORKTREES_DIR/$branch"

    if [[ ! -d "$wt_path" ]]; then
        echo "reap: no worktree at $wt_path" >&2
        return 1
    fi

    if is_dirty "$wt_path"; then
        read -r -p "Worktree '$branch' has uncommitted changes. Remove anyway? [y/N] " confirm
        case "$confirm" in
            y|Y|yes) git_safe -C "$REPO_ROOT" worktree remove --force "$wt_path" ;;
            *)       echo "reap: skipped $branch"; return 0 ;;
        esac
    else
        git_safe -C "$REPO_ROOT" worktree remove "$wt_path"
    fi

    # Best-effort branch delete. Silence stderr so the case "branch is
    # currently checked out elsewhere" doesn't spam — the worktree is gone,
    # which is what reap is here for.
    if git_safe -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
        git_safe -C "$REPO_ROOT" branch -D "$branch" >/dev/null 2>&1 || true
    fi

    echo "reap: removed $branch"
}

case "$ACTION" in
    --list|"") list_worktrees ;;
    --merged)
        git_safe -C "$REPO_ROOT" fetch --quiet origin || true
        for wt_path in "$WORKTREES_DIR"/*/; do
            [[ -d "$wt_path" ]] || continue
            branch="$(basename "$wt_path")"
            if is_merged "$branch"; then
                if is_dirty "$wt_path"; then
                    echo "reap: skipping '$branch' (merged but dirty — pass '$branch' explicitly to confirm)"
                    continue
                fi
                remove_one "$branch"
            fi
        done
        ;;
    --all)
        for wt_path in "$WORKTREES_DIR"/*/; do
            [[ -d "$wt_path" ]] || continue
            branch="$(basename "$wt_path")"
            read -r -p "Remove worktree '$branch'? [y/N] " confirm
            case "$confirm" in
                y|Y|yes) remove_one "$branch" ;;
                *) echo "reap: skipped $branch" ;;
            esac
        done
        ;;
    *) remove_one "$ACTION" ;;
esac
