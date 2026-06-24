import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type RenderSource, renderBranch, type ViewerEntry } from "./lane-transcript.js";

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
});
