import assert from "node:assert/strict";
import { test } from "node:test";

import { commandDeletes, commandMutates, matchPath, resolvePath, tokenizeCommand } from "./match.ts";

const HOME = "/home/agent";
const CWD = "/home/agent/repo";

const match = (input: string, pattern: string): boolean => matchPath(resolvePath(input, CWD, HOME), pattern, CWD, HOME);

test("wildcard secret matches by basename (the *.pem-on-bash bug)", () => {
	assert.equal(match("secret.pem", "*.pem"), true);
	assert.equal(match("id_rsa", "*.pem"), false);
});

test("~, $HOME, and absolute forms of the ssh path all match ~/.ssh/", () => {
	for (const token of ["~/.ssh/id_rsa", "$HOME/.ssh/id_rsa", "/home/agent/.ssh/id_rsa"]) {
		assert.equal(match(token, "~/.ssh/"), true, token);
	}
	assert.equal(match("src/app.ts", "~/.ssh/"), false);
});

test("literal patterns require an exact basename (no substring false-positive)", () => {
	assert.equal(match("package-lock.json", "package-lock.json"), true);
	assert.equal(match("my-package-lock.json.bak", "package-lock.json"), false);
});

test("directory pattern matches by path segment", () => {
	assert.equal(match(".git/config", ".git/"), true);
	assert.equal(match("src/app.ts", ".git/"), false);
});

test("tokenizeCommand splits on shell metacharacters", () => {
	assert.deepEqual(tokenizeCommand("cat secret.pem"), ["cat", "secret.pem"]);
	assert.deepEqual(tokenizeCommand("echo x > .env"), ["echo", "x", ".env"]);
});

test("verb detection is word-boundary aware", () => {
	assert.equal(commandDeletes("npm run format"), false);
	assert.equal(commandMutates("npm run format"), false);
	assert.equal(commandDeletes("rm -rf build"), true);
	assert.equal(commandMutates("sed -i s/a/b/ file"), true);
});
