/**
 * Claude Code transcripts in rpiv-workflow's branch shape.
 *
 * The runner reads a stage's outcome off `BranchEntry[]`: assistant text for
 * collectors, `tool_use` parts for the tool-call collector, and the LAST
 * assistant entry's `stopReason` for `classifyStop`. Claude's streamed
 * assistant frames carry `stop_reason: null`, so the turn's verdict comes from
 * the SDK's `result` message and is stamped onto the last assistant entry.
 *
 * Only main-thread frames count. Subagent frames (`parent_tool_use_id` set, or
 * `isSidechain` on disk) are the subagent's own work, not the stage's answer.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BranchEntry } from "@juicesharp/rpiv-workflow";

type Content = NonNullable<BranchEntry["message"]>["content"];
export type StopReason = NonNullable<NonNullable<BranchEntry["message"]>["stopReason"]>;

export function userEntry(text: string): BranchEntry {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

export function assistantEntry(content: unknown, stopReason?: StopReason): BranchEntry {
	const parts = Array.isArray(content) ? (content as Content) : [];
	return { type: "message", message: { role: "assistant", content: parts, ...(stopReason ? { stopReason } : {}) } };
}

/** The SDK `result` message → the runner's stop vocabulary. */
export function stopReasonForResult(result: { subtype: string; stop_reason?: string | null }): StopReason {
	if (result.subtype === "success") return result.stop_reason === "max_tokens" ? "length" : "stop";
	if (result.subtype === "error_max_turns") return "length";
	return "error";
}

/** Stamp `reason` on the last assistant entry, adding an empty one when the turn produced none. */
export function stampStop(branch: BranchEntry[], reason: StopReason, fromIndex: number): void {
	for (let i = branch.length - 1; i >= fromIndex; i--) {
		const m = branch[i]!.message;
		if (m?.role === "assistant") {
			m.stopReason = reason;
			return;
		}
	}
	branch.push(assistantEntry([], reason));
}

/** Root of Claude Code's session store: `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Claude Code's project directory name for `cwd`: every non-alphanumeric becomes `-`. */
export function projectDirName(cwd: string): string {
	return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Find `<config>/projects/<dir>/<sessionId>.jsonl`, trying `cwd`'s own project
 * directory first: the same id can exist under more than one project (a resumed
 * or inherited session), and the stage's file is the one in its own project.
 */
export function locateSessionFile(sessionId: string, configDir = claudeConfigDir(), cwd?: string): string | undefined {
	const projects = join(configDir, "projects");
	if (!sessionId || !existsSync(projects)) return undefined;
	const dirs = readdirSync(projects);
	const own = cwd ? projectDirName(cwd) : undefined;
	for (const dir of own && dirs.includes(own) ? [own, ...dirs.filter((d) => d !== own)] : dirs) {
		const candidate = join(projects, dir, `${sessionId}.jsonl`);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Read a persisted Claude session as a branch: main-thread user/assistant
 * messages in file order. Fail-soft — an unreadable file or line is skipped,
 * matching the `readSessionBranch` contract (death-scene capture must never throw).
 */
export function readSessionBranch(file: string): BranchEntry[] | undefined {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const branch: BranchEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let row: { type?: string; isSidechain?: boolean; message?: { role?: string; content?: unknown } };
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (row.isSidechain || (row.type !== "user" && row.type !== "assistant") || !row.message) continue;
		const content = row.message.content;
		if (row.type === "assistant") branch.push(assistantEntry(content));
		else if (typeof content === "string") branch.push(userEntry(content));
		else if (Array.isArray(content)) branch.push({ type: "message", message: { role: "user", content } });
	}
	return branch;
}
