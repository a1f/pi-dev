// subagents: dispatch headless one-shot pi children from the parent session.
//
// Thin pi adapter over the tested core (runner.ts → argv.ts/events.ts). Both the
// `/agent` command (operator) and the `agent_dispatch` tool (the main agent) run a
// read-only child via an injectable exec (the in-repo spawn wrapper by default) and
// inject its answer back into the conversation as a follow-up that triggers the
// parent's next turn.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AUDIT_TYPE, COMMAND, DEFAULT_TIMEOUT_MS, INFLIGHT_FILE, KILL_TOOL, LABEL, LOG_COMMAND, RUNS_DIR, STATUS_TOOL, TAIL_LINES, TOOL } from "./constants.ts";
import { pickLatestLogName, renderLogTail, type SubagentRunAudit } from "./log.ts";
import { type InflightRecord, parseInflight, reapOrphans, serializeInflight } from "./orphans.ts";
import { loadPersonas, type Persona, resolveDispatch } from "./personas.ts";
import { RunRegistry, renderRows } from "./registry.ts";
import { defaultRunId, formatReply, runAgent, type DispatchResult, type LogWriter } from "./runner.ts";
import { defaultSpawnDeps, makeSpawnExec, type SpawnExec } from "./spawn.ts";

// The guardrails extension is a sibling dir (extensions/guardrails), resolved from this file's
// location so it is correct regardless of the parent session's cwd. Every spawned child loads it
// explicitly: `--no-extensions` only disables discovery, so the safety net must be passed by path.
const GUARDRAILS_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "..", "guardrails");

/** Injectable runner deps for the subagent extension, kept extensible as later slices add more optional deps. */
export interface SubagentDeps {
	/** The child runner, injected so tests fake the child and later slices can wrap it to capture the child's pid. */
	exec?: SpawnExec;
	/** Liveness probe injected so the OS effect is fakeable: true only when a recorded child is still running AND still our subagent, so a reused pid is never reaped. */
	processAlive?: (record: InflightRecord) => boolean;
	/** Force-kill injected so the OS effect is fakeable: terminates a reaped orphan by pid. */
	killProcess?: (pid: number) => void;
}

// The pidfile's imperative shell: record/remove are synchronous so the pid persists before any
// crash window and is gone the instant a run ends; the JSONL format itself lives in orphans.ts.

/** Persist a live child's pid at spawn so a crashed session's orphans stay reapable; synchronous and best-effort so the pid lands before any crash window and tracking never breaks a dispatch. */
function recordInflight(cwd: string, record: InflightRecord): void {
	const path = join(cwd, INFLIGHT_FILE);
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, serializeInflight([record]), "utf8");
	} catch {
		// Swallow: pidfile tracking is best-effort and must never break a dispatch.
	}
}

/**
 * Drop a finished run from the pidfile so it is never mistaken for an orphan, treating a missing file as a no-op so completion never throws.
 * Note: this read-modify-write is not concurrency-safe; concurrent completions can reinstate a stale record, which is acceptable until the concurrency cap + FIFO queue land in PR 7.2 (a dead stale record is harmless — the next startup reap drops it since the process is gone).
 */
function removeInflight(cwd: string, runId: string): void {
	const path = join(cwd, INFLIGHT_FILE);
	try {
		const remaining = parseInflight(readFileSync(path, "utf8")).filter((record) => record.runId !== runId);
		writeFileSync(path, serializeInflight(remaining), "utf8");
	} catch {
		// Swallow: a missing pidfile (or write failure) on remove is a no-op.
	}
}

/** Default PID-reuse-safe liveness probe: a recorded child counts as a live orphan only when its pid is running AND its /proc cmdline still identifies our one-shot pi child, so a process that reused a dead child's pid is never killed. */
const defaultProcessAlive = (record: InflightRecord): boolean => {
	try {
		process.kill(record.pid, 0);
	} catch {
		// Signal 0 only probes; a throw means no such process (or no permission), so not a live orphan.
		return false;
	}
	try {
		const cmdline = readFileSync(`/proc/${record.pid}/cmdline`, "utf8");
		return cmdline.includes("--mode") && cmdline.includes("json");
	} catch {
		// No /proc (non-Linux) or unreadable: identity unconfirmed, so never kill it.
		return false;
	}
};

/** Default force-kill for a reaped orphan, swallowing the error when the process is already gone so reaping a stale record never throws. */
const defaultKillProcess = (pid: number): void => {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone: nothing to kill.
	}
};

export default function (pi: ExtensionAPI, deps: SubagentDeps = {}): void {
	const exec: SpawnExec = deps.exec ?? makeSpawnExec(defaultSpawnDeps);
	const processAlive = deps.processAlive ?? defaultProcessAlive;
	const killProcess = deps.killProcess ?? defaultKillProcess;

	// The real log writer: the only fs in the dispatch path. Injected into runAgent,
	// which keeps logging best-effort and swallows any failure here.
	const writeLog: LogWriter = async (logPath, content) => {
		await mkdir(dirname(logPath), { recursive: true });
		await writeFile(logPath, content, "utf8");
	};

	// Live record of this session's dispatched runs, surfaced by the agent_status tool.
	const registry = new RunRegistry();

	// Track a run, dispatch the child (with its persona + guardrails), mark it finished, then
	// best-effort record it as a parent-session audit entry. Shared by the /agent command and the
	// agent_dispatch tool so tracking + logging + audit live in one place. The run is registered
	// synchronously before the first await — so an in-flight dispatch is observable as "running" —
	// and the same runId is threaded into runAgent so its log lines up. A persona (when matched)
	// supplies the child's tools/model/system prompt — null fields fall back to buildSpawnArgv's
	// defaults — and every child loads guardrails regardless. A persistence failure must never
	// break the dispatch.
	const dispatch = async (task: string, cwd: string, persona: Persona | null): Promise<DispatchResult> => {
		const runId = defaultRunId();
		const startedAt = Date.now();
		// Wire kill to abort: registering onKill before the await keeps the in-flight run
		// observable as running, and aborting the controller cancels the child's exec.
		const controller = new AbortController();
		registry.register({ runId, task, startedAt, onKill: () => controller.abort() });
		// Wrap the injected exec to record this child's pid in the pidfile the instant it spawns:
		// runAgent only forwards {timeout,signal,cwd}, so the onSpawn hook lives in this wrapper.
		const trackedExec: SpawnExec = (command, args, options) =>
			exec(command, args, { ...options, onSpawn: (pid) => recordInflight(cwd, { runId, pid, startedAt }) });
		const result = await runAgent(task, trackedExec, {
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
			// emitting `--system-prompt ""` and replacing that default with nothing.
			systemPrompt: persona?.systemPrompt || undefined,
		});
		registry.finish({ runId, status: result.ok ? "done" : "error", state: result.state, finishedAt: Date.now() });
		// The child is no longer in flight, so drop its pidfile record before the (best-effort) audit.
		removeInflight(cwd, runId);
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

	// Reap children a crashed prior session left in flight: on session start, force-kill any recorded
	// child whose process is still alive (a dead record needs no kill) and clear the pidfile, since
	// none of those runs belong to this new session and session_start fires before any new dispatch.
	// Best-effort and fully swallowed — a missing/unreadable pidfile is nothing to do, and reaping
	// must never break session start.
	pi.on("session_start", async (event, ctx) => {
		// "reload"/"new"/"resume"/"fork" fire within a live session whose own in-flight children are in
		// the pidfile — reaping then would kill them; only a fresh "startup" implies the prior recorded
		// children are orphans of a dead process.
		if (event.reason !== "startup") return;
		try {
			const path = join(ctx.cwd, INFLIGHT_FILE);
			const records = parseInflight(readFileSync(path, "utf8"));
			const reaped = reapOrphans(records, { isAlive: processAlive, kill: killProcess });
			writeFileSync(path, serializeInflight([]), "utf8");
			if (reaped.length > 0) {
				ctx.ui.notify(`[${LABEL}] reaped ${reaped.length} orphaned subagent(s)`, "info");
			}
		} catch {
			// Swallow: a missing/unreadable pidfile means nothing to reap, and reaping must never break session start.
		}
	});

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
			const result = await dispatch(task, ctx.cwd, persona);
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
			const result = await dispatch(params.task, ctx.cwd, null);
			return { content: [{ type: "text", text: formatReply(params.task, result) }], details: result };
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
