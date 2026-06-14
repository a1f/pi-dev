// subagents: dispatch headless one-shot pi children from the parent session.
//
// Thin pi adapter over the tested core (runner.ts → argv.ts/events.ts). Both the
// `/agent` command (operator) and the `agent_dispatch` tool (the main agent) run a
// read-only child via pi.exec and inject its answer back into the conversation as a
// follow-up that triggers the parent's next turn.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Type } from "typebox";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AUDIT_TYPE, COMMAND, DEFAULT_TIMEOUT_MS, KILL_TOOL, LABEL, LOG_COMMAND, RUNS_DIR, STATUS_TOOL, TAIL_LINES, TOOL } from "./constants.ts";
import { pickLatestLogName, renderLogTail, type SubagentRunAudit } from "./log.ts";
import { RunRegistry, renderRows } from "./registry.ts";
import { defaultRunId, formatReply, runAgent, type DispatchResult, type ExecLike, type LogWriter } from "./runner.ts";

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

	// Track a run, dispatch the child, mark it finished, then best-effort record it as a
	// parent-session audit entry. Shared by the /agent command and the agent_dispatch tool
	// so tracking + logging + audit live in one place. The run is registered synchronously
	// before the first await — so an in-flight dispatch is observable as "running" — and the
	// same runId is threaded into runAgent so its log lines up. A persistence failure must
	// never break the dispatch.
	const dispatch = async (task: string, cwd: string): Promise<DispatchResult> => {
		const runId = defaultRunId();
		const startedAt = Date.now();
		// Wire kill to abort: registering onKill before the await keeps the in-flight run
		// observable as running, and aborting the controller cancels the child's exec.
		const controller = new AbortController();
		registry.register({ runId, task, startedAt, onKill: () => controller.abort() });
		const result = await runAgent(task, exec, { timeoutMs: DEFAULT_TIMEOUT_MS, cwd, writeLog, runId, signal: controller.signal });
		registry.finish({ runId, status: result.ok ? "done" : "error", state: result.state, finishedAt: Date.now() });
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
			const task = args.trim();
			if (task === "") {
				ctx.ui.notify(`[${LABEL}] usage: /${COMMAND} <task>`, "warning");
				return;
			}
			const result = await dispatch(task, ctx.cwd);
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
			const result = await dispatch(params.task, ctx.cwd);
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
