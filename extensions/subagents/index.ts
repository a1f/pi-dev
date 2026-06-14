// subagents: dispatch headless one-shot pi children from the parent session.
//
// Thin pi adapter over the tested core (runner.ts → argv.ts/events.ts). Both the
// `/agent` command (operator) and the `agent_dispatch` tool (the main agent) run a
// read-only child via pi.exec and inject its answer back into the conversation as a
// follow-up that triggers the parent's next turn.

import { Type } from "typebox";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { COMMAND, DEFAULT_TIMEOUT_MS, LABEL, TOOL } from "./constants.ts";
import { formatReply, runAgent, type ExecLike } from "./runner.ts";

export default function (pi: ExtensionAPI): void {
	const exec: ExecLike = (command, args, options) => pi.exec(command, args, options);

	pi.registerCommand(COMMAND, {
		description: "Dispatch a headless read-only subagent to perform <task>; its answer is injected as a follow-up.",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (task === "") {
				ctx.ui.notify(`[${LABEL}] usage: /${COMMAND} <task>`, "warning");
				return;
			}
			const result = await runAgent(task, exec, { timeoutMs: DEFAULT_TIMEOUT_MS, cwd: ctx.cwd });
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
			const result = await runAgent(params.task, exec, { timeoutMs: DEFAULT_TIMEOUT_MS, cwd: ctx.cwd });
			return { content: [{ type: "text", text: formatReply(params.task, result) }], details: result };
		},
	});
}
