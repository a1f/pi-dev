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

import { AUDIT_TYPE, COMMAND, DEFAULT_TIMEOUT_MS, LABEL, LOG_COMMAND, RUNS_DIR, TAIL_LINES, TOOL } from "./constants.ts";
import { pickLatestLogName, renderLogTail, type SubagentRunAudit } from "./log.ts";
import { formatReply, runAgent, type DispatchResult, type ExecLike, type LogWriter } from "./runner.ts";

export default function (pi: ExtensionAPI): void {
	const exec: ExecLike = (command, args, options) => pi.exec(command, args, options);

	// The real log writer: the only fs in the dispatch path. Injected into runAgent,
	// which keeps logging best-effort and swallows any failure here.
	const writeLog: LogWriter = async (logPath, content) => {
		await mkdir(dirname(logPath), { recursive: true });
		await writeFile(logPath, content, "utf8");
	};

	// Run a child, then best-effort record the run as a parent-session audit entry.
	// Shared by the /agent command and the agent_dispatch tool so logging + audit
	// live in one place. A persistence failure must never break the dispatch.
	const dispatch = async (task: string, cwd: string): Promise<DispatchResult> => {
		const result = await runAgent(task, exec, { timeoutMs: DEFAULT_TIMEOUT_MS, cwd, writeLog });
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
