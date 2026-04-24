/**
 * Shared types for the subagent-tree widget.
 *
 * SingleResult / SubagentDetails mirror the shape emitted by pi-subagents
 * (nicobailon fork) and the pi-coding-agent bundled subagent example. Both
 * upstream sources expose this shape through examples, not stable public
 * type exports, so we duplicate locally to insulate from drift.
 */

import type { Message } from "@mariozechner/pi-ai";

export type RunMode = "single" | "chain" | "parallel";

export type RunStatus = "running" | "completed" | "error" | "aborted" | "steered" | "stopped";

export type ErrorStatus = Extract<RunStatus, "error" | "aborted" | "steered" | "stopped">;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

export interface SubagentDetails {
	mode: RunMode;
	agentScope: string;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

/**
 * Per-toolCallId state snapshot. Mutated in place on update — preserves
 * reference identity so tui.requestRender() sees fresh data without
 * re-invoking the setWidget factory.
 */
export interface TrackedRun {
	toolCallId: string;
	mode: RunMode;
	status: RunStatus;
	startedAt: number;
	completedAt?: number;
	displayName: string;
	description: string;
	results: SingleResult[];
	errorMessage?: string;
}
