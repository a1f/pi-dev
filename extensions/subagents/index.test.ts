import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import subagents from "./index.ts";

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

interface FakePi {
	commandHandler: CommandHandler | undefined;
	tool: ToolDef | undefined;
	execCalls: ExecCall[];
	sent: SentMessage[];
	pi: ExtensionAPI;
}

function makeFakePi(): FakePi {
	const fake: FakePi = {
		commandHandler: undefined,
		tool: undefined,
		execCalls: [],
		sent: [],
		pi: undefined as unknown as ExtensionAPI,
	};
	const pi = {
		registerCommand(name: string, options: { handler: CommandHandler }): void {
			assert.equal(name, "agent");
			fake.commandHandler = options.handler;
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
	};
	fake.pi = pi as unknown as ExtensionAPI;
	return fake;
}

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

test("the agent_dispatch tool returns the subagent answer as its text content", async () => {
	const fake = makeFakePi();
	subagents(fake.pi);
	assert.ok(fake.tool, "the extension must register the agent_dispatch tool");

	const result = await fake.tool.execute("id", { task: "summarize the README" }, undefined, undefined, toolCtx);

	assert.equal(fake.execCalls.length, 1, "the tool must spawn exactly one child");
	const block = result.content[0];
	assert.ok(block && block.type === "text" && block.text.includes(ANSWER), "the tool result must include the subagent's answer");
});
