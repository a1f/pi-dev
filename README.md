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
checklist .

## What you get

- **Worktree-per-feature**: each session works on its own branch in its own
  directory; `main` stays clean; multiple sessions can run in parallel.
- **`git_safe()` wrapper** for host-side git commands so a compromised
  session can't plant a hook in its worktree that fires when you `reap.sh`
  a sibling session.
- **Strict `.env` parser** (parse, don't source) so a malicious `.env` can't
  RCE the operator's shell on the next `spawn.sh`.
- **`guardrails` extension** — an in-VM safety net over pi's own tool calls
  (see below).

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
  settings.json       project-level pi config (provider, extensions list)
  skills/             project skills (loaded on /skill:name)
  agents/             agent personas
  guardrails.yaml     rules for the guardrails extension
extensions/           project TypeScript extensions
  guardrails/         in-VM tool-call safety net
AGENTS.md             project instructions pi reads at startup
docs/
  vm-setup.md         VM hardening checklist
.env.example          provider API key template
```

## What's NOT here

This is just the dev-loop scaffold. Coming as needs arise:

- More skills, agents, and extensions — the first, [`guardrails`](#the-guardrails-extension), has landed
- PR-flavored skills (babysit, comments, make-pr) + GitHub PAT wiring
- Pi `permissions.json` once you've watched pi run enough to know what to deny

## The `guardrails` extension

`extensions/guardrails/` (registered in `.pi/settings.json`) is a safety net
that intercepts pi's own tool calls and blocks the dangerous or protected
ones — reading secrets, overwriting generated files, and irreversible/outward
commands (force-push, remote/cloud deletes, `npm publish`). Every decision is
written to a `guardrails-log` session entry. Threat model: our own honest
mistakes, not prompt injection — the VM is the real boundary, so matching is
heuristic by design.

Rules live in `.pi/guardrails.yaml` (project) or `~/.pi/guardrails.yaml`
(global), with four buckets — `zeroAccessPaths`, `readOnlyPaths`,
`noDeletePaths`, `bashToolPatterns` — and a `mode` (`continue` = block and let
the agent adapt; `abort` = hard-stop the turn and notify you).

Develop it like any TypeScript:

```sh
npm install        # once
npm run typecheck  # tsc --noEmit (strict)
npm test           # node --test (pure core: match / rules / evaluate / feedback)
```

The pure policy core (`match.ts`, `rules.ts`, `evaluate.ts`) has no pi
dependency, so it's unit-tested without launching the agent; `adapter.ts` is
the only pi-coupled seam and `index.ts` wires it in.

## The `subagents` extension

`extensions/subagents/` (registered in `.pi/settings.json`) dispatches named
**personas** as headless child pi processes. The main agent — or you, via
`/agent <persona> <task>` — hands a persona a job; the child runs with its own
context and restricted tools (guardrails loaded too), streams progress into a
live grid dashboard, and posts its answer back into the conversation. Tools:
`agent_dispatch` (optionally `{ persona }`), `agent_status`, `agent_kill`,
`agent_continue`; commands `/agent`, `/agent-continue`, `/agent-log`. Every run
is logged to a per-run JSONL (`.pi/agent-logs/`) plus a session audit entry,
with a per-run timeout, a concurrency cap + FIFO queue, and orphan cleanup at
session start.

A **persona** is a markdown file in `.pi/agents/` — frontmatter (`name`,
`description`, `tools`, optional `model`) plus a system-prompt body.

### The `pr-lite` skill

`.pi/skills/pr-lite/` (run with `/skill:pr-lite <task>`) is the demo that ties
it together: it drives three bundled personas — `coder`, `reviewer`, `critic` —
through one already-scoped, low-risk PR. The coder self-TDDs the change, the
language gates run, a 3-reviewer panel plus a critic judge it, one fix round
lands, and it squashes to a single commit. The skill bundles what the personas
work against: the coding **rules** (`rules/design-principles.md`,
`typescript.md`, `tdd.md`), passed to each persona by absolute path, and a
**gate profile** (`gates/typescript.json` — `npm run typecheck` + `npm test`).
These are distinct from the guardrails above — guardrails are tool-permission
policy; these are coding standards the coder writes to and the panel judges
against.

Develop it like any TypeScript:

```sh
npm install        # once
npm run typecheck  # tsc --noEmit (strict)
npm test           # node --test (pure core: argv / events / personas / grid / queue / …)
```

The pure core (event parse, state reduce, argv build, persona parse, grid
render, the FIFO limiter) has no pi dependency and is unit-tested without
launching the agent; `index.ts` is the pi-coupled seam that wires it in.

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
