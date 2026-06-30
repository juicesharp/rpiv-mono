import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	type RenderSource,
	renderBranch,
	renderStreamingMessage,
	type StreamingHandle,
	type ViewerEntry,
	type ViewerMessage,
} from "./lane-transcript.js";

/** Identity theme — fg returns its text unchanged so render assertions read plainly. */
const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
} as unknown as Theme;

const makeTui = (rows = 24) => ({ requestRender: vi.fn(), terminal: { rows } }) as unknown as TUI;
const source: RenderSource = { cwd: "/tmp", toolDef: () => undefined };

const assistantEntry = (text: string): ViewerEntry => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});
const userEntry = (text: string): ViewerEntry => ({
	type: "message",
	message: { role: "user", content: [{ type: "text", text }] },
});
const toolCallEntry = (id: string, name: string, args: Record<string, unknown> = {}): ViewerEntry => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});
const toolResultEntry = (toolCallId: string, text: string): ViewerEntry =>
	({
		type: "message",
		message: { role: "toolResult", toolCallId, toolName: "bash", isError: false, content: [{ type: "text", text }] },
	}) as unknown as ViewerEntry;

// The SDK message components read a module-global theme proxy that throws until
// initialized. In production the host calls initTheme(); the test must too.
beforeAll(() => {
	initTheme();
});

describe("renderBranch — shared transcript replay", () => {
	it("renders assistant + user text entries to a flat body", () => {
		const out = renderBranch(
			[assistantEntry("hi from assistant"), userEntry("a user turn")],
			120,
			source,
			makeTui(),
			identityTheme,
			false,
		).join("\n");
		expect(out).toContain("hi from assistant");
		expect(out).toContain("a user turn");
	});

	it("folds a toolResult into its matching toolCall by id (not the dim collapse)", () => {
		const out = renderBranch(
			[toolCallEntry("call-1", "bash", { command: "echo hi" }), toolResultEntry("call-1", "TOOL_OUTPUT_MARKER")],
			120,
			source,
			makeTui(),
			identityTheme,
			false,
		).join("\n");
		expect(out).toContain("TOOL_OUTPUT_MARKER"); // result folded into the ToolExecutionComponent
		expect(out).not.toContain("└ tool result"); // not the dim collapse
	});

	it("collapses an unknown-role entry to a single dim line (fail-soft)", () => {
		const out = renderBranch(
			[{ type: "message", message: { role: "mysteryRole" } }],
			120,
			source,
			makeTui(),
			identityTheme,
			false,
		).join("\n");
		expect(out).toContain("· mysteryRole");
	});

	it("never throws on a malformed (message-less) entry", () => {
		expect(() =>
			renderBranch([{ type: "message" } as ViewerEntry], 120, source, makeTui(), identityTheme, false),
		).not.toThrow();
	});

	it("strips OSC-133 shell-integration markers so they don't become stray blank lines", () => {
		// The SDK AssistantMessageComponent emits `ESC]133;A/B/C` prompt markers; off the real
		// prompt those bytes render as invisible blank rows that doubled the preview's line count
		// (the live-output region looked oversized + half-empty). renderBranch must scrub them.
		const body = renderBranch(
			[assistantEntry("line-a"), assistantEntry("line-b")],
			120,
			source,
			makeTui(),
			identityTheme,
			false,
		);
		expect(body.join("\n")).not.toMatch(/\x1b\]133;/); // no marker sequences survive
		// And no marker-only blank rows: every emitted line carries visible content.
		expect(body.every((l) => l.replace(/\s/g, "").length > 0)).toBe(true);
		expect(body.join("\n")).toContain("line-a");
		expect(body.join("\n")).toContain("line-b");
	});
});

const thinkingPartial = (thinking: string): ViewerMessage => ({
	role: "assistant",
	content: [{ type: "thinking", thinking }],
});

describe("renderStreamingMessage — live partial render", () => {
	it("renders an assistant thinking partial's text", () => {
		const { component, lines } = renderStreamingMessage(undefined, thinkingPartial("pondering the plan"), 120);
		expect(component).toBeDefined();
		expect(lines.join("\n")).toContain("pondering the plan");
	});

	it("reuses the previous handle across ticks (one persistent component, updated in place)", () => {
		const first = renderStreamingMessage(undefined, thinkingPartial("step one"), 120);
		const second = renderStreamingMessage(first.component, thinkingPartial("step one then two"), 120);
		expect(second.component).toBe(first.component); // same instance
		expect(second.lines.join("\n")).toContain("step one then two");
	});

	it("clears the handle on an undefined partial (turn committed → dedup)", () => {
		const prev: StreamingHandle | undefined = renderStreamingMessage(undefined, thinkingPartial("x"), 120).component;
		const { component, lines } = renderStreamingMessage(prev, undefined, 120);
		expect(component).toBeUndefined();
		expect(lines).toEqual([]);
	});

	it("ignores a non-assistant partial", () => {
		const { component, lines } = renderStreamingMessage(
			undefined,
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			120,
		);
		expect(component).toBeUndefined();
		expect(lines).toEqual([]);
	});
});
