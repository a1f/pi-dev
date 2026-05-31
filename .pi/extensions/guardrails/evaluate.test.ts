import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateNormalized, type NormalizedCall } from "./evaluate.ts";
import type { CompiledRules } from "./rules.ts";

const HOME = "/home/agent";
const CWD = "/home/agent/repo";

const rules: CompiledRules = {
	mode: "continue",
	bashToolPatterns: [
		{ regex: /\bgit\s+push\s+.*--force(?!-with-lease)/, reason: "git push --force", ask: false },
		{ regex: /\brm\s+-[a-z]*[rf]/, reason: "rm with recursive/force", ask: false },
	],
	zeroAccessPaths: [".env", "*.pem", "~/.ssh/"],
	readOnlyPaths: ["package-lock.json"],
	noDeletePaths: ["README.md", ".git/"],
};

const bash = (command: string): NormalizedCall => ({ kind: "bash", command });
const read = (path: string): NormalizedCall => ({ kind: "paths", paths: [path], write: false });
const write = (path: string): NormalizedCall => ({ kind: "paths", paths: [path], write: true });
const evalCall = (call: NormalizedCall): ReturnType<typeof evaluateNormalized> => evaluateNormalized(call, rules, CWD, HOME);

test("read .env is blocked (zeroAccess)", () => {
	assert.equal(evalCall(read(".env"))?.category, "zeroAccess");
});

test("bash `cat secret.pem` is blocked — wildcard enforced on bash", () => {
	assert.equal(evalCall(bash("cat secret.pem"))?.category, "zeroAccess");
});

test("bash `cat $HOME/.ssh/id_rsa` is blocked", () => {
	assert.equal(evalCall(bash("cat $HOME/.ssh/id_rsa"))?.category, "zeroAccess");
});

test("git push --force is blocked (bashPattern)", () => {
	assert.equal(evalCall(bash("git push origin main --force"))?.category, "bashPattern");
});

test("git status is allowed", () => {
	assert.equal(evalCall(bash("git status")), null);
});

test("a normal file write is allowed", () => {
	assert.equal(evalCall(write("src/app.ts")), null);
});

test("write to a lockfile is blocked (readOnly)", () => {
	assert.equal(evalCall(write("package-lock.json"))?.category, "readOnly");
});

test("`npm run format` is not a false positive", () => {
	assert.equal(evalCall(bash("npm run format")), null);
});

test("`rm README.md` is caught (noDelete)", () => {
	assert.equal(evalCall(bash("rm README.md"))?.category, "noDelete");
});

test("reading a normal source file is allowed", () => {
	assert.equal(evalCall(read("src/index.ts")), null);
});
