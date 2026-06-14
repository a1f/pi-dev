import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AUDIT_TYPE, COMMAND, LOG_COMMAND, RUNS_DIR, TOOL } from "./constants.ts";
import subagents from "./index.ts";
import { type SubagentRunAudit } from "./log.ts";
import { type ExecLike, type ExecResultLike } from "./runner.ts";

// Drive the real extension default export against a fake pi so the inject-link
// is exercised end to end: the command handler must run runAgent over pi.exec,
// then deliver the formatted answer back through pi.sendUserMessage. The exec
// fake returns the shared happy-path fixture instead of spawning a real child.
const here = dirname(fileURLToPath(import.meta.url));
const happyStream = readFileSync(join(here, "fixtures", "summarize-readme.jsonl"), "utf8");
const ANSWER = "The README explains how to set up the dev VM.";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
type ToolDef = Parameters<ExtensionAPI["registerTool"]>[0];
type CommandCtx = Parameters<CommandHandler>[1];
type ToolCtx = Parameters<ToolDef["execute"]>[4];

/** The options pi.exec received, including the AbortSignal a kill aborts the child with. */
type ExecOptions = NonNullable<Parameters<ExecLike>[2]>;

interface ExecCall {
	command: string;
	args: string[];
	options: ExecOptions | undefined;
}
interface SentMessage {
	content: string | unknown[];
	options: { deliverAs?: string } | undefined;
}

interface AuditCall {
	customType: string;
	data: unknown;
}

interface FakePi {
	commandHandler: CommandHandler | undefined;
	logHandler: CommandHandler | undefined;
	tool: ToolDef | undefined;
	tools: ToolDef[];
	execCalls: ExecCall[];
	sent: SentMessage[];
	audits: AuditCall[];
	/** When set, pi.appendEntry throws so tests can exercise the best-effort swallow. */
	appendThrows: boolean;
	pi: ExtensionAPI;
}

function makeFakePi(respondExec?: () => Promise<ExecResultLike>): FakePi {
	const fake: FakePi = {
		commandHandler: undefined,
		logHandler: undefined,
		tool: undefined,
		tools: [],
		execCalls: [],
		sent: [],
		audits: [],
		appendThrows: false,
		pi: undefined as unknown as ExtensionAPI,
	};
	const pi = {
		registerCommand(name: string, options: { handler: CommandHandler }): void {
			if (name === COMMAND) fake.commandHandler = options.handler;
			else if (name === LOG_COMMAND) fake.logHandler = options.handler;
		},
		registerTool(tool: ToolDef): void {
			fake.tools.push(tool);
			// Keep `tool` pinned to the dispatch tool by name so adding sibling tools
			// (e.g. agent_status) never shifts what the agent_dispatch tests reach.
			if (tool.name === TOOL) fake.tool = tool;
		},
		exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResultLike> {
			fake.execCalls.push({ command, args, options });
			// A test may inject its own exec (e.g. a deferred) to observe a run mid-flight;
			// the default resolves immediately with the shared happy-path fixture.
			return respondExec !== undefined ? respondExec() : Promise.resolve({ stdout: happyStream, stderr: "", code: 0, killed: false });
		},
		sendUserMessage(content: string | unknown[], options?: { deliverAs?: string }): void {
			fake.sent.push({ content, options });
		},
		appendEntry(customType: string, data?: unknown): void {
			if (fake.appendThrows) throw new Error("append failed");
			fake.audits.push({ customType, data });
		},
	};
	fake.pi = pi as unknown as ExtensionAPI;
	return fake;
}

const tempCwd = async (): Promise<string> => mkdtemp(join(tmpdir(), "subagents-"));

const fakeCtx = { cwd: "/tmp", ui: { notify() {} }, hasUI: false };
const commandCtx = fakeCtx as unknown as CommandCtx;
const toolCtx = fakeCtx as unknown as ToolCtx;

test("command handler injects the subagent answer back as a follow-up", async () => {
	const fake = makeFakePi();
	subagents(fake.pi);
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	await fake.commandHandler("summarize the README", commandCtx);

	assert.equal(fake.execCalls.length, 1, "a valid task must spawn exactly one child");
	assert.equal(fake.execCalls[0]?.command, "pi");
	assert.equal(fake.sent.length, 1, "the answer must be injected once");
	const sent = fake.sent[0];
	assert.ok(sent, "a follow-up message must be delivered");
	assert.ok(typeof sent.content === "string" && sent.content.includes(ANSWER), "the delivered message must carry the subagent's answer");
	assert.equal(sent.options?.deliverAs, "followUp");
});

test("command handler handles an invalid task without throwing or spawning", async () => {
	const fake = makeFakePi();
	subagents(fake.pi);
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	await assert.doesNotReject(fake.commandHandler("@.env", commandCtx));

	assert.equal(fake.execCalls.length, 0, "an invalid task must not spawn a child");
	const sent = fake.sent[0];
	const delivered: string = typeof sent?.content === "string" ? sent.content : "";
	assert.ok(!/\bfinished\b/i.test(delivered), "an unlaunchable task must not read as a successful run");
});

test("a dispatch records a parent-session audit entry capturing the run's outcome", async () => {
	const fake = makeFakePi();
	subagents(fake.pi);
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	// A real temp cwd so the real writeLog has somewhere to land; we assert on the audit.
	const dir = await tempCwd();
	const ctx = { cwd: dir, ui: { notify() {} }, hasUI: false } as unknown as CommandCtx;

	await fake.commandHandler("summarize the README", ctx);

	assert.equal(fake.audits.length, 1, "a completed run must record exactly one audit entry");
	const audit = fake.audits[0];
	assert.ok(audit);
	assert.equal(audit.customType, AUDIT_TYPE);
	const data = audit.data as SubagentRunAudit;
	assert.equal(data.task, "summarize the README");
	assert.equal(data.ok, true);
	assert.equal(data.exitCode, 0);
	assert.ok(typeof data.runId === "string" && data.runId.length > 0, "the audit must carry the run id");
	assert.ok(data.logPath.endsWith(".jsonl"), "the audit must point at the run's log file");
});

test("a dispatch still delivers the answer when audit persistence throws", async () => {
	// Audit persistence is best-effort: an appendEntry failure must not derail the
	// dispatch — the subagent's answer must still reach the parent conversation.
	const fake = makeFakePi();
	fake.appendThrows = true;
	subagents(fake.pi);
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	const dir = await tempCwd();
	const ctx = { cwd: dir, ui: { notify() {} }, hasUI: false } as unknown as CommandCtx;

	await assert.doesNotReject(fake.commandHandler("summarize the README", ctx));

	const sent = fake.sent[0];
	assert.ok(sent, "the follow-up must still be delivered when the audit throws");
	assert.ok(typeof sent.content === "string" && sent.content.includes(ANSWER), "the answer must survive a failed audit");
});

test("the agent_dispatch tool returns the subagent answer as its text content", async () => {
	const fake = makeFakePi();
	subagents(fake.pi);
	assert.ok(fake.tool, "the extension must register the agent_dispatch tool");

	const result = await fake.tool.execute("id", { task: "summarize the README" }, undefined, undefined, toolCtx);

	assert.equal(fake.execCalls.length, 1, "the tool must spawn exactly one child");
	const block = result.content[0];
	assert.ok(block && block.type === "text" && block.text.includes(ANSWER), "the tool result must include the subagent's answer");
});

interface Note {
	msg: string;
	level: string;
}

const notifyingCtx = (cwd: string, notes: Note[]): CommandCtx =>
	({ cwd, ui: { notify: (msg: string, level: string) => notes.push({ msg, level }) }, hasUI: false }) as unknown as CommandCtx;

test("/agent-log notifies the rendered tail of the most recent run log", async () => {
	const fake = makeFakePi();
	subagents(fake.pi);
	assert.ok(fake.logHandler, "the extension must register the agent-log command");

	const dir = await tempCwd();
	const runsDir = join(dir, RUNS_DIR);
	await mkdir(runsDir, { recursive: true });
	await writeFile(join(runsDir, "2024-01-01T00-00-00.jsonl"), '{"type":"run_start"}\nstale\n', "utf8");
	await writeFile(join(runsDir, "2024-06-01T00-00-00.jsonl"), '{"type":"run_start"}\nnewest\n', "utf8");

	const notes: Note[] = [];
	await fake.logHandler("", notifyingCtx(dir, notes));

	assert.equal(notes.length, 1, "the tail must be shown once");
	const note = notes[0];
	assert.ok(note);
	assert.ok(note.msg.includes("2024-06-01T00-00-00.jsonl"), "the tail must come from the newest run, named in the message");
	assert.ok(note.msg.includes("newest"), "the tail must carry the newest run's content");
	assert.ok(!note.msg.includes("stale"), "an older run's content must not leak into the tail");
});

test("/agent-log reports no runs when the runs dir is absent, without throwing", async () => {
	const fake = makeFakePi();
	subagents(fake.pi);
	assert.ok(fake.logHandler, "the extension must register the agent-log command");

	const dir = await tempCwd(); // no .pi/runs/ inside it
	const notes: Note[] = [];
	await assert.doesNotReject(fake.logHandler("", notifyingCtx(dir, notes)));

	assert.equal(notes.length, 1, "a friendly message must still be shown");
	assert.ok(/no .*run/i.test(notes[0]?.msg ?? ""), "the message must read as 'no runs yet'");
});

test("/agent-log warns once when the most recent run log cannot be read", async () => {
	// A directory whose name looks like a log file is listed by readdir yet rejects
	// readFile (EISDIR). The handler must surface a single warning and never throw.
	const fake = makeFakePi();
	subagents(fake.pi);
	assert.ok(fake.logHandler, "the extension must register the agent-log command");

	const dir = await tempCwd();
	await mkdir(join(dir, RUNS_DIR, "2024-06-01T00-00-00.jsonl"), { recursive: true });

	const notes: Note[] = [];
	await assert.doesNotReject(fake.logHandler("", notifyingCtx(dir, notes)));

	assert.equal(notes.length, 1, "an unreadable run log must warn exactly once");
	const note = notes[0];
	assert.ok(note);
	assert.match(note.msg, /could not read run log/);
	assert.equal(note.level, "warning");
});

type ToolResult = Awaited<ReturnType<ToolDef["execute"]>>;

/** One run as the agent_status tool exposes it under its structured details. */
interface StatusRun {
	runId: string;
	task: string;
	status: string;
}

/** True when a tool's details carry the run list agent_status must report. */
function hasRuns(details: unknown): details is { runs: readonly StatusRun[] } {
	return details !== null && typeof details === "object" && "runs" in details && Array.isArray(details.runs);
}

/** The runs agent_status reports, narrowed from the tool result's structured details. */
function statusRuns(result: ToolResult): readonly StatusRun[] {
	if (!hasRuns(result.details)) assert.fail("agent_status must report runs under details.runs");
	return result.details.runs;
}

/** The human-readable rows text agent_status returns as its first content block. */
function statusRows(result: ToolResult): string {
	const block = result.content[0];
	return block && block.type === "text" ? block.text : "";
}

test("agent_status reports an in-flight run as running and a completed run as done", async () => {
	// Hold the child's exec open so the dispatch is observably mid-flight while we
	// check status; resolving the deferred later lets the run finish.
	let settleExec!: (result: ExecResultLike) => void;
	const pendingExec = new Promise<ExecResultLike>((resolve) => {
		settleExec = resolve;
	});
	const fake = makeFakePi(() => pendingExec);
	subagents(fake.pi);
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	const statusTool = fake.tools.find((tool) => tool.name === "agent_status");
	assert.ok(statusTool, "the extension must register the agent_status tool");

	// Start a dispatch but leave exec pending, so the run is still running.
	const dispatched = fake.commandHandler("scout repo", commandCtx);

	const live = await statusTool.execute("id", {}, undefined, undefined, toolCtx);
	const liveRuns = statusRuns(live);
	assert.equal(liveRuns.length, 1, "the in-flight dispatch must be tracked as exactly one run");
	const liveRun = liveRuns[0];
	assert.ok(liveRun);
	assert.equal(liveRun.task, "scout repo", "the tracked run must carry the dispatched task");
	assert.equal(liveRun.status, "running", "a run whose child is still in flight must report as running");
	assert.ok(statusRows(live).includes("▶"), "the rows for a running run must carry the running glyph");

	// Let the child finish, then let the dispatch settle.
	settleExec({ stdout: happyStream, stderr: "", code: 0, killed: false });
	await dispatched;

	const settled = await statusTool.execute("id", {}, undefined, undefined, toolCtx);
	const settledRun = statusRuns(settled)[0];
	assert.ok(settledRun);
	assert.equal(settledRun.status, "done", "a run whose child completed cleanly must report as done");
	assert.ok(statusRows(settled).includes("✓"), "the rows for a done run must carry the done glyph");
});

test("agent_kill aborts the in-flight child and the run stays killed after a late completion", async () => {
	// Hold the child's exec open so the run is observably mid-flight; resolving the
	// deferred later replays the aborted child returning after the kill.
	let settleExec!: (result: ExecResultLike) => void;
	const pendingExec = new Promise<ExecResultLike>((resolve) => {
		settleExec = resolve;
	});
	const fake = makeFakePi(() => pendingExec);
	subagents(fake.pi);
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	const statusTool = fake.tools.find((tool) => tool.name === "agent_status");
	assert.ok(statusTool, "the extension must register the agent_status tool");
	const killTool = fake.tools.find((tool) => tool.name === "agent_kill");
	assert.ok(killTool, "the extension must register the agent_kill tool");

	// Start a dispatch but leave exec pending, so the child is still in flight.
	const dispatched = fake.commandHandler("scout repo", commandCtx);

	// The child's exec must receive a live, not-yet-aborted AbortSignal.
	const signal = fake.execCalls[0]?.options?.signal;
	assert.ok(signal, "the in-flight child's exec must receive an AbortSignal");
	assert.equal(signal.aborted, false, "the signal must stay live while the child runs");

	const before = await statusTool.execute("id", {}, undefined, undefined, toolCtx);
	const runId = statusRuns(before)[0]?.runId;
	assert.ok(runId, "the in-flight dispatch must be tracked with a run id");

	await killTool.execute("id", { runId }, undefined, undefined, toolCtx);
	assert.equal(signal.aborted, true, "killing the run must abort its in-flight exec");

	const afterKill = await statusTool.execute("id", {}, undefined, undefined, toolCtx);
	const killedRun = statusRuns(afterKill)[0];
	assert.ok(killedRun);
	assert.equal(killedRun.status, "killed", "a killed run must report as killed");
	assert.ok(statusRows(afterKill).includes("⊘"), "the rows for a killed run must carry the killed glyph");

	// The aborted child still returns late; the run must stay killed, not flip to error.
	settleExec({ stdout: "", stderr: "", code: 1, killed: true });
	await dispatched;

	const afterReturn = await statusTool.execute("id", {}, undefined, undefined, toolCtx);
	const finalRun = statusRuns(afterReturn)[0];
	assert.ok(finalRun);
	assert.equal(finalRun.status, "killed", "a late completion must not overwrite a killed run");
});
