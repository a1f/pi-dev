// subagents: dispatch headless one-shot pi children from the parent session.
//
// Thin pi adapter over the tested core (runner.ts → argv.ts/events.ts). Both the
// `/agent` command (operator) and the `agent_dispatch` tool (the main agent) run a
// read-only child via pi.exec and inject its answer back into the conversation as a
// follow-up that triggers the parent's next turn. A persona dispatch also persists its
// conversation to a per-persona session file, so the `/agent-continue` command and
// `agent_continue` tool can resume that persona in a fresh child for a follow-up turn.

import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AUDIT_TYPE, COMMAND, CONTINUE_COMMAND, CONTINUE_TOOL, DASHBOARD_REFRESH_MS, DASHBOARD_WIDGET, DEFAULT_TIMEOUT_MS, KILL_TOOL, LABEL, LOG_COMMAND, RUNS_DIR, STATUS_TOOL, TAIL_LINES, TOOL } from "./constants.ts";
import { renderDashboard } from "./dashboard.ts";
import { pickLatestLogName, renderLogTail, type SubagentRunAudit } from "./log.ts";
import { loadPersonas, type Persona, resolveDispatch, splitFirstToken } from "./personas.ts";
import { createDashboardRefresher } from "./refresh.ts";
import { RunRegistry, renderRows } from "./registry.ts";
import { defaultRunId, formatReply, runAgent, type DispatchResult, type ExecLike, type LogWriter } from "./runner.ts";
import { sessionPathFor } from "./session.ts";

// The guardrails extension is a sibling dir (extensions/guardrails), resolved from this file's
// location so it is correct regardless of the parent session's cwd. Every spawned child loads it
// explicitly: `--no-extensions` only disables discovery, so the safety net must be passed by path.
const GUARDRAILS_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "..", "guardrails");

/** Whether a path exists and is accessible — the continue precondition that a prior session file is present. */
async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** A resolved continue request — the persona to resume — or a friendly reason it can't be resumed. */
type ContinueTarget = { ok: true; persona: Persona } | { ok: false; error: string };

/**
 * Resolve a continue request to a persona whose session is on disk, or a friendly reason it
 * can't resume: an unknown name, an unsafe name with no safe session path, or a persona that
 * was never dispatched (no session file yet). Shared by the agent_continue tool and the
 * /agent-continue command so both reject the same preconditions before any child is spawned.
 */
async function resolveContinueTarget(opts: { name: string; personas: readonly Persona[]; cwd: string }): Promise<ContinueTarget> {
	const { name, personas, cwd } = opts;
	const persona = personas.find((candidate) => candidate.name === name) ?? null;
	if (persona === null) return { ok: false, error: `no persona named '${name}'` };
	const session = sessionPathFor(cwd, persona.name);
	if (session === null) return { ok: false, error: `persona '${name}' has an unsafe name and cannot resume a session` };
	if (!(await pathExists(session))) return { ok: false, error: `no prior session for '${name}'; dispatch it first with /${COMMAND}` };
	return { ok: true, persona };
}

export default function (pi: ExtensionAPI): void {
	const exec: ExecLike = (command, args, options) => pi.exec(command, args, options);

	// The real log writer: the only fs in the dispatch path. Injected into runAgent,
	// which keeps logging best-effort and swallows any failure here.
	const writeLog: LogWriter = async (logPath, content) => {
		await mkdir(dirname(logPath), { recursive: true });
		await writeFile(logPath, content, "utf8");
	};

	// Live record of this session's dispatched runs, surfaced by the agent_status tool.
	const registry = new RunRegistry();

	// The most recent UI context seen by a dispatch, so the refresh timer can re-render between
	// handler calls. Null until the first dispatch; a no-UI context leaves refresh a no-op.
	let lastUiCtx: ExtensionContext | null = null;

	// Push the live grid dashboard of every tracked run into the footer, or clear it when there is
	// nothing to show. A no-op without a UI: the print/RPC contexts have no setWidget, so calling it
	// would throw. The widget always lands under one key so each refresh replaces the prior footer.
	const refresh = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const { personas } = loadPersonas(ctx.cwd);
		const width = process.stdout.columns ?? 80;
		const lines = renderDashboard({ records: registry.list(), personas, now: Date.now(), width });
		if (lines.length > 0) ctx.ui.setWidget(DASHBOARD_WIDGET, lines, { placement: "aboveEditor" });
		else ctx.ui.setWidget(DASHBOARD_WIDGET, undefined);
	};

	// One self-stopping timer per extension instance: it re-renders the dashboard on a cadence while
	// any run is live (so a running child's elapsed time animates even though exec is non-streaming)
	// and clears itself once every run has finished. poke() after each register/finish (re)starts it.
	const refresher = createDashboardRefresher({
		intervalMs: DASHBOARD_REFRESH_MS,
		isActive: () => registry.list().some((run) => run.status === "running"),
		onTick: () => {
			if (lastUiCtx !== null) refresh(lastUiCtx);
		},
	});

	// Track a run, dispatch the child (with its persona + guardrails), mark it finished, then
	// best-effort record it as a parent-session audit entry. Shared by the /agent command and the
	// agent_dispatch tool so tracking + logging + audit live in one place. The run is registered
	// synchronously before the first await — so an in-flight dispatch is observable as "running" —
	// and the same runId is threaded into runAgent so its log lines up. A persona (when matched)
	// supplies the child's tools/model/system prompt — null fields fall back to buildSpawnArgv's
	// defaults — and every child loads guardrails regardless. A persistence failure must never
	// break the dispatch.
	const dispatch = async (opts: { task: string; cwd: string; persona: Persona | null; ctx: ExtensionContext; continueSession?: boolean }): Promise<DispatchResult> => {
		const { task, cwd, persona, ctx, continueSession = false } = opts;
		lastUiCtx = ctx;
		const runId = defaultRunId();
		const startedAt = Date.now();
		// Wire kill to abort: registering onKill before the await keeps the in-flight run
		// observable as running, and aborting the controller cancels the child's exec.
		const controller = new AbortController();
		registry.register({ runId, task, startedAt, persona: persona?.name ?? null, onKill: () => controller.abort() });
		// Surface the run as a live card immediately, before the await blocks on the child, and start
		// the refresh timer so its elapsed time animates while the child runs.
		refresh(ctx);
		refresher.poke();
		// A persona owns one rolling per-persona session file: --session selects it and is what
		// drives resumption, so the first dispatch starts the conversation and a later dispatch
		// continues it. A persona-less dispatch stays session-free; an unsafe persona name yields
		// a null path → run without a session.
		const session = persona === null ? null : sessionPathFor(cwd, persona.name);
		if (session !== null) {
			// Defensively pre-create the sessions dir: pi mkdirs it under the default config, but a
			// session-dir override (PI_CODING_AGENT_SESSION_DIR / --session-dir / settings.sessionDir)
			// would not, and the first persist (openSync(path, "wx")) would then ENOENT and silently
			// break resumption. Best-effort, mirroring the runs-dir create in writeLog.
			try {
				await mkdir(dirname(session), { recursive: true });
			} catch {
				// Swallow: a failed pre-create must never derail the dispatch; pi may still create it.
			}
		}
		const result = await runAgent(task, exec, {
			timeoutMs: DEFAULT_TIMEOUT_MS,
			cwd,
			writeLog,
			runId,
			signal: controller.signal,
			extensions: [GUARDRAILS_EXTENSION],
			tools: persona?.tools ?? undefined,
			model: persona?.model ?? undefined,
			// An empty/whitespace-only persona body trims to "" upstream; map it to undefined so
			// buildSpawnArgv omits --system-prompt and the child keeps its default, rather than
			// emitting `--system-prompt ""` and replacing that default with nothing. The continue
			// path applies it too: pi rebuilds the system prompt from this flag at every start and
			// never restores one from the session, so re-sending the persona prompt is required to
			// keep the resumed turn in-persona — it is not duplicated into the conversation history.
			systemPrompt: persona?.systemPrompt || undefined,
			session: session ?? undefined,
			continueSession,
		});
		registry.finish({ runId, status: result.ok ? "done" : "error", state: result.state, finishedAt: Date.now() });
		// Flip the card from running to done/error now the run has terminated; poke lets the timer
		// self-stop on its next tick once this was the last running run.
		refresh(ctx);
		refresher.poke();
		if (result.runId !== null && result.logPath !== null) {
			// Project the run outcome onto the persisted audit shape; the annotation keeps
			// this literal pinned to SubagentRunAudit (the single source of the record's shape).
			const audit: SubagentRunAudit = {
				runId: result.runId,
				task,
				ok: result.ok,
				exitCode: result.code,
				durationMs: result.durationMs,
				logPath: result.logPath,
				malformed: result.malformed,
			};
			try {
				pi.appendEntry(AUDIT_TYPE, audit);
			} catch {
				// Swallow: the run stands regardless of whether its audit persisted.
			}
		}
		return result;
	};

	pi.registerCommand(COMMAND, {
		description: "Dispatch a headless read-only subagent to perform <task>; its answer is injected as a follow-up.",
		handler: async (args, ctx) => {
			// A leading token matching a project persona selects it; the remainder is the task.
			// Surface persona-load warnings (a malformed file is skipped, never silently dropped),
			// mirroring the guardrails sibling's notify pattern, before resolving the dispatch.
			const { personas, warnings } = loadPersonas(ctx.cwd);
			for (const warning of warnings) ctx.ui.notify(`[${LABEL}] ${warning}`, "warning");
			const { persona, task } = resolveDispatch(args, personas);
			if (task === "") {
				ctx.ui.notify(`[${LABEL}] usage: /${COMMAND} [persona] <task>`, "warning");
				return;
			}
			const result = await dispatch({ task, cwd: ctx.cwd, persona, ctx });
			pi.sendUserMessage(formatReply(task, result), { deliverAs: "followUp" });
		},
	});

	pi.registerCommand(CONTINUE_COMMAND, {
		description: "Resume a persona subagent's prior session with a follow-up <task>; its answer is injected as a follow-up.",
		handler: async (args, ctx) => {
			// The first token names the persona to resume; the remainder is the follow-up task —
			// the same `/agent [head] rest` grammar resolveDispatch uses, via shared splitFirstToken.
			const { head: name, rest: task } = splitFirstToken(args);
			if (name === "" || task === "") {
				ctx.ui.notify(`[${LABEL}] usage: /${CONTINUE_COMMAND} <persona> <task>`, "warning");
				return;
			}
			const { personas, warnings } = loadPersonas(ctx.cwd);
			for (const warning of warnings) ctx.ui.notify(`[${LABEL}] ${warning}`, "warning");
			const target = await resolveContinueTarget({ name, personas, cwd: ctx.cwd });
			if (!target.ok) {
				ctx.ui.notify(`[${LABEL}] ${target.error}`, "warning");
				return;
			}
			const result = await dispatch({ task, cwd: ctx.cwd, persona: target.persona, ctx, continueSession: true });
			pi.sendUserMessage(formatReply(task, result), { deliverAs: "followUp" });
		},
	});

	pi.registerTool({
		name: TOOL,
		label: "Dispatch subagent",
		description: "Dispatch a headless read-only subagent to perform a task and return its final answer.",
		parameters: Type.Object({
			task: Type.String({ description: "The task for the subagent to perform." }),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const result = await dispatch({ task: params.task, cwd: ctx.cwd, persona: null, ctx });
			return { content: [{ type: "text", text: formatReply(params.task, result) }], details: result };
		},
	});

	pi.registerTool({
		name: CONTINUE_TOOL,
		label: "Continue subagent",
		description: "Resume a persona subagent's prior session with a follow-up task, answered with the context of its first run.",
		parameters: Type.Object({
			persona: Type.String({ description: "The persona whose session to resume (it must have been dispatched before)." }),
			task: Type.String({ description: "The follow-up task for the resumed subagent." }),
		}),
		execute: async (_toolCallId, { persona: name, task }, _signal, _onUpdate, ctx) => {
			const { personas } = loadPersonas(ctx.cwd);
			const target = await resolveContinueTarget({ name, personas, cwd: ctx.cwd });
			if (!target.ok) {
				return { content: [{ type: "text", text: target.error }], details: { ok: false, error: target.error } };
			}
			const result = await dispatch({ task, cwd: ctx.cwd, persona: target.persona, ctx, continueSession: true });
			return { content: [{ type: "text", text: formatReply(task, result) }], details: result };
		},
	});

	pi.registerTool({
		name: STATUS_TOOL,
		label: "Subagent status",
		description: "List this session's dispatched subagents with their live status.",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, _signal, _onUpdate, _ctx) => {
			const runs = registry.list();
			const text = runs.length === 0 ? "No subagent runs yet." : renderRows(runs, Date.now());
			return {
				content: [{ type: "text", text }],
				details: { runs: runs.map((run) => ({ runId: run.runId, task: run.task, status: run.status })) },
			};
		},
	});

	pi.registerTool({
		name: KILL_TOOL,
		label: "Kill subagent",
		description: "Abort a still-running dispatched subagent by run id.",
		parameters: Type.Object({
			runId: Type.String({ description: "The run id of the subagent to kill, as reported by agent_status." }),
		}),
		execute: async (_toolCallId, { runId }, _signal, _onUpdate, _ctx) => {
			const killed = registry.kill(runId);
			const text = killed ? `Killed subagent run ${runId}.` : `No running subagent with run id ${runId}.`;
			return { content: [{ type: "text", text }], details: { killed } };
		},
	});

	pi.registerCommand(LOG_COMMAND, {
		description: "Show the tail of the most recent subagent run log.",
		handler: async (_args, ctx) => {
			const runsDir = join(ctx.cwd, RUNS_DIR);
			let names: string[];
			try {
				names = await readdir(runsDir);
			} catch {
				// No runs dir yet (or unreadable): nothing to tail, and never throw.
				ctx.ui.notify(`[${LABEL}] no subagent runs yet`, "info");
				return;
			}
			const latest = pickLatestLogName(names);
			if (latest === null) {
				ctx.ui.notify(`[${LABEL}] no subagent runs yet`, "info");
				return;
			}
			try {
				const content = await readFile(join(runsDir, latest), "utf8");
				ctx.ui.notify(`[${LABEL}] ${latest}\n${renderLogTail(content, TAIL_LINES)}`, "info");
			} catch {
				ctx.ui.notify(`[${LABEL}] could not read run log ${latest}`, "warning");
			}
		},
	});
}
