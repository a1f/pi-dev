// guardrails: a pi extension that blocks the agent's own dangerous or protected
// tool calls (secrets, irreversible/external commands), logs every decision, and
// — per the rules' mode — either aborts the turn or returns actionable feedback
// so the agent adapts and keeps working.
//
// Threat model: our own honest mistakes, not an adversary. A VM is the real
// isolation boundary; this is the in-VM guardrail + audit trail.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { toNormalizedCall } from "./adapter.ts";
import { evaluateNormalized, type NormalizedCall, type Violation } from "./evaluate.ts";
import { abortReason, continueReason } from "./feedback.ts";
import { type CompiledRules, EMPTY_RULES, loadRules, ruleCount } from "./rules.ts";

const STATUS_KEY = "guardrails";
const LOG_TYPE = "guardrails-log";
const CONFIRM_TIMEOUT_MS = 30_000;

export default function (pi: ExtensionAPI): void {
	let rules: CompiledRules = EMPTY_RULES;

	pi.on("session_start", async (_event, ctx) => {
		const result = loadRules(ctx.cwd);
		rules = result.rules;
		for (const warning of result.warnings) ctx.ui.notify(`${STATUS_KEY}: ${warning}`, "warning");
		if (result.source === null) {
			ctx.ui.notify(`${STATUS_KEY}: no rules file (.pi/guardrails.yaml) — nothing enforced.`, "warning");
		}
		ctx.ui.setStatus(STATUS_KEY, `🛡️ guardrails: ${ruleCount(rules)} rules (${rules.mode})`);
	});

	pi.on("tool_call", async (event, ctx) => {
		const call = toNormalizedCall(event);
		const violation = evaluateNormalized(call, rules, ctx.cwd);
		if (violation === null) return { block: false };

		const invocation = invocationText(event.toolName, call);
		const allowed = violation.ask ? await confirmOverride(ctx, violation, invocation) : false;

		pi.appendEntry(LOG_TYPE, {
			tool: event.toolName,
			input: event.input,
			category: violation.category,
			reason: violation.reason,
			action: allowed ? "allowed" : "blocked",
		});
		if (allowed) return { block: false };

		ctx.ui.setStatus(STATUS_KEY, `⚠️ guardrails: blocked ${event.toolName} (${violation.category})`);
		if (rules.mode === "abort") {
			// After ctx.abort() pi returns a generic "Operation aborted" to the model and
			// drops our reason, so surface it to the user out-of-band before aborting.
			const reason = abortReason(event.toolName, violation, invocation);
			ctx.ui.notify(reason, "error");
			ctx.abort();
			return { block: true, reason };
		}
		return { block: true, reason: continueReason(event.toolName, violation, invocation) };
	});
}

/** Short, content-free description of a call for the block message and confirm dialog. */
function invocationText(toolName: string, call: NormalizedCall): string {
	if (call.kind === "bash") return call.command;
	if (call.kind === "paths") return `${toolName}: ${call.paths.join(", ")}`;
	return toolName;
}

/** Ask the user to override an `ask` rule. With no UI (unattended) we can't prompt, so deny without stalling. */
async function confirmOverride(ctx: ExtensionContext, violation: Violation, invocation: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm("🛡️ guardrails", `${violation.reason}\n\n${invocation}\n\nProceed anyway?`, { timeout: CONFIRM_TIMEOUT_MS });
}
