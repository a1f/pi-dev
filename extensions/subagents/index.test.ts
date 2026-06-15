import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { type ExtensionAPI, type ExtensionHandler, type SessionStartEvent } from "@earendil-works/pi-coding-agent";

import { AUDIT_TYPE, COMMAND, CONTINUE_COMMAND, CONTINUE_TOOL, INFLIGHT_FILE, LOG_COMMAND, RUNS_DIR, SESSIONS_DIR, TOOL } from "./constants.ts";
import subagents from "./index.ts";
import { type SubagentRunAudit } from "./log.ts";
import { type InflightRecord, parseInflight, serializeInflight } from "./orphans.ts";
import { type ExecLike, type ExecResultLike } from "./runner.ts";
import { type SpawnExec } from "./spawn.ts";

// Drive the real extension default export against a fake pi so the inject-link
// is exercised end to end: the command handler must run runAgent over the injected
// exec, then deliver the formatted answer back through pi.sendUserMessage. The exec
// fake returns the shared happy-path fixture instead of spawning a real child.
const here = dirname(fileURLToPath(import.meta.url));
const happyStream = readFileSync(join(here, "fixtures", "summarize-readme.jsonl"), "utf8");
const ANSWER = "The README explains how to set up the dev VM.";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
type ToolDef = Parameters<ExtensionAPI["registerTool"]>[0];
type CommandCtx = Parameters<CommandHandler>[1];
type ToolCtx = Parameters<ToolDef["execute"]>[4];
/** The session_start handler the extension registers, and the ctx it receives — captured by the fake pi's on(). */
type SessionStartHandler = ExtensionHandler<SessionStartEvent>;
type SessionStartCtx = Parameters<SessionStartHandler>[1];

/** The options the injected exec received, including the AbortSignal a kill aborts the child with. */
type ExecOptions = NonNullable<Parameters<ExecLike>[2]>;

interface ExecCall {
	command: string;
	args: readonly string[];
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
	/** The session_start handler captured from pi.on, invoked by the orphan-reaping test. */
	sessionStartHandler: SessionStartHandler | undefined;
	continueHandler: CommandHandler | undefined;
	tool: ToolDef | undefined;
	tools: ToolDef[];
	/** The injected child runner passed to subagents as deps.exec; records into execCalls. */
	exec: SpawnExec;
	execCalls: ExecCall[];
	sent: SentMessage[];
	audits: AuditCall[];
	/** When set, pi.appendEntry throws so tests can exercise the best-effort swallow. */
	appendThrows: boolean;
	pi: ExtensionAPI;
}

function makeFakePi(respondExec?: () => Promise<ExecResultLike>): FakePi {
	const execCalls: ExecCall[] = [];
	// The injected child runner: it records each call into execCalls, then — so a test can
	// supply its own exec (e.g. a deferred) to observe a run mid-flight — replays that
	// deferred when given one, else resolves immediately with the shared happy-path fixture.
	const exec: SpawnExec = (command, args, options) => {
		execCalls.push({ command, args, options });
		return respondExec !== undefined ? respondExec() : Promise.resolve({ stdout: happyStream, stderr: "", code: 0, killed: false });
	};
	const fake: FakePi = {
		commandHandler: undefined,
		logHandler: undefined,
		sessionStartHandler: undefined,
		continueHandler: undefined,
		tool: undefined,
		tools: [],
		exec,
		execCalls,
		sent: [],
		audits: [],
		appendThrows: false,
		pi: undefined as unknown as ExtensionAPI,
	};
	const pi = {
		on(event: string, handler: SessionStartHandler): void {
			// Capture only the session_start handler the orphan-reaping test invokes; other
			// events are accepted and ignored so registering them never throws.
			if (event === "session_start") fake.sessionStartHandler = handler;
		},
		registerCommand(name: string, options: { handler: CommandHandler }): void {
			if (name === COMMAND) fake.commandHandler = options.handler;
			else if (name === LOG_COMMAND) fake.logHandler = options.handler;
			else if (name === CONTINUE_COMMAND) fake.continueHandler = options.handler;
		},
		registerTool(tool: ToolDef): void {
			fake.tools.push(tool);
			// Keep `tool` pinned to the dispatch tool by name so adding sibling tools
			// (e.g. agent_status) never shifts what the agent_dispatch tests reach.
			if (tool.name === TOOL) fake.tool = tool;
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

/** The argument following the first occurrence of `flag` in a spawn argv, or undefined. */
const flagValue = (args: readonly string[], flag: string): string | undefined => {
	const i = args.indexOf(flag);
	return i === -1 ? undefined : args[i + 1];
};

/** Write a persona markdown file into <cwd>/.pi/agents so loadPersonas can find it. */
const writePersona = async (cwd: string, file: string, content: string): Promise<void> => {
	const agents = join(cwd, ".pi", "agents");
	await mkdir(agents, { recursive: true });
	await writeFile(join(agents, file), content, "utf8");
};

/** Plant a prior session file at <cwd>/.pi/sessions/<name>.jsonl so a continue's precondition is met. */
const writeSession = async (cwd: string, name: string): Promise<void> => {
	const sessions = join(cwd, SESSIONS_DIR);
	await mkdir(sessions, { recursive: true });
	await writeFile(join(sessions, `${name}.jsonl`), '{"type":"session_start"}\n', "utf8");
};

const fakeCtx = { cwd: "/tmp", ui: { notify() {} }, hasUI: false };
const commandCtx = fakeCtx as unknown as CommandCtx;
const toolCtx = fakeCtx as unknown as ToolCtx;

test("command handler injects the subagent answer back as a follow-up", async () => {
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
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

test("a named persona applies its tools and system prompt, and the child still loads guardrails", async () => {
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	const dir = await tempCwd();
	await writePersona(
		dir,
		"scout.md",
		"---\nname: scout\ndescription: Maps the repository.\ntools:\n  - read\n  - grep\n  - find\n---\nYou are scout. Map the repository.",
	);
	const ctx = { cwd: dir, ui: { notify() {} }, hasUI: false } as unknown as CommandCtx;

	await fake.commandHandler("scout summarize the layout", ctx);

	assert.equal(fake.execCalls.length, 1, "a persona dispatch must spawn exactly one child");
	const args = fake.execCalls[0]?.args ?? [];
	assert.equal(flagValue(args, "--tools"), "read,grep,find", "the child must run with the persona's tools");
	assert.equal(flagValue(args, "--system-prompt"), "You are scout. Map the repository.", "the persona body becomes the child's system prompt");
	const extension = flagValue(args, "--extension");
	assert.ok(extension !== undefined && extension.endsWith("guardrails"), "every child must load the guardrails extension");
});

test("a persona /agent dispatch persists to its per-persona session file, fresh (no --continue)", async () => {
	// A persona dispatch passes --session <cwd>/.pi/sessions/<name>.jsonl so a later /agent-continue
	// can resume it; the first run is fresh, so it must NOT carry --continue.
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	const dir = await tempCwd();
	await writePersona(dir, "scout.md", "---\nname: scout\ndescription: Maps the repository.\ntools:\n  - read\n---\nYou are scout.");
	const ctx = { cwd: dir, ui: { notify() {} }, hasUI: false } as unknown as CommandCtx;

	await fake.commandHandler("scout summarize the layout", ctx);

	assert.equal(fake.execCalls.length, 1, "a persona dispatch must spawn exactly one child");
	const args = fake.execCalls[0]?.args ?? [];
	assert.equal(flagValue(args, "--session"), join(dir, ".pi", "sessions", "scout.jsonl"), "a persona dispatch must persist to its per-persona session file");
	assert.equal(args.indexOf("--continue"), -1, "a fresh persona dispatch must not carry the explicit-continue marker");
});

test("a persona /agent dispatch creates the per-persona sessions directory before launching", async () => {
	// pi mkdirs the session file's own dir under the default config, but a session-dir override
	// (PI_CODING_AGENT_SESSION_DIR / --session-dir / settings.sessionDir) would leave
	// <cwd>/.pi/sessions absent and the first persist would ENOENT; the extension creates it
	// defensively (best-effort, mirroring the runs dir) so resumption never silently breaks.
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	const dir = await tempCwd();
	await writePersona(dir, "scout.md", "---\nname: scout\ndescription: Maps the repository.\n---\nYou are scout.");
	const ctx = { cwd: dir, ui: { notify() {} }, hasUI: false } as unknown as CommandCtx;

	await fake.commandHandler("scout map the repo", ctx);

	assert.ok(existsSync(join(dir, SESSIONS_DIR)), "a persona dispatch must create its sessions directory so the first persist can land");
});

test("a plain dispatch (no persona) still loads guardrails and runs with the default read-only tools", async () => {
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	const dir = await tempCwd(); // no personas: the whole arg string is the task
	const ctx = { cwd: dir, ui: { notify() {} }, hasUI: false } as unknown as CommandCtx;

	await fake.commandHandler("summarize the README", ctx);

	assert.equal(fake.execCalls.length, 1, "a plain dispatch must spawn exactly one child");
	const args = fake.execCalls[0]?.args ?? [];
	const extension = flagValue(args, "--extension");
	assert.ok(extension !== undefined && extension.endsWith("guardrails"), "even a persona-less child must load guardrails");
	assert.equal(flagValue(args, "--tools"), "read,grep,find,ls", "a plain dispatch keeps the default read-only tools");
});

test("a persona with no body dispatches without a --system-prompt flag (the child's default applies)", async () => {
	// parsePersona allows a frontmatter-only persona, whose trimmed body is "". Forwarding
	// that empty string would emit `--system-prompt ""`, replacing the child's default prompt
	// with nothing; an empty body must instead fall back to the default like tools/model do.
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	const dir = await tempCwd();
	await writePersona(dir, "bare.md", "---\nname: bare\ndescription: Frontmatter only, no body.\n---\n");
	const ctx = { cwd: dir, ui: { notify() {} }, hasUI: false } as unknown as CommandCtx;

	await fake.commandHandler("bare do the thing", ctx);

	assert.equal(fake.execCalls.length, 1, "a persona dispatch must spawn exactly one child");
	const args = fake.execCalls[0]?.args ?? [];
	assert.equal(flagValue(args, "--system-prompt"), undefined, "an empty persona body must not replace the child's default system prompt");
});

test("the agent_dispatch tool spawns a child that loads the guardrails extension", async () => {
	// The tool routes through the shared dispatch, so its child must carry guardrails too.
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	assert.ok(fake.tool, "the extension must register the agent_dispatch tool");

	await fake.tool.execute("id", { task: "summarize the README" }, undefined, undefined, toolCtx);

	assert.equal(fake.execCalls.length, 1, "the tool must spawn exactly one child");
	const args = fake.execCalls[0]?.args ?? [];
	const extension = flagValue(args, "--extension");
	assert.ok(extension !== undefined && extension.endsWith("guardrails"), "the tool path must load guardrails too");
});

test("command handler handles an invalid task without throwing or spawning", async () => {
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	await assert.doesNotReject(fake.commandHandler("@.env", commandCtx));

	assert.equal(fake.execCalls.length, 0, "an invalid task must not spawn a child");
	const sent = fake.sent[0];
	const delivered: string = typeof sent?.content === "string" ? sent.content : "";
	assert.ok(!/\bfinished\b/i.test(delivered), "an unlaunchable task must not read as a successful run");
});

test("a dispatch records a parent-session audit entry capturing the run's outcome", async () => {
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
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
	subagents(fake.pi, { exec: fake.exec });
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
	subagents(fake.pi, { exec: fake.exec });
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

test("the /agent handler surfaces a warning for a malformed persona file and still dispatches", async () => {
	// loadPersonas skips a malformed file but reports it in `warnings`; the handler must
	// surface that to the operator (not silently drop it) and still run the requested task.
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	const dir = await tempCwd();
	await writePersona(dir, "broken.md", "no frontmatter fence at all");
	const notes: Note[] = [];

	await fake.commandHandler("summarize the README", notifyingCtx(dir, notes));

	const warning = notes.find((note) => note.level === "warning");
	assert.ok(warning, "a malformed persona file must surface a warning notification");
	assert.match(warning.msg, /broken\.md/);
	assert.equal(fake.execCalls.length, 1, "a malformed persona must not stop the dispatch");
	assert.equal(fake.sent.length, 1, "the answer must still be delivered");
});

test("/agent-log notifies the rendered tail of the most recent run log", async () => {
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
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
	subagents(fake.pi, { exec: fake.exec });
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
	subagents(fake.pi, { exec: fake.exec });
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
	subagents(fake.pi, { exec: fake.exec });
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
	subagents(fake.pi, { exec: fake.exec });
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

test("a dispatch records its child's pid in the in-flight pidfile while running and removes it on completion", async () => {
	// Orphan cleanup needs each live child persisted to a pidfile so a later session can reap
	// children a dead session left behind. Hold the child's exec open with a deferred so the run is
	// observably mid-flight, and fire onSpawn with a known pid the way the real spawn wrapper does;
	// the shared fake exec never calls onSpawn, so this test injects its own.
	const childPid = 4242;
	let settleExec!: (result: ExecResultLike) => void;
	const pendingExec = new Promise<ExecResultLike>((resolve) => {
		settleExec = resolve;
	});
	const exec: SpawnExec = (_command, _args, options) => {
		options?.onSpawn?.(childPid);
		return pendingExec;
	};
	const fake = makeFakePi();
	subagents(fake.pi, { exec });
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	const dir = await tempCwd();
	const ctx = { cwd: dir, ui: { notify() {} }, hasUI: false } as unknown as CommandCtx;
	const inflightPath = join(dir, INFLIGHT_FILE);
	// Read the pidfile, treating an absent file as no records, so each lifecycle check fails on a
	// missing record rather than on an ENOENT throw.
	const readInflight = () => parseInflight(existsSync(inflightPath) ? readFileSync(inflightPath, "utf8") : "");

	// Start the dispatch but leave exec pending: the adapter records the pid synchronously at spawn,
	// so the pidfile already names the running child before we let the run finish.
	const dispatched = fake.commandHandler("scout repo", ctx);

	const running = readInflight().find((record) => record.pid === childPid);
	assert.ok(running, "the running child's pid must be recorded in the in-flight pidfile");
	assert.ok(running.runId.length > 0, "the in-flight record must carry a non-empty run id");

	// Let the child exit cleanly, then let the dispatch settle.
	settleExec({ stdout: happyStream, stderr: "", code: 0, killed: false });
	await dispatched;

	assert.ok(!readInflight().some((record) => record.pid === childPid), "a completed run's pid must be removed from the in-flight pidfile");
});

test("on startup, session_start force-kills only the live orphan and clears the pidfile", async () => {
	// A session that crashed mid-run can leave its in-flight children alive and still recorded in
	// the pidfile. On the next fresh startup the extension must force-kill any recorded child whose
	// process is still alive (a dead record needs no kill) and then clear the pidfile, since none of
	// those runs belong to this new session. Liveness and kill are real OS effects, so both are
	// injected; the pidfile is a real temp file as in the other lifecycle tests.
	const aliveOrphan: InflightRecord = { runId: "alive-run", pid: 5001, startedAt: 1 };
	const deadOrphan: InflightRecord = { runId: "dead-run", pid: 5002, startedAt: 2 };

	const dir = await tempCwd();
	const inflightPath = join(dir, INFLIGHT_FILE);
	await mkdir(dirname(inflightPath), { recursive: true });
	writeFileSync(inflightPath, serializeInflight([aliveOrphan, deadOrphan]), "utf8");

	const killed: number[] = [];
	const fake = makeFakePi();
	subagents(fake.pi, {
		processAlive: (record: InflightRecord) => record.pid === aliveOrphan.pid,
		killProcess: (pid: number) => killed.push(pid),
	});
	assert.ok(fake.sessionStartHandler, "the extension must register a session_start handler");

	const ctx = { cwd: dir, ui: { notify() {} }, hasUI: false } as unknown as SessionStartCtx;
	await fake.sessionStartHandler({ type: "session_start", reason: "startup" }, ctx);

	assert.deepEqual(killed, [aliveOrphan.pid], "only the still-alive orphan's pid must be force-killed");
	const remaining = parseInflight(existsSync(inflightPath) ? readFileSync(inflightPath, "utf8") : "");
	assert.equal(remaining.length, 0, "the pidfile must be cleared once startup orphans are reaped");
});

test("on a non-startup session_start, the live session's own in-flight child survives and the pidfile is left intact", async () => {
	// session_start also fires mid-session ("reload", "new", "resume", "fork"), when the pidfile
	// records THIS live session's own in-flight children. Reaping then would force-kill a running
	// child, so reaping must be restricted to a fresh "startup": a "reload" must touch neither the
	// live child nor its pidfile record. The seeded record stands in for that own in-flight child.
	const liveChild: InflightRecord = { runId: "live-run", pid: 6001, startedAt: 1 };

	const dir = await tempCwd();
	const inflightPath = join(dir, INFLIGHT_FILE);
	await mkdir(dirname(inflightPath), { recursive: true });
	writeFileSync(inflightPath, serializeInflight([liveChild]), "utf8");

	const killed: number[] = [];
	const fake = makeFakePi();
	subagents(fake.pi, {
		processAlive: () => true,
		killProcess: (pid: number) => killed.push(pid),
	});
	assert.ok(fake.sessionStartHandler, "the extension must register a session_start handler");

	const ctx = { cwd: dir, ui: { notify() {} }, hasUI: false } as unknown as SessionStartCtx;
	await fake.sessionStartHandler({ type: "session_start", reason: "reload" }, ctx);

	assert.deepEqual(killed, [], "a non-startup session_start must not reap the live session's own in-flight child");
	const remaining = parseInflight(existsSync(inflightPath) ? readFileSync(inflightPath, "utf8") : "");
	assert.deepEqual(remaining, [liveChild], "a non-startup session_start must leave the pidfile record untouched");
});

/** A tool ctx rooted at a real temp dir, so loadPersonas and the session precondition read real files. */
const continueToolCtx = (cwd: string): ToolCtx => ({ cwd, ui: { notify() {} }, hasUI: false }) as unknown as ToolCtx;

test("agent_continue resumes a persona's session with --session --continue and its tools, and re-applies the persona's system prompt", async () => {
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	const continueTool = fake.tools.find((t) => t.name === CONTINUE_TOOL);
	assert.ok(continueTool, "the extension must register the agent_continue tool");

	const dir = await tempCwd();
	await writePersona(dir, "scout.md", "---\nname: scout\ndescription: Maps the repository.\ntools:\n  - read\n  - grep\n  - find\n---\nYou are scout.");
	await writeSession(dir, "scout"); // a prior dispatch left a session to resume

	const result = await continueTool.execute("id", { persona: "scout", task: "now check the tests" }, undefined, undefined, continueToolCtx(dir));

	assert.equal(fake.execCalls.length, 1, "a resume must spawn exactly one child");
	const args = fake.execCalls[0]?.args ?? [];
	assert.equal(flagValue(args, "--session"), join(dir, ".pi", "sessions", "scout.jsonl"), "the resumed child must use the persona's session file");
	assert.ok(args.includes("--continue"), "the resumed child must continue the prior session");
	assert.equal(flagValue(args, "--tools"), "read,grep,find", "the resumed child keeps the persona's tools");
	const extension = flagValue(args, "--extension");
	assert.ok(extension !== undefined && extension.endsWith("guardrails"), "the resumed child must still load guardrails");
	assert.equal(flagValue(args, "--system-prompt"), "You are scout.", "pi rebuilds the system prompt from the flag at every start and never restores it from the session, so the persona prompt must be re-applied on continue");
	const block = result.content[0];
	assert.ok(block && block.type === "text" && block.text.includes(ANSWER), "the tool must return the resumed subagent's answer");
});

test("agent_continue for an unknown persona returns a friendly error and does not spawn", async () => {
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	const continueTool = fake.tools.find((t) => t.name === CONTINUE_TOOL);
	assert.ok(continueTool, "the extension must register the agent_continue tool");

	const dir = await tempCwd(); // no personas at all

	const result = await continueTool.execute("id", { persona: "ghost", task: "do it" }, undefined, undefined, continueToolCtx(dir));

	assert.equal(fake.execCalls.length, 0, "an unknown persona must not spawn a child");
	const block = result.content[0];
	assert.ok(block && block.type === "text" && /ghost/.test(block.text), "the error must name the unknown persona");
	assert.ok(block && block.type === "text" && !block.text.includes(ANSWER), "an unknown persona must not read as a successful run");
});

test("agent_continue for a persona with no prior session returns a friendly error and does not spawn", async () => {
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	const continueTool = fake.tools.find((t) => t.name === CONTINUE_TOOL);
	assert.ok(continueTool, "the extension must register the agent_continue tool");

	const dir = await tempCwd();
	await writePersona(dir, "scout.md", "---\nname: scout\ndescription: Maps the repository.\n---\nYou are scout.");
	// No writeSession: the persona exists but was never dispatched, so there is nothing to resume.

	const result = await continueTool.execute("id", { persona: "scout", task: "do it" }, undefined, undefined, continueToolCtx(dir));

	assert.equal(fake.execCalls.length, 0, "a persona with no prior session must not spawn a child");
	const block = result.content[0];
	assert.ok(block && block.type === "text" && /no prior session/i.test(block.text), "the error must explain there is no prior session to resume");
	assert.ok(block && block.type === "text" && !block.text.includes(ANSWER), "a missing session must not read as a successful run");
});

test("a persona with an unsafe name dispatches with no --session flag (its name can't be a safe path segment)", async () => {
	// A persona name is operator-authored and parsePersona only requires it non-empty, so a name
	// like "a/b" is reachable. sessionPathFor returns null for it, so dispatch's null sub-case must
	// run the child WITHOUT a --session flag rather than letting the name escape the sessions dir.
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	const dir = await tempCwd();
	// The FILE name is safe (weird.md); only the frontmatter name "a/b" is path-unsafe.
	await writePersona(dir, "weird.md", "---\nname: a/b\ndescription: An oddly named persona.\ntools:\n  - read\n---\nYou are weird.");
	const ctx = { cwd: dir, ui: { notify() {} }, hasUI: false } as unknown as CommandCtx;

	await fake.commandHandler("a/b map the repo", ctx);

	assert.equal(fake.execCalls.length, 1, "the unsafe-named persona must still dispatch a child");
	const args = fake.execCalls[0]?.args ?? [];
	assert.equal(args.indexOf("--session"), -1, "an unsafe persona name must dispatch with no --session flag");
	// Tools still apply, proving this is the persona path (session null), not the no-persona path.
	assert.equal(flagValue(args, "--tools"), "read", "the unsafe-named persona's own tools still reach the child");
});

test("agent_continue for a persona with an unsafe name returns the unsafe-name error and does not spawn", async () => {
	// resolveContinueTarget finds the persona by name, but sessionPathFor returns null for an unsafe
	// name, so the continue must reject with the unsafe-name error before any child is spawned.
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	const continueTool = fake.tools.find((t) => t.name === CONTINUE_TOOL);
	assert.ok(continueTool, "the extension must register the agent_continue tool");

	const dir = await tempCwd();
	await writePersona(dir, "weird.md", "---\nname: a/b\ndescription: An oddly named persona.\n---\nYou are weird.");

	const result = await continueTool.execute("id", { persona: "a/b", task: "do it" }, undefined, undefined, continueToolCtx(dir));

	assert.equal(fake.execCalls.length, 0, "an unsafe persona name must not spawn a child");
	const block = result.content[0];
	assert.ok(block && block.type === "text" && /unsafe name/i.test(block.text), "the error must explain the persona's name is unsafe");
	assert.ok(block && block.type === "text" && !block.text.includes(ANSWER), "an unsafe name must not read as a successful run");
});

test("/agent-continue resumes a persona's session and injects the answer as a follow-up", async () => {
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	assert.ok(fake.continueHandler, "the extension must register the agent-continue command");

	const dir = await tempCwd();
	await writePersona(dir, "scout.md", "---\nname: scout\ndescription: Maps the repository.\ntools:\n  - read\n---\nYou are scout.");
	await writeSession(dir, "scout");
	const ctx = { cwd: dir, ui: { notify() {} }, hasUI: false } as unknown as CommandCtx;

	await fake.continueHandler("scout now check the tests", ctx);

	assert.equal(fake.execCalls.length, 1, "the command must resume exactly one child");
	const args = fake.execCalls[0]?.args ?? [];
	assert.equal(flagValue(args, "--session"), join(dir, ".pi", "sessions", "scout.jsonl"), "the command must resume the persona's session file");
	assert.ok(args.includes("--continue"), "the command must continue the prior session");
	assert.equal(fake.sent.length, 1, "the resumed answer must be injected once");
	const sent = fake.sent[0];
	assert.ok(sent, "a follow-up message must be delivered");
	assert.ok(typeof sent.content === "string" && sent.content.includes(ANSWER), "the follow-up must carry the resumed subagent's answer");
	assert.equal(sent.options?.deliverAs, "followUp");
});

test("/agent-continue for a persona with no prior session notifies and does not spawn", async () => {
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	assert.ok(fake.continueHandler, "the extension must register the agent-continue command");

	const dir = await tempCwd();
	await writePersona(dir, "scout.md", "---\nname: scout\ndescription: Maps the repository.\n---\nYou are scout.");
	// No writeSession: scout was never dispatched, so there is no session to resume.
	const notes: Note[] = [];

	await fake.continueHandler("scout follow up", notifyingCtx(dir, notes));

	assert.equal(fake.execCalls.length, 0, "a missing prior session must not spawn a child");
	assert.equal(fake.sent.length, 0, "a missing prior session must not inject a follow-up");
	const warning = notes.find((note) => note.level === "warning" && /no prior session/i.test(note.msg));
	assert.ok(warning, "the operator must be told there is no prior session to resume");
});

test("/agent-continue without a follow-up task notifies usage and does not resume", async () => {
	const fake = makeFakePi();
	subagents(fake.pi, { exec: fake.exec });
	assert.ok(fake.continueHandler, "the extension must register the agent-continue command");

	const dir = await tempCwd();
	await writePersona(dir, "scout.md", "---\nname: scout\ndescription: Maps the repository.\n---\nYou are scout.");
	await writeSession(dir, "scout"); // a resumable session exists, so only the missing task should stop it
	const notes: Note[] = [];

	await fake.continueHandler("scout", notifyingCtx(dir, notes));

	assert.equal(fake.execCalls.length, 0, "a bare persona name with no task must not resume a child");
	assert.equal(fake.sent.length, 0, "a usage error must not inject a follow-up");
	const usage = notes.find((note) => note.level === "warning" && /usage/i.test(note.msg));
	assert.ok(usage, "a missing follow-up task must notify the command's usage");
});

/** One setWidget call as the capturing ctx records it; content stays unknown so the test narrows it. */
interface WidgetCall {
	key: string;
	content: unknown;
	options: { placement?: string } | undefined;
}

/** A command ctx with a live UI that records every setWidget call, so a test can assert the dashboard was pushed. */
const widgetCapturingCtx = (cwd: string, widgets: WidgetCall[]): CommandCtx =>
	({
		cwd,
		hasUI: true,
		ui: {
			notify() {},
			setWidget(key: string, content: unknown, options?: { placement?: string }): void {
				widgets.push({ key, content, options });
			},
		},
	}) as unknown as CommandCtx;

test("dispatching a persona through /agent pushes the live grid dashboard showing the persona's card", async () => {
	// The grid widget is the user-facing surface: a persona dispatch must render the roster to the
	// footer (setWidget, aboveEditor) and tag the run with its persona, so the dispatched run shows
	// up as scout's card — an untagged run would be titled by its task instead.
	const fake = makeFakePi();
	subagents(fake.pi);
	assert.ok(fake.commandHandler, "the extension must register the agent command");

	const dir = await tempCwd();
	await writePersona(dir, "scout.md", "---\nname: scout\ndescription: Maps the repo.\ntools:\n  - read\n---\nYou are scout.");
	const widgets: WidgetCall[] = [];

	await fake.commandHandler("scout map the repo", widgetCapturingCtx(dir, widgets));

	assert.ok(widgets.length > 0, "dispatching a persona must push the grid dashboard to the UI via setWidget");
	const dashboard = widgets.find((widget): widget is WidgetCall & { content: string[] } => Array.isArray(widget.content));
	assert.ok(dashboard, "the pushed widget must carry the rendered grid as a string array");
	assert.ok(
		dashboard.content.every((line) => typeof line === "string"),
		"the dashboard content must be an array of strings",
	);
	assert.ok(
		dashboard.content.join("\n").includes("scout"),
		"the dashboard must show the dispatched run as scout's card, proving the run was tagged with its persona",
	);
	assert.equal(dashboard.options?.placement, "aboveEditor", "the dashboard widget must be placed above the editor");
});
