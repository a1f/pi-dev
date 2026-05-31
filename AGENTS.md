# AGENTS.md

Project-level instructions for pi when working inside this repository.

## What this repo is

`pi-dev` is where I develop and version my pi customizations: skills, agent
personas, tools, and TypeScript extensions. Pi runs inside this repo (host or
container) and edits its own configuration files in `.pi/` and `extensions/`.

## Project layout

```
.pi/
  settings.json     # pi settings (provider, extensions list, etc.)
  skills/           # capability packages (loaded on demand)
  agents/           # agent personas (sub-agent definitions)
extensions/         # TypeScript extensions (tools, event hooks, custom UI)
scripts/
  spawn.sh          # create worktree + launch pi (host or --docker)
  reap.sh           # list/remove worktrees
container/
  entrypoint.sh     # in-container boot: firewall, then gosu → pi
  init-firewall.sh  # iptables + ipset egress allowlist
Dockerfile          # node:22-slim + pi + firewall tooling
docker-compose.yml  # bind-mount + safety primitives + cap_add for NET_ADMIN
AGENTS.md           # this file
```

## Workflow

Features land via git worktrees, one branch / worktree / session at a time.
The main checkout (`~/dev/pi-dev`) stays on `main` and is never edited by an
agent run.

```sh
# Spin up a session for a feature
./scripts/spawn.sh feat-skill-foo            # host mode
./scripts/spawn.sh feat-skill-foo --docker   # containerized

# Clean up afterwards
./scripts/reap.sh                            # list
./scripts/reap.sh feat-skill-foo             # remove one
./scripts/reap.sh --merged                   # remove anything merged on origin/main
```

## Conventions for new work

- **Skills**: one directory per skill under `.pi/skills/<name>/SKILL.md`, with
  YAML frontmatter (`name`, `description`, optional `allowed-tools`). Keep
  each skill narrow.
- **Agents (sub-agent personas)**: one file per persona under
  `.pi/agents/<name>.md`.
- **Extensions**: one `.ts` file per extension under `extensions/`, registered
  in `.pi/settings.json` under `extensions`.
- **Prefer many small things over one big thing** — pi loads skills on demand
  via `/skill:<name>`, so adding more is cheap.

## What's intentionally not here yet

The `guardrails` extension (`.pi/extensions/guardrails/`, rules in
`.pi/guardrails.yaml`) is the first real customization — an in-VM safety net
over the agent's own tool calls. See the README for details.

Still coming later, as separate PRs:

- PR-flavored skills (babysit, comments, make-pr) wired to a scoped GitHub PAT
- More skills, agents, and extensions — built as needed, not preemptively

## Adding network destinations

If a tool you write needs egress to a host the firewall doesn't allow, edit
`container/init-firewall.sh` (the `ALLOWED_DOMAINS` array) and rebuild
the image — the next `--docker` run picks it up.
