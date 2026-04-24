import type { ExtensionUIContext, Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetState, onEnd, onStart, onUpdate } from "./run-tracker.js";
import type { SingleResult, SubagentDetails } from "./types.js";
import { SubagentWidget } from "./widget.js";

function makeTheme(): Theme {
	return {
		fg: (_c: string, t: string) => t,
		bold: (t: string) => t,
		strikethrough: (t: string) => t,
	} as unknown as Theme;
}

function makeTUI(): TUI {
	return {
		requestRender: vi.fn(),
		terminal: { columns: 120, rows: 40 },
	} as unknown as TUI;
}

interface Captured {
	key: string;
	factory: ((tui: TUI, theme: Theme) => { render: (w: number) => string[]; invalidate: () => void }) | undefined;
}

function makeUICtx(): { ctx: ExtensionUIContext; captured: Captured[] } {
	const captured: Captured[] = [];
	const setWidget = vi.fn((key: string, factory: Captured["factory"]) => {
		captured.push({ key, factory });
	});
	const ctx = { setWidget } as unknown as ExtensionUIContext;
	return { ctx, captured };
}

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "scout",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		...overrides,
	};
}

function makeDetails(mode: "single" | "chain" | "parallel", results: SingleResult[]): SubagentDetails {
	return { mode, agentScope: "user", projectAgentsDir: null, results };
}

function renderOnce(widget: SubagentWidget, ctx: ExtensionUIContext, captured: Captured[]): string[] {
	widget.setUICtx(ctx);
	widget.update();
	const last = captured[captured.length - 1];
	if (!last?.factory) return [];
	const comp = last.factory(makeTUI(), makeTheme());
	return comp.render(120);
}

beforeEach(() => {
	__resetState();
});

describe("SubagentWidget render — empty", () => {
	it("pre-registers the widget slot even when no runs tracked (claim top position above Todos)", () => {
		const { ctx, captured } = makeUICtx();
		const widget = new SubagentWidget();
		widget.setUICtx(ctx);
		widget.update();
		expect(captured).toHaveLength(1);
		// renderWidget returns [] when no runs — no visible footprint.
		const comp = captured[0].factory?.(makeTUI(), makeTheme());
		expect(comp?.render(120)).toEqual([]);
	});
});

describe("SubagentWidget render — single", () => {
	it("renders heading + 2-line running block", () => {
		onStart("t1", { agent: "scout", task: "probe" });
		onUpdate("t1", makeDetails("single", [makeResult()]));
		const { ctx, captured } = makeUICtx();
		const lines = renderOnce(new SubagentWidget(), ctx, captured);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("Subagents");
		expect(lines[1]).toContain("scout");
		expect(lines[2]).toContain("⎿");
	});

	it("renders live tool-uses + tokens from details.progress during streaming", () => {
		onStart("t1", { agent: "scout", task: "probe" });
		onUpdate("t1", {
			mode: "single",
			agentScope: "user",
			projectAgentsDir: null,
			results: [
				makeResult({
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 3 },
				}),
			],
			progress: [{ status: "running", toolCount: 7, tokens: 42_000, durationMs: 3_500, currentTool: "bash" }],
		});
		const { ctx, captured } = makeUICtx();
		const lines = renderOnce(new SubagentWidget(), ctx, captured);
		expect(lines[1]).toContain("⟳3");
		expect(lines[1]).toContain("7 tool uses");
		expect(lines[1]).toContain("42.0k");
		expect(lines[2]).toContain("running");
	});
});

describe("SubagentWidget render — chain", () => {
	it("shows step i/n in header", () => {
		onStart("t1", {
			chain: [
				{ agent: "a", task: "x" },
				{ agent: "b", task: "y" },
			],
		});
		onUpdate("t1", makeDetails("chain", [makeResult({ step: 1 })]));
		const { ctx, captured } = makeUICtx();
		const lines = renderOnce(new SubagentWidget(), ctx, captured);
		expect(lines[1]).toContain("step 1/2");
	});
});

describe("SubagentWidget render — parallel", () => {
	it("shows k/m done in header", () => {
		onStart("t1", {
			tasks: [
				{ agent: "a", task: "x" },
				{ agent: "b", task: "y" },
				{ agent: "c", task: "z" },
			],
		});
		onUpdate(
			"t1",
			makeDetails("parallel", [
				makeResult({ exitCode: 0 }),
				makeResult({ exitCode: -1 }),
				makeResult({ exitCode: -1 }),
			]),
		);
		const { ctx, captured } = makeUICtx();
		const lines = renderOnce(new SubagentWidget(), ctx, captured);
		expect(lines[1]).toContain("1/3 done");
	});
});

describe("SubagentWidget render — finished", () => {
	it("renders ✓ for completed", () => {
		onStart("t1", { agent: "scout", task: "probe" });
		onEnd("t1", { details: makeDetails("single", [makeResult()]) }, false);
		const { ctx, captured } = makeUICtx();
		const lines = renderOnce(new SubagentWidget(), ctx, captured);
		expect(lines[1]).toContain("✓");
	});

	it("renders ✗ + error message for error", () => {
		onStart("t1", { agent: "scout", task: "probe" });
		onEnd("t1", { details: makeDetails("single", [makeResult({ exitCode: 1, errorMessage: "boom" })]) }, true);
		const { ctx, captured } = makeUICtx();
		const lines = renderOnce(new SubagentWidget(), ctx, captured);
		expect(lines[1]).toContain("✗");
		expect(lines[1]).toContain("boom");
	});

	it.each([
		["aborted", "✗"],
		["steered", "✓"],
		["stopped", "■"],
	])("renders icon for stopReason=%s", (stopReason, expectedIcon) => {
		onStart("t1", { agent: "scout", task: "probe" });
		onEnd("t1", { details: makeDetails("single", [makeResult({ stopReason })]) }, true);
		const { ctx, captured } = makeUICtx();
		const lines = renderOnce(new SubagentWidget(), ctx, captured);
		expect(lines[1]).toContain(expectedIcon);
	});
});

describe("SubagentWidget render — overflow", () => {
	it("shows +N more footer when body exceeds maxBody", () => {
		for (let i = 0; i < 8; i++) {
			onStart(`t${i}`, { agent: `agent${i}`, task: "x" });
			onUpdate(`t${i}`, makeDetails("single", [makeResult()]));
		}
		const { ctx, captured } = makeUICtx();
		const lines = renderOnce(new SubagentWidget(), ctx, captured);
		expect(lines.length).toBeLessThanOrEqual(12);
		const footer = lines[lines.length - 1];
		expect(footer).toMatch(/\+\d+ more/);
		expect(footer).toContain("running");
	});
});

describe("SubagentWidget render — tail connector", () => {
	it("swaps ├─ to └─ on the final line when nothing else follows", () => {
		onStart("t1", { agent: "scout", task: "probe" });
		onEnd("t1", { details: makeDetails("single", [makeResult()]) }, false);
		const { ctx, captured } = makeUICtx();
		const lines = renderOnce(new SubagentWidget(), ctx, captured);
		expect(lines[lines.length - 1]).toContain("└─");
		expect(lines[lines.length - 1]).not.toMatch(/^├─/);
	});
});

describe("SubagentWidget render — invalidate", () => {
	it("re-registers on next update() after invalidate()", () => {
		onStart("t1", { agent: "scout", task: "probe" });
		onUpdate("t1", makeDetails("single", [makeResult()]));
		const { ctx, captured } = makeUICtx();
		const widget = new SubagentWidget();
		widget.setUICtx(ctx);
		widget.update();
		const first = captured[captured.length - 1];
		first.factory?.(makeTUI(), makeTheme()).invalidate();
		widget.update();
		expect(captured.length).toBe(2);
	});
});

describe("SubagentWidget render — newline safety", () => {
	it("never emits embedded newlines even with multi-line tasks (running)", () => {
		onStart("t1", {
			agent: "peer-comparator",
			task: "Peer-mirror check.\n\nPeerPairs (orchestrator-computed):\n[list of (new_file, peer_file) tuples]\n\nFor each pair, Read BOTH files in full.",
		});
		onUpdate("t1", makeDetails("single", [makeResult()]));
		const { ctx, captured } = makeUICtx();
		const lines = renderOnce(new SubagentWidget(), ctx, captured);
		for (const line of lines) {
			expect(line).not.toMatch(/[\r\n]/);
		}
	});

	it("never emits embedded newlines after the run completes (finished line)", () => {
		onStart("t1", {
			agent: "peer-comparator",
			task: "Peer-mirror check.\n\nPeerPairs (orchestrator-computed):\n[list]",
		});
		onEnd("t1", { details: makeDetails("single", [makeResult()]) }, false);
		const { ctx, captured } = makeUICtx();
		const lines = renderOnce(new SubagentWidget(), ctx, captured);
		for (const line of lines) {
			expect(line).not.toMatch(/[\r\n]/);
		}
	});

	it("never emits embedded newlines in error trail", () => {
		onStart("t1", { agent: "scout", task: "x" });
		onEnd(
			"t1",
			{
				details: makeDetails("single", [
					makeResult({ exitCode: 1, stopReason: "error", errorMessage: "boom\nstack\nmore" }),
				]),
			},
			true,
		);
		const { ctx, captured } = makeUICtx();
		const lines = renderOnce(new SubagentWidget(), ctx, captured);
		for (const line of lines) {
			expect(line).not.toMatch(/[\r\n]/);
		}
	});
});
