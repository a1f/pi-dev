# AGENTS.md

Project-level instructions for pi when working inside this repository.

## What this repo is

`pi-dev` is where I develop and version my pi customizations: skills, agent
personas, tools, and TypeScript extensions. Pi runs inside a dedicated dev
VM and edits its own configuration files in `.pi/` and `extensions/`.

## Project layout

```
.pi/
  settings.json     # pi settings (provider, extensions list, etc.)
  skills/           # capability packages (loaded on demand)
  agents/           # agent personas (sub-agent definitions)
  guardrails.yaml   # rules for the guardrails extension
extensions/         # TypeScript extensions (tools, event hooks, custom UI)
  guardrails/       # in-VM safety net over pi's own tool calls
scripts/
  spawn.sh          # create worktree + exec pi
  reap.sh           # list / remove worktrees
docs/
  vm-setup.md       # one-time VM hardening checklist
AGENTS.md           # this file
```

## Workflow

Features land via git worktrees, one branch / worktree / session at a time.
The main checkout (`~/dev/pi-dev`) stays on `main` and is never edited by a
running session.

```sh
./scripts/spawn.sh feat-skill-foo            # creates worktree + runs pi
./scripts/reap.sh                            # list
./scripts/reap.sh feat-skill-foo             # remove
./scripts/reap.sh --merged                   # remove anything merged on origin/main
```

## Conventions for new work

- **Skills**: one directory per skill under `.pi/skills/<name>/SKILL.md`,
  with YAML frontmatter (`name`, `description`, optional `allowed-tools`).
  Keep each skill narrow.
- **Agents (sub-agent personas)**: one file per persona under
  `.pi/agents/<name>.md`.
- **Extensions**: a `.ts` file, or a directory with an `index.ts`, under
  `extensions/`, registered in `.pi/settings.json` under `extensions`
  (e.g. `extensions/guardrails`). TypeScript is typechecked with `npm run
  typecheck` and tested with `npm test`.
- **Prefer many small things over one big thing** — pi loads skills on demand
  via `/skill:<name>`, so adding more is cheap.

## Trust model

The VM is the security boundary. Pi runs as the operator's user; all
sessions share `~/.pi` and the provider credentials. The `git_safe()`
wrapper in `scripts/spawn.sh` and `scripts/reap.sh` keeps a compromised
session from RCE-ing the operator's shell when reaping a sibling session,
via planted hooks in worktree-local git config.

If you need stronger session-level isolation, run pi via
bubblewrap/nsjail/firejail inside the VM — out of scope for this repo.

## What's intentionally not here yet

The `guardrails` extension (`extensions/guardrails/`, rules in
`.pi/guardrails.yaml`) is the first real customization — an in-VM safety net
over pi's own tool calls; see the README. Still coming, as separate PRs:

- Pi permission/path-protection config (`.pi/permissions.json`)
- PR-flavored skills (babysit, comments, make-pr) wired to a scoped GitHub PAT
- More skills, agents, and extensions — built as needed, not preemptively
