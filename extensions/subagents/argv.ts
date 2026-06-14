// Spawn-argv builder for headless one-shot pi children.
//
// Pure: it only computes the argv array (no child_process, no I/O), so the
// launch contract can be unit-tested in isolation. The resulting child streams
// JSON events that events.ts parses.

/** pi's documented read-only tool allowlist (`pi --tools read,grep,find,ls -p ...`). */
export const READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface SpawnArgvOptions {
	/**
	 * The one-shot prompt, passed as the trailing `-p` argument. pi only consumes
	 * the next arg as the prompt when it does not start with `-` or `@` (pi has no
	 * `--` end-of-options terminator), so the task MUST NOT begin with either —
	 * `buildSpawnArgv` enforces this and throws otherwise.
	 */
	task: string;
	/** Tool allowlist; defaults to READONLY_TOOLS. */
	tools?: readonly string[];
	/** Optional model override (`--model <pattern>`). */
	model?: string;
}

/**
 * Build the argv for a headless child: JSON event stream, no auto-loaded
 * extensions (recursion guard so the child never re-loads subagents), a tool
 * allowlist, and the task as the trailing `-p` prompt.
 */
export function buildSpawnArgv(options: SpawnArgvOptions): string[] {
	// pi keys off the literal first character of the prompt: a leading `-` is read
	// as a flag and a leading `@` as a context file, so neither reaches `-p` as the
	// prompt. There is no `--` escape, so reject it here at the boundary.
	if (options.task.startsWith("-") || options.task.startsWith("@")) {
		throw new Error(
			`task must not begin with '-' or '@' (pi would read it as a flag or context file, not the prompt): ${options.task}`,
		);
	}
	const tools = options.tools ?? READONLY_TOOLS;
	const model = options.model === undefined ? [] : ["--model", options.model];
	return ["--mode", "json", ...model, "--no-extensions", "--tools", tools.join(","), "-p", options.task];
}
