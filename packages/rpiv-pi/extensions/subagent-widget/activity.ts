/**
 * Pure formatters for the subagent-tree widget's activity line.
 *
 * describeActivity() derives a one-line "what is this agent doing?"
 * string from SingleResult.messages. formatToolCall() pretty-prints
 * common tool calls (read/write/edit/bash/grep/find/ls) with their
 * primary arg; unknown tools fall back to a JSON preview.
 */

import { homedir } from "node:os";
import type { SingleResult } from "./types.js";

const TOOL_VERB: Record<string, string> = {
	read: "reading",
	write: "writing",
	edit: "editing",
	bash: "running",
	grep: "searching",
	find: "finding",
	ls: "listing",
};

function shortenPath(p: string): string {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function truncateLine(text: string, len = 60): string {
	const line =
		text
			.split("\n")
			.find((l) => l.trim())
			?.trim() ?? "";
	if (line.length <= len) return line;
	return `${line.slice(0, len)}…`;
}

export function formatToolCall(name: string, args: Record<string, unknown>): string {
	const verb = TOOL_VERB[name] ?? name;
	switch (name) {
		case "bash": {
			const cmd = (args.command as string) ?? "";
			const preview = cmd.length > 40 ? `${cmd.slice(0, 40)}…` : cmd;
			return `${verb} ${preview}`;
		}
		case "read":
		case "write":
		case "edit": {
			const raw = (args.file_path ?? args.path) as string | undefined;
			return raw ? `${verb} ${shortenPath(raw)}` : verb;
		}
		case "grep":
		case "find": {
			const pattern = (args.pattern as string) ?? "";
			return pattern ? `${verb} /${pattern}/` : verb;
		}
		case "ls": {
			const raw = (args.path as string) ?? "";
			return raw ? `${verb} ${shortenPath(raw)}` : verb;
		}
		default: {
			const preview = JSON.stringify(args);
			const trimmed = preview.length > 40 ? `${preview.slice(0, 40)}…` : preview;
			return `${name} ${trimmed}`;
		}
	}
}

interface AssistantPart {
	type: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface MessageLike {
	role: string;
	content?: AssistantPart[];
}

export function describeActivity(result: SingleResult | undefined): string {
	if (!result) return "thinking…";
	const messages = result.messages as unknown as MessageLike[];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const content = msg.content ?? [];
		for (let j = content.length - 1; j >= 0; j--) {
			const part = content[j];
			if (part.type === "toolCall") {
				return formatToolCall(part.name ?? "", part.arguments ?? {});
			}
			if (part.type === "text") {
				const line = truncateLine(part.text ?? "");
				if (line) return line;
			}
		}
	}
	return "thinking…";
}

export function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

export function formatDuration(startedAt: number, completedAt?: number): string {
	const end = completedAt ?? Date.now();
	const seconds = ((end - startedAt) / 1000).toFixed(1);
	return completedAt ? `${seconds}s` : `${seconds}s (running)`;
}

export function formatTurns(turns: number, maxTurns?: number | null): string {
	return maxTurns != null ? `⟳${turns}≤${maxTurns}` : `⟳${turns}`;
}
