# pi-dev

A development environment for [pi](https://pi.dev) — Mario Zechner's open-source
coding-agent harness. This repo holds my pi skills, sub-agents, tools, and
extensions, plus a Docker + git-worktree workflow for developing them safely.

## What you get

- **Run pi two ways**: directly on the host for fast iteration, or in an
  isolated container for safe-yolo unattended runs. Same launcher.
- **Worktree-per-feature**: each session works on its own branch in its own
  directory; `main` stays clean; multiple sessions can run in parallel.
- **Safety baseline** for the container: non-root user, read-only root fs,
  dropped capabilities, no-new-privileges, resource limits, **egress firewall
  with an LLM/git/npm allowlist** (Anthropic-style iptables + ipset).

## Prerequisites

- **Host mode**: pi installed locally. One of:
  ```sh
  curl -fsSL https://pi.dev/install.sh | sh
  # or
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  ```
- **Docker mode**: Docker Desktop (≥ 24) with `docker compose`.
- **Either mode**: an authenticated pi. Two options, pick either:
  - **OAuth** (Claude Pro/Max, ChatGPT Plus/Pro, Copilot subscriptions) — run
    pi once on host and `/login`. Credentials land in `~/.pi/`, which
    Docker mode bind-mounts in so OAuth refresh keeps working.
  - **API keys** — copy `.env.example` to `.env` and fill in
    `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.

## Quick start

```sh
# If using API keys (skip if using OAuth):
cp .env.example .env
$EDITOR .env

# Either mode just works:
./scripts/spawn.sh hello                # creates branch `hello`, runs pi on host
./scripts/spawn.sh hello --docker       # same branch, runs pi in container
                                        # (your host ~/.pi mounts in so OAuth works)

# When done:
./scripts/reap.sh                       # list
./scripts/reap.sh hello                 # remove the worktree + branch
```

## How the worktree flow works

```
~/dev/
├── pi-dev/                       ← main checkout (this repo), never edited by agents
│   ├── Dockerfile, scripts/, ...
│   └── .git/
└── pi-dev-worktrees/             ← sibling, created on demand by spawn.sh
    ├── feat-x/                   ← branch feat-x, one pi session per worktree
    └── bug-y/                    ← branch bug-y, another session
```

`spawn.sh <branch>` runs `git worktree add ../pi-dev-worktrees/<branch>` and
then either `exec pi` (host) or `docker compose run pi` (with that worktree
bind-mounted at the same absolute path inside the container, so the
worktree's `.git` pointer resolves).

You can have several worktrees and several pi sessions alive at once — they
can't see each other, and merge conflicts go through normal git.

## Two modes side by side

| | Host mode (default) | Docker mode (`--docker`) |
|---|---|---|
| Speed | Native, no container overhead | ~1s startup cost per session |
| Filesystem reach | Anywhere your user can reach | Only the bind-mounted dev dir |
| Network reach | Whatever your host has | Egress allowlist only — LLM APIs, OAuth login, github.com, npmjs.org. Default deny. |
| Credentials | Your shell env + `~/.pi/` | `.env` (API keys) **and/or** host `~/.pi/` bind-mounted in (OAuth) |
| Killable | `pkill pi` | `docker kill` or just exit |
| Best for | Quick edits, when you trust the task | Unattended runs, exploratory yolo, anything you'd rather not have touch host state |

Switching modes mid-feature is fine — the worktree on host is the source of
truth either way.

## Network firewall (Docker mode)

The container starts as root, runs `container/init-firewall.sh` to apply an
iptables + ipset egress allowlist, then drops to the `pi` user via `gosu`.
After that, capabilities are gone — pi can make HTTPS calls but only to the
allowlisted destinations.

Default allowlist (see `container/init-firewall.sh` to extend):

- **LLM APIs**: Anthropic, OpenAI, Google, OpenRouter, DeepSeek, xAI, Mistral, Groq
- **OAuth flows**: auth.openai.com, chatgpt.com, console.anthropic.com, claude.ai
- **Git/GitHub**: github.com + api/codeload/objects/raw.githubusercontent.com
- **Packages**: registry.npmjs.org, pi.dev

Escape hatch:

```sh
PI_DISABLE_FIREWALL=1 ./scripts/spawn.sh feat-x --docker
```

If pi needs a new destination (a new provider, a docs site, a tool that
fetches from a CDN), add the domain to `ALLOWED_DOMAINS` in
`container/init-firewall.sh` and rebuild the image (next `--docker` run
will rebuild automatically if the file is in the build context).

## What's in this scaffold (and what isn't)

Included:

- `Dockerfile` — Node 22 base, pi installed globally, gh + git + ripgrep + firewall tooling, non-root `pi` user (UID matches host).
- `docker-compose.yml` — match-host-path bind mount, read-only root, cap-drop ALL + NET_ADMIN/NET_RAW for firewall init, no-new-privileges, tmpfs for ephemeral paths, resource caps.
- `container/entrypoint.sh` + `container/init-firewall.sh` — root-side boot: firewall, then `gosu` down to pi.
- `scripts/spawn.sh` — worktree creator + launcher (host default, `--docker` opt-in).
- `scripts/reap.sh` — list / remove worktrees, with merged-detection.
- `.pi/settings.json` — minimal pi config.
- `AGENTS.md` — project-level instructions pi reads at startup.

Deliberately not included yet (each will be its own follow-up):

- Pi permission/path-protection layer (`.pi/permissions.json`).
- PR-flavored skills (babysit, comments, make-pr) + GitHub PAT wiring.
- Any actual skills, agents, or extensions — those grow as needs arise.

## References

- [pi.dev](https://pi.dev) — official site + docs
- [earendil-works/pi](https://github.com/earendil-works/pi) — the harness source
- [disler/pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code) — IndyDevDan's reference fork; good cribbing source for extensions and patterns
- [Anthropic devcontainer pattern](https://code.claude.com/docs/en/sandboxing) — the inspiration for the safety baseline here
