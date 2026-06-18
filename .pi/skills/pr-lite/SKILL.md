---
name: pr-lite
description: Run on an already-scoped, low-risk single-module PR. Orchestrates the coder/reviewer/critic subagent personas — one self-TDD coder, the language gates, a 3-reviewer panel and a critic, squashed to one commit. Not for feature decomposition, multi-module planning, or high-risk work (filesystem/state mutation, destructive ops, merge/refcount, cutover) — route those to a full build.
---

# pr-lite

You orchestrate one already-scoped, low-risk PR to done by dispatching the project's subagent
personas: the **coder** builds it test-first, the **gates** run, a 3-**reviewer** panel and a
**critic** judge, you decide. You never write production code or tests yourself — the personas do.

## Dispatch mechanism (pi)

You drive the personas with the `subagents` extension's tools:
- `agent_dispatch({ task, persona })` — spawn `coder` / `reviewer` / `critic` (the personas in
  `.pi/agents/`) on a task. The child runs headless with that persona's tools + guardrails and
  returns its final answer — ending in a fenced ` ```json ` contract — as the tool result. Read and
  parse that last JSON block.
- `agent_status` lists live runs; `agent_kill({ runId })` stops one.
- A persona child **cannot ask you questions** — embed everything it needs IN its task string: the
  spec, the **base** ref, the **absolute** rule paths, the `mode`, and (for reviewer/critic) the
  evidence.

**Logging.** Every dispatch is already recorded for you: a per-run JSONL (events + argv/exit/
duration) under `.pi/agent-logs/`, plus an audit entry in this session; `/agent-log` tails the
latest. That on-disk trail is your audit record — and you also keep the live **status table**
(bottom) in the conversation, updated each step, as the human-readable run log.

## Runtime resolution

- **skill_root** — `<repo>/.pi/skills/pr-lite` (where this SKILL.md lives); it bundles the `rules/`
  and `gates/` this skill needs, so they travel with the skill.
- **rules_root** — `<skill_root>/rules`; pass rule files as **absolute** paths (a child's cwd is the
  repo, so a bare name won't resolve — use e.g. `"$(pwd)/.pi/skills/pr-lite/rules/typescript.md"`).
- **target_cwd** — the repo being changed; run every `git`/gate command there.
- **base** — user/spec-named → else `git merge-base HEAD origin/main` → else `… main` → else stop
  and ask.
- **gates** — `<skill_root>/gates/typescript.json` (this repo: `npm ci` setup, then
  `npm run typecheck` + `npm test`). A changed language with no profile → stop and report.
- **rules to pass** — always `design-principles.md`; `tdd.md` for behavioral work; `typescript.md`
  per changed `.ts` file.

## The personas

| Persona | Count | Job |
|---|---|---|
| `coder` | 1 (+ fix) | plan behaviors, self-TDD the whole PR, one commit |
| `reviewer` | 3 | the panel — each a focused lens-group |
| `critic` | 1 (+1 on `partial`) | goal-fit: did the PR achieve the task? |

Dispatch the **3 reviewers concurrently** (issue the three `agent_dispatch` calls together; the
extension runs them under its concurrency cap). **Then**, after they return, dispatch the
**critic** — it needs their findings. Each reviewer gets the base ref (it runs
`git diff <base>...HEAD` itself) and the absolute rule paths, with one lens-group emphasized (it
still reports any CRITICAL outside its group):
1. **correctness + security** — lenses `bug`, `security`.
2. **rules-conformance + test-form** — lenses `readability`, `test`.
3. **quality** — lens `quality` (simplicity/reuse).

The critic gets the task spec, task type (`behavioral` if any slice has a test, else
`non_behavioral`), base, diff, changed test files, the coder's per-behavior RED evidence, the green
gate output, and the reviewers' findings. Each reviewer finding carries a 1–100 `score` and a
`location`; the panel rules below gate on those.

## The loop

1. **Intake.** Restate goal, boundary/`allowed_paths`, interface or files, acceptance criteria,
   language(s), base, `dependencies_allowed`. Missing any → stop for re-scope. **High-risk set →
   recommend a full build and stop** (proceed only if the human confirms lite): filesystem/state
   mutation, destructive ops (delete, overwrite, restore), JSON/settings merge-and-unmerge,
   refcounting, content-hash/drift, or a cutover touching existing behavior. Start the status table.
2. **Preflight.** `git status --short` (dirty outside the boundary → stop). Run the gate `setup`
   once. If tests exist, run the test gate for a green baseline ("no tests yet" is neutral, never a
   final pass). A pre-existing, unrelated red → stop and report.
3. **Build.** `agent_dispatch({ persona: "coder", task })` with full context (goal, boundary,
   allowed_paths, interface, acceptance criteria, base, `dependencies_allowed`, absolute rule paths,
   `mode: build`). Read its returned JSON; require `status: done`, then verify:
   - each behavioral slice shows a **right-reason RED**: `behaviors[].red` has a nonzero exit and a
     `key_output` that is an assertion failure or a missing-symbol error naming the interface being
     added. A behavioral slice with `red: null` → route back.
   - the slice files reconcile: `union(behaviors[].files)` == `files_changed` ==
     `git diff --name-only <base>...HEAD`. Every **logic file** appears in at least one behavioral
     (`red ≠ null`) slice; a logic file only in `red: null` slices → route back, unless it's a pure
     rename/move (`git` `R100`). `red: null` slices otherwise carry only declared formats
     (json/md/yaml).
   - `new_dependencies` empty unless allowed/named → else route back.
   - `blocked` → decide (re-scope, re-dispatch, or stop).
   Max 2 build re-dispatches, then stop and report.
4. **Reproduce + gate (objective — before any judgment).** Re-run the full suite yourself on HEAD
   and route on its outcome; once green, run the gate profile (`setup` once, then each `gates[].run`
   in order). **All gates must pass before the panel.** Max 2 fix rounds here, then stop. The table
   is total:

   | Outcome | Action |
   |---|---|
   | suite green **and** every non-null `behaviors[].test` passes | run the gate profile |
   | suite red, or a new test missing/failing | `coder` `mode: fix` — behavioral regression |
   | a load error naming a missing dependency | run gate `setup` once, re-run; still missing → `mode: fix` if approved, else stop and report (scope) |
   | a load error naming a project module under change | `mode: fix` — build failure |
   | the `typecheck` gate red | `mode: fix` — mechanical |
   | the `test` gate red | `mode: fix` — behavioral regression |
   | any other gate red | `mode: fix` — mechanical; name the gate |
   | gate `setup` itself fails | stop and report (environment, not a coder bug) |

5. **Panel + critic (judgment — once, on the green diff).** Dispatch the 3 reviewers (concurrently),
   then the critic; read the returned JSON. Each finding's `score` is severity (1–100, higher =
   worse). **Deduplicate by `location`** (fall back to `(file:issue)` when a finding has no line),
   keeping the highest-scoring per location. Then block if any row fires:

   | Condition | Result |
   |---|---|
   | any finding CRITICAL, `score >= 70`, or a reviewer's `has_critical` | block |
   | summed `score` of `50–69` findings `>= 120` | block (findings `< 50` are advisory, never aggregate) |
   | critic verdict `not_achieved` | block |
   | critic verdict `partial` | dispatch one second critic; block only if it also returns `partial`/`not_achieved` |

   **CRITICAL, a red gate, and a black-letter language-rule violation are never waivable.** No
   blockers → **Done**.
6. **Fix once, re-verify in proportion.** Capture `<pre_fix> = git rev-parse HEAD`, then route all
   blockers back as one `agent_dispatch({ persona: "coder", task })` whose task names `mode: fix` and
   quotes the blockers **verbatim**. After it lands: **always** re-run the gates; re-review the fix with the reviewer(s)
   whose lens-group covers each routed blocker, passing `<pre_fix>` as the diff base
   (`git diff <pre_fix>...HEAD`); re-run the critic **only if** the fix changed behavior or coverage.
   One fix round (separate from step 4's budget); a second only if round 1 introduced a new blocker.
   Then Done, or escalate the remainder to the human as waive-or-rescope.
7. **Done.** All behaviors and gates green, no CRITICAL / `>=70` / aggregate blocker, critic
   `achieved`. **Squash to one commit:** `git reset --soft <base> && git commit -m "<conventional
   subject>"` (no AI attribution). Confirm only boundary files changed
   (`git diff --name-only <base>...HEAD`). Summarize, ask the human to confirm done — never push or
   open a PR unless asked.

## Status table

Keep a live table in the conversation, one row per behavior, plus a panel-scores line after step 5:

```
| B1 discount applies to subtotal | RED✓ | GREEN✓ | gate✓ | panel: 0 blockers |
```
