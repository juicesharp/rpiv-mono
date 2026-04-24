import type { Theme } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";

// Stub the full renderer so the terminal-state branch returns a recognisable sentinel
// instead of executing nicobailon's real renderer (which needs a full Theme).
// vi.hoisted is required because vi.mock factories are top-hoisted and can't close
// over file-level consts.
const { renderSubagentResultMock } = vi.hoisted(() => ({
	renderSubagentResultMock: vi.fn(() => ({ __sentinel: "full-render" }) as unknown),
}));
vi.mock("pi-subagents/render", () => ({ renderSubagentResult: renderSubagentResultMock }));

import { buildQuietRenderCall, buildQuietRenderResult } from "./renderer-override.js";

function makeTheme(): Theme {
	return {
		fg: (_c: string, t: string) => t,
		bold: (t: string) => t,
	} as unknown as Theme;
}

describe("buildQuietRenderCall — layout-stable status trailer from first frame", () => {
	it("composes original call + status trailer when no original is provided", () => {
		const render = buildQuietRenderCall(undefined);
		// No original renderCall → just the trailer.
		const out = render({}, makeTheme(), { executionStarted: false, state: {} });
		expect(out).toBeInstanceOf(Text);
	});

	it("emits pending glyph when !executionStarted (before markExecutionStarted)", () => {
		const render = buildQuietRenderCall(undefined);
		const out = render({}, makeTheme(), { executionStarted: false, state: {} }) as Text;
		// Our stubbed theme.fg is identity, so Text content includes the literal glyph + label.
		const text = (out as unknown as { text?: string }).text ?? "";
		expect(text).toContain("○");
		expect(text).toContain("pending");
	});

	it("emits running glyph when executionStarted === true", () => {
		const render = buildQuietRenderCall(undefined);
		const out = render({}, makeTheme(), { executionStarted: true, state: {} }) as Text;
		const text = (out as unknown as { text?: string }).text ?? "";
		expect(text).toContain("◐");
		expect(text).toContain("running");
	});

	it("wraps original call + trailer in a Container when both are present", () => {
		const originalCall = vi.fn(() => new Text("subagent peer-comparator", 0, 0));
		const render = buildQuietRenderCall(originalCall);
		const out = render({}, makeTheme(), { executionStarted: true, state: {} });
		expect(out).toBeInstanceOf(Container);
		expect(originalCall).toHaveBeenCalledOnce();
	});

	it("suppresses trailer once state.subagentTerminal is set (final frame)", () => {
		const originalCall = vi.fn(() => new Text("subagent peer-comparator", 0, 0));
		const render = buildQuietRenderCall(originalCall);
		const out = render({}, makeTheme(), { executionStarted: true, state: { subagentTerminal: true } });
		// Should return the original call as-is, no Container wrapping with trailer.
		expect(out).toBeInstanceOf(Text);
		expect(originalCall).toHaveBeenCalledOnce();
	});
});

describe("buildQuietRenderResult — non-terminal stub + terminal delegation", () => {
	it("returns zero-height stub while progress.status === 'running' (renderCall owns trailer)", () => {
		renderSubagentResultMock.mockClear();
		const render = buildQuietRenderResult();
		const out = render(
			{ details: { results: [{ agent: "x", progress: { status: "running" } }] } },
			{ expanded: false, isPartial: true },
			makeTheme(),
			{ state: {} },
		);
		expect(out).toBeInstanceOf(Text);
		expect(renderSubagentResultMock).not.toHaveBeenCalled();
	});

	it("returns zero-height stub when progress is MISSING (pre-progress first frame)", () => {
		renderSubagentResultMock.mockClear();
		const render = buildQuietRenderResult();
		const out = render({ details: { results: [{ agent: "x" }] } }, { expanded: false }, makeTheme(), { state: {} });
		expect(out).toBeInstanceOf(Text);
		expect(renderSubagentResultMock).not.toHaveBeenCalled();
	});

	it("returns zero-height stub when result.details is missing entirely", () => {
		renderSubagentResultMock.mockClear();
		const render = buildQuietRenderResult();
		const out = render({}, { expanded: false }, makeTheme(), { state: {} });
		expect(out).toBeInstanceOf(Text);
	});

	it("delegates to full renderer once terminal AND isPartial === false", () => {
		renderSubagentResultMock.mockClear();
		const state: { subagentTerminal?: boolean } = {};
		const render = buildQuietRenderResult();
		const out = render(
			{ details: { results: [{ agent: "x", exitCode: 0, progress: { status: "complete" } }] } },
			{ expanded: false, isPartial: false },
			makeTheme(),
			{ state },
		);
		expect(renderSubagentResultMock).toHaveBeenCalledOnce();
		expect((out as { __sentinel?: string }).__sentinel).toBe("full-render");
		// State flag is set so renderCall suppresses its trailer next frame.
		expect(state.subagentTerminal).toBe(true);
	});

	it("keeps stub when terminal but isPartial === true (don't commit until final)", () => {
		renderSubagentResultMock.mockClear();
		const render = buildQuietRenderResult();
		const out = render(
			{ details: { results: [{ agent: "x", exitCode: 0 }] } },
			{ expanded: false, isPartial: true },
			makeTheme(),
			{ state: {} },
		);
		expect(out).toBeInstanceOf(Text);
		expect(renderSubagentResultMock).not.toHaveBeenCalled();
	});

	it("delegates to full renderer on error stopReason (terminal)", () => {
		renderSubagentResultMock.mockClear();
		const render = buildQuietRenderResult();
		const out = render(
			{ details: { results: [{ agent: "x", stopReason: "error" }] } },
			{ expanded: false, isPartial: false },
			makeTheme(),
			{ state: {} },
		);
		expect(renderSubagentResultMock).toHaveBeenCalledOnce();
		expect((out as { __sentinel?: string }).__sentinel).toBe("full-render");
	});

	it("treats exitCode present + status=running as NON-terminal (streaming finalisation window)", () => {
		renderSubagentResultMock.mockClear();
		const render = buildQuietRenderResult();
		const out = render(
			{ details: { results: [{ agent: "x", exitCode: 0, progress: { status: "running" } }] } },
			{ expanded: false, isPartial: true },
			makeTheme(),
			{ state: {} },
		);
		expect(out).toBeInstanceOf(Text);
		expect(renderSubagentResultMock).not.toHaveBeenCalled();
	});
});
