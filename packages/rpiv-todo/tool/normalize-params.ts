import type { TodoParams } from "./types.ts";

/**
 * Pi's `prepareArguments` hook: undo a double-encoded `tasks[]` before schema
 * validation. Some tool-call parsers (vLLM/LiteLLM-served GLM/Qwen-class models)
 * emit nested structures as JSON strings — `tasks` itself, or its items — the same
 * shape rpiv-ask-user-question decodes for `questions` (#244). Only a string at an
 * array/object position is decoded, and only when it parses to the expected shape;
 * anything else is passed through untouched so validation still reports the real
 * problem. Well-formed arguments are returned as-is.
 */
export function prepareTodoArguments(args: unknown): TodoParams {
	if (!isRecord(args) || args.tasks === undefined) return args as TodoParams;
	const tasks = decodeArray(args.tasks);
	if (!Array.isArray(tasks)) return args as TodoParams;
	const decoded = tasks.map(decodeObject);
	if (tasks === args.tasks && decoded.every((item, i) => item === tasks[i])) return args as TodoParams;
	return { ...args, tasks: decoded } as unknown as TodoParams;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON string holding an array → that array; anything else unchanged. */
function decodeArray(value: unknown): unknown {
	const parsed = typeof value === "string" ? parseJson(value) : value;
	return Array.isArray(parsed) ? parsed : value;
}

/** A JSON string holding an object → that object; anything else unchanged. */
function decodeObject(value: unknown): unknown {
	const parsed = typeof value === "string" ? parseJson(value) : value;
	return isRecord(parsed) ? parsed : value;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
