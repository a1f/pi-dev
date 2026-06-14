import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AUDIT_TYPE, COMMAND, LOG_COMMAND, RUNS_DIR } from "./constants.ts";
import subagents from "./index.ts";
import { type SubagentRunAudit } from "./log.ts";

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

interface ExecCall {
	command: string;
	args: string[];
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
	execCalls: ExecCall[];
	sent: SentMessage[];
	audits: AuditCall[];
	/** When set, pi.appendEntry throws so tests can exercise the best-effort swallow. */
	appendThrows: boolean;
	pi: ExtensionAPI;
}

function makeFakePi(): FakePi {
	const fake: FakePi = {
		commandHandler: undefined,
		logHandler: undefined,
		tool: undefined,
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
			fake.tool = tool;
		},
		exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> {
			fake.execCalls.push({ command, args });
			return Promise.resolve({ stdout: happyStream, stderr: "", code: 0, killed: false });
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
const flagValue = (args: string[], flag: string): string | undefined => {
	const i = args.indexOf(flag);
	return i === -1 ? undefined : args[i + 1];
};

/** Write a persona markdown file into <cwd>/.pi/agents so loadPersonas can find it. */
const writePersona = async (cwd: string, file: string, content: string): Promise<void> => {
	const agents = join(cwd, ".pi", "agents");
	await mkdir(agents, { recursive: true });
	await writeFile(join(agents, file), content, "utf8");
};

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

test("a named persona applies its tools and system prompt, and the child still loads guardrails", async () => {
	const fake = makeFakePi();
	subagents(fake.pi);
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

test("a plain dispatch (no persona) still loads guardrails and runs with the default read-only tools", async () => {
	const fake = makeFakePi();
	subagents(fake.pi);
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
	subagents(fake.pi);
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
	subagents(fake.pi);
	assert.ok(fake.tool, "the extension must register the agent_dispatch tool");

	await fake.tool.execute("id", { task: "summarize the README" }, undefined, undefined, toolCtx);

	assert.equal(fake.execCalls.length, 1, "the tool must spawn exactly one child");
	const args = fake.execCalls[0]?.args ?? [];
	const extension = flagValue(args, "--extension");
	assert.ok(extension !== undefined && extension.endsWith("guardrails"), "the tool path must load guardrails too");
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

test("the /agent handler surfaces a warning for a malformed persona file and still dispatches", async () => {
	// loadPersonas skips a malformed file but reports it in `warnings`; the handler must
	// surface that to the operator (not silently drop it) and still run the requested task.
	const fake = makeFakePi();
	subagents(fake.pi);
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
