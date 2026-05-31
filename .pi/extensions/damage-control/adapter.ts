// The only pi-coupled module: maps pi's ToolCallEvent to the policy's
// NormalizedCall. Kept thin so match.ts / rules.ts / evaluate.ts stay testable
// without loading the agent.

import { isToolCallEventType, type ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type { NormalizedCall } from "./evaluate.ts";

// A read targeting a location (path, defaulting to cwd) plus an optional search
// selector (grep's glob / find's pattern), both screened as path candidates.
function readCall(path: string | undefined, selector: string | undefined): NormalizedCall {
	const paths = selector === undefined ? [path ?? "."] : [path ?? ".", selector];
	return { kind: "paths", paths, write: false };
}

export function toNormalizedCall(event: ToolCallEvent): NormalizedCall {
	if (isToolCallEventType("bash", event)) return { kind: "bash", command: event.input.command };
	if (isToolCallEventType("read", event)) return { kind: "paths", paths: [event.input.path], write: false };
	if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
		return { kind: "paths", paths: [event.input.path], write: true };
	}
	if (isToolCallEventType("grep", event)) return readCall(event.input.path, event.input.glob);
	if (isToolCallEventType("find", event)) return readCall(event.input.path, event.input.pattern);
	if (isToolCallEventType("ls", event)) return readCall(event.input.path, undefined);
	// Unknown/custom tools (incl. MCP): no path or command surface we can reason
	// about, so we don't screen them — bash remains the backstop.
	return { kind: "ignore" };
}
