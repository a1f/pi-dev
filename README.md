# pi-dev

A development environment for [pi](https://pi.dev) — Mario Zechner's
open-source coding-agent harness. This repo holds my pi skills, sub-agents,
tools, and extensions, plus a git-worktree workflow for developing them
inside a dedicated dev VM.

## Trust model

A persistent VM (Proxmox / similar) is the security boundary. Pi runs inside
the VM as your normal user; sessions share the VM, share `~/.pi`, share
provider credentials. If you want session-level isolation, run pi via
bubblewrap/nsjail/firejail inside the VM — not in scope here.

Egress allowlisting, sysctl hardening, and non-root-user setup live on the
VM, not in this repo. See [`docs/vm-setup.md`](docs/vm-setup.md) for the
checklist.

## What you get

- **Worktree-per-feature**: each session works on its own branch in its own
  directory; `main` stays clean; multiple sessions can run in parallel.
- **`git_safe()` wrapper** for host-side git commands so a compromised
  session can't plant a hook in its worktree that fires when you `reap.sh`
  a sibling session.
- **Strict `.env` parser** (parse, don't source) so a malicious `.env` can't
  RCE the operator's shell on the next `spawn.sh`.

## Prerequisites

- A dev VM (Debian/Ubuntu recommended), provisioned per `docs/vm-setup.md`
- `pi` on PATH inside the VM:
  ```sh
  curl -fsSL https://pi.dev/install.sh | sh
  # or
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  ```
- An authenticated pi — either `.env` with provider API keys, or run
  `/login` once on the VM (creds land in `~/.pi/agent/auth.json`)

## Quick start

```sh
# Inside the VM:
git clone https://github.com/a1f/pi-dev ~/dev/pi-dev
cd ~/dev/pi-dev
cp .env.example .env && $EDITOR .env   # if using API keys

./scripts/spawn.sh hello               # creates branch `hello`, runs pi
./scripts/reap.sh                      # list worktrees
./scripts/reap.sh hello                # remove worktree + branch
```

## How the worktree flow works

```
~/dev/
├── pi-dev/                       ← main checkout, never edited by sessions
│   └── .git/
└── pi-dev-worktrees/             ← sibling, created by spawn.sh
    ├── feat-x/                   ← one pi session per worktree
    └── bug-y/
```

`spawn.sh <branch>` runs `git worktree add ../pi-dev-worktrees/<branch>` and
then `exec pi` inside it. Multiple worktrees ↔ multiple terminals ↔
multiple parallel pi sessions, all sharing the VM's pi installation and
auth.

## Files

```
scripts/
  spawn.sh            create worktree + launch pi
  reap.sh             list / remove worktrees (--merged, --all)
.pi/
  settings.json       project-level pi config (provider, defaults)
  skills/             project skills (loaded on /skill:name)
  agents/             agent personas
extensions/           project TypeScript extensions
AGENTS.md             project instructions pi reads at startup
docs/
  vm-setup.md         VM hardening checklist
.env.example          provider API key template
```

## What's NOT here

This is just the dev-loop scaffold. Coming as needs arise:

- Actual skills, agents, extensions
- PR-flavored skills (babysit, comments, make-pr) + GitHub PAT wiring
- Pi `permissions.json` once you've watched pi run enough to know what to deny

## History

The repo previously included a Docker-based scaffold (Dockerfile,
docker-compose, iptables egress allowlist, gosu drop-from-root, etc.) for
running pi safely on a macOS host. With the move to a dedicated VM the
container layer became redundant — the VM is the boundary. The Docker
scaffold lives in git history at commit `dd7548a` if you ever need to
revive it.

## References

- [pi.dev](https://pi.dev) — official site + docs
- [earendil-works/pi](https://github.com/earendil-works/pi) — the harness source
- [disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code) — IndyDevDan's reference fork, source of extension patterns
