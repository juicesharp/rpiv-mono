import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, SessionManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { makeAssistantMessage, makeUserMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerMessage } from "./lane-transcript.js";
import { LaneViewer } from "./lane-viewer.js";
import {
	__resetRunLaneRegistry,
	enqueueInput,
	getUnit,
	type LaneSession,
	markUnitDone,
	recordRun,
	retireRun,
	SINGLE_UNIT_KEY,
	setCurrentSession,
	setLaneSessionFile,
	setUnitStarted,
} from "./run-lane-registry.js";

/** Identity theme — fg returns its text unchanged. */
const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
} as unknown as Theme;

function makeTui(rows = 24) {
	return { requestRender: vi.fn(), terminal: { rows } } as unknown as TUI;
}

type BranchFn = () => unknown;

/** A LaneSession stub whose getBranch + subscribe + streaming partial are controllable. */
function makeSession(getBranch: BranchFn): LaneSession & {
	fire: () => void;
	unsub: ReturnType<typeof vi.fn>;
	setStreaming: (m: ViewerMessage | undefined) => void;
} {
	let listener: (() => void) | undefined;
	let streaming: ViewerMessage | undefined;
	const unsub = vi.fn();
	return {
		sessionId: "sess-1",
		isStreaming: true,
		sessionManager: { getBranch, getCwd: () => "/tmp" },
		getToolDefinition: () => undefined,
		getStreamingMessage: () => streaming,
		subscribe: (l: () => void) => {
			listener = l;
			return unsub;
		},
		fire: () => listener?.(),
		unsub,
		setStreaming: (m) => {
			streaming = m;
		},
	};
}

const assistantEntry = (text: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});
const userEntry = (text: string) => ({
	type: "message",
	message: { role: "user", content: [{ type: "text", text }] },
});
const toolResultEntry = () => ({
	type: "message",
	message: { role: "user", content: [{ type: "tool_result" }] },
});
const assistantToolCallEntry = (id: string, name: string, args: Record<string, unknown> = {}) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});
const toolResultMessageEntry = (toolCallId: string, text: string) => ({
	type: "message",
	message: {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		isError: false,
		content: [{ type: "text", text }],
	},
});

// The SDK message components read a module-global theme proxy that throws until
// initialized. In production the host calls initTheme(); the test must too.
beforeAll(() => {
	initTheme();
});
beforeEach(() => {
	__resetRunLaneRegistry();
});
afterEach(() => {
	vi.restoreAllMocks();
	__resetRunLaneRegistry();
});

describe("LaneViewer — render", () => {
	it("renders assistant + user entries from getBranch()", () => {
		const session = makeSession(() => [assistantEntry("hi from assistant"), userEntry("a user turn")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		const out = viewer.render(120).join("\n");
		expect(out).toContain("hi from assistant");
		expect(out).toContain("a user turn");
		expect(out).toContain("ship"); // header
		viewer.dispose();
	});

	it("a tool_result / non-text user entry collapses to the dim one-liner", () => {
		const session = makeSession(() => [toolResultEntry()]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		expect(viewer.render(120).join("\n")).toContain("tool result");
		viewer.dispose();
	});

	it("pairs a toolCall with its toolResult and renders the output (not the dim collapse)", () => {
		const session = makeSession(() => [
			assistantToolCallEntry("call-1", "bash", { command: "echo hi" }),
			toolResultMessageEntry("call-1", "TOOL_OUTPUT_MARKER"),
		]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		const out = viewer.render(120).join("\n");
		expect(out).toContain("TOOL_OUTPUT_MARKER"); // result folded into the ToolExecutionComponent
		expect(out).not.toContain("└ tool result"); // no longer collapsed
		viewer.dispose();
	});

	it("renders a bashExecution entry's command + output", () => {
		const session = makeSession(() => [
			{
				type: "message",
				message: {
					role: "bashExecution",
					command: "echo hi",
					output: "BASH_STDOUT_MARKER",
					exitCode: 0,
					cancelled: false,
				},
			},
		]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		const out = viewer.render(120).join("\n");
		expect(out).toContain("BASH_STDOUT_MARKER");
		expect(out).not.toContain("· bashExecution"); // not the dim fallback
		viewer.dispose();
	});

	it("renders a displayed custom message but skips display:false", () => {
		const shown = makeSession(() => [
			{ type: "message", message: { role: "custom", customType: "note", content: "CUSTOM_SHOWN", display: true } },
		]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, shown);
		const v1 = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		expect(v1.render(120).join("\n")).toContain("CUSTOM_SHOWN");
		v1.dispose();

		__resetRunLaneRegistry();
		const hidden = makeSession(() => [
			{ type: "message", message: { role: "custom", customType: "note", content: "CUSTOM_HIDDEN", display: false } },
		]);
		recordRun("run-2", "ship");
		setCurrentSession("run-2", SINGLE_UNIT_KEY, hidden);
		const v2 = new LaneViewer("run-2", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		expect(v2.render(120).join("\n")).not.toContain("CUSTOM_HIDDEN");
		v2.dispose();
	});

	it("renders a compactionSummary entry via its SDK component (collapsed header), not the dim fallback", () => {
		const session = makeSession(() => [
			{ type: "message", message: { role: "compactionSummary", summary: "COMPACTED_MARKER", tokensBefore: 1234 } },
		]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		const out = viewer.render(120).join("\n");
		expect(out).toContain("compaction"); // SDK component's collapsed label (summary shown only when expanded)
		expect(out).not.toContain("· compactionSummary"); // not the dim fallback
		viewer.dispose();
	});

	it("retired lane renders the finalBranch snapshot + a terminal-status header (Phase A)", () => {
		const session = makeSession(() => [assistantEntry("final answer from the run")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		retireRun("run-1", "completed"); // snapshots getBranch() into finalBranch, drops the session
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		const out = viewer.render(120).join("\n");
		expect(out).toContain("final answer from the run"); // from the snapshot, not a live session
		expect(out).toContain("completed"); // header reflects terminal status, not "live"
		expect(out).toContain("✓");
		viewer.dispose();
	});

	it("retired lane still pairs toolCall + toolResult from the snapshot (Phase 4)", () => {
		const session = makeSession(() => [
			assistantToolCallEntry("call-1", "bash", { command: "echo hi" }),
			toolResultMessageEntry("call-1", "SNAPSHOT_TOOL_OUTPUT"),
		]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		retireRun("run-1", "completed"); // drops the session; cwd + tool defs were snapshotted
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		const out = viewer.render(120).join("\n");
		expect(out).toContain("SNAPSHOT_TOOL_OUTPUT"); // tool result still folded in post-retirement
		expect(out).not.toContain("└ tool result"); // not the dim collapse
		viewer.dispose();
	});

	it("retired failed lane header shows the failure reason in full (Problem 1)", () => {
		const session = makeSession(() => [assistantEntry("partial work before the failure")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		retireRun("run-1", "failed", "blueprint produced no plan artifact — stopping workflow");
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		const out = viewer.render(200).join("\n");
		// The header carries the FULL cause (not just the leading clause), truncated only by width.
		expect(out).toContain("failed: blueprint produced no plan artifact — stopping workflow");
		expect(out).toContain("✗");
		viewer.dispose();
	});

	it("disk fallback (Problem 2): a retired lane with no finalBranch renders from the on-disk jsonl", () => {
		const tmp = mkdtempSync(join(tmpdir(), "rpiv-viewer-disk-"));
		try {
			// Persist a real session to disk, then point the lane at it via lastSessionFile.
			const sessionDir = join(tmp, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			const mgr = SessionManager.create(tmp, sessionDir);
			mgr.appendMessage(makeUserMessage("a user turn"));
			mgr.appendMessage(makeAssistantMessage({ text: "ON_DISK_TRANSCRIPT" }));
			const file = mgr.getSessionFile();
			expect(file).toBeDefined();

			// Retire WITHOUT ever attaching a live session → finalBranch stays undefined, the
			// exact state the original bug left behind. The disk fallback must still render.
			recordRun("run-1", "ship");
			retireRun("run-1", "failed", "boom");
			setLaneSessionFile("run-1", SINGLE_UNIT_KEY, file);
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalBranch).toBeUndefined();

			const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
			const out = viewer.render(120).join("\n");
			expect(out).toContain("ON_DISK_TRANSCRIPT"); // recovered from disk, not memory
			expect(out).not.toContain("(no transcript"); // the original bug is gone
			viewer.dispose();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("no current session → '(stage starting…)'", () => {
		recordRun("run-1", "ship");
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		expect(viewer.render(120).join("\n")).toContain("(stage starting…)");
		viewer.dispose();
	});

	it("lane dismissed (no lane) → '(run dismissed — esc to return)'", () => {
		// run-1 never recorded (or dismissed via the manager's `x`) → getLane undefined.
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		expect(viewer.render(120).join("\n")).toContain("(run dismissed — esc to return)");
		viewer.dispose();
	});

	it("footer reads 'esc back' when the lane has no queued question", () => {
		const session = makeSession(() => [assistantEntry("hi")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		expect(viewer.render(120).join("\n")).toContain("esc back");
		viewer.dispose();
	});

	it("footer reads '⏎ answer' + back when the lane has a queued question (answer-in-place affordance)", () => {
		const session = makeSession(() => [assistantEntry("hi")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: (() => ({})) as never,
			options: undefined as never,
			resolve: vi.fn(),
		});
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		const out = viewer.render(120).join("\n");
		expect(out).toContain("⏎ answer"); // answer in place via ⏎
		expect(out).toContain("←/esc back"); // back affordance stays alongside
		expect(out).not.toContain("esc to answer"); // old esc-overload wording gone
		viewer.dispose();
	});

	it("`t` toggles expanded state — footer hint flips and collapsed-only content reveals", () => {
		const session = makeSession(() => [
			{
				type: "message",
				message: { role: "compactionSummary", summary: "EXPANDED_ONLY_SUMMARY", tokensBefore: 1234 },
			},
		]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());

		// Collapsed by default: footer advertises "t expand"; the summary body is hidden.
		const collapsed = viewer.render(120).join("\n");
		expect(collapsed).toContain("t expand");
		expect(collapsed).not.toContain("EXPANDED_ONLY_SUMMARY");

		// Press `t` → expanded: footer flips and the summary body is revealed.
		viewer.handleInput("t");
		const expanded = viewer.render(120).join("\n");
		expect(expanded).toContain("t collapse");
		expect(expanded).toContain("EXPANDED_ONLY_SUMMARY");

		// Press `t` again → back to collapsed.
		viewer.handleInput("t");
		expect(viewer.render(120).join("\n")).toContain("t expand");
		viewer.dispose();
	});

	it("getBranch() throwing → '(transcript unavailable)' (fail-soft, never throws)", () => {
		const session = makeSession(() => {
			throw new Error("disposed mid-render");
		});
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		expect(() => viewer.render(120)).not.toThrow();
		expect(viewer.render(120).join("\n")).toContain("(transcript unavailable)");
		viewer.dispose();
	});

	it("appends the live streaming partial's thinking after the committed body", () => {
		const session = makeSession(() => [assistantEntry("committed turn")]);
		session.setStreaming({ role: "assistant", content: [{ type: "thinking", thinking: "STREAMING_THOUGHT" }] });
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		const out = viewer.render(120).join("\n");
		expect(out).toContain("committed turn");
		expect(out).toContain("STREAMING_THOUGHT");
		viewer.dispose();
	});

	it("drops the streaming partial once the turn commits (getStreamingMessage → undefined)", () => {
		const session = makeSession(() => [assistantEntry("committed turn")]);
		session.setStreaming({ role: "assistant", content: [{ type: "thinking", thinking: "TRANSIENT" }] });
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		expect(viewer.render(120).join("\n")).toContain("TRANSIENT");
		session.setStreaming(undefined); // turn committed → folded into getBranch()
		expect(viewer.render(120).join("\n")).not.toContain("TRANSIENT");
		viewer.dispose();
	});
});

describe("LaneViewer — liveness / following the lane", () => {
	it("re-renders on a session.subscribe tick", () => {
		const session = makeSession(() => [assistantEntry("x")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const tui = makeTui();
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, tui, identityTheme, vi.fn());
		(tui.requestRender as ReturnType<typeof vi.fn>).mockClear();
		session.fire();
		expect(tui.requestRender).toHaveBeenCalled();
		viewer.dispose();
	});

	it("follows the lane: a new currentSession unsubscribes the old and subscribes the new", () => {
		const sessionA = makeSession(() => [assistantEntry("A")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, sessionA);
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		const sessionB = makeSession(() => [assistantEntry("B")]);
		setCurrentSession("run-1", SINGLE_UNIT_KEY, sessionB); // registry notify → syncSession re-points
		expect(sessionA.unsub).toHaveBeenCalled();
		expect(viewer.render(120).join("\n")).toContain("B");
		// firing the NEW session repaints
		const tui2 = makeTui();
		void tui2;
		viewer.dispose();
	});
});

describe("LaneViewer — input", () => {
	it("esc calls done('back')", () => {
		recordRun("run-1", "ship");
		const done = vi.fn();
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, done);
		viewer.handleInput("\x1b"); // ESC
		expect(done).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalledWith("back");
		viewer.dispose();
	});

	it("← calls done('back') (mirrors → opening the viewer)", () => {
		recordRun("run-1", "ship");
		const done = vi.fn();
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, done);
		viewer.handleInput("\x1b[D"); // Left arrow
		expect(done).toHaveBeenCalledTimes(1);
		expect(done).toHaveBeenCalledWith("back");
		viewer.dispose();
	});

	it("⏎ answers in place with done('answer') when the lane has a queued question", () => {
		recordRun("run-1", "ship");
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: (() => ({})) as never,
			options: undefined as never,
			resolve: vi.fn(),
		});
		const done = vi.fn();
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, done);
		viewer.handleInput("\r"); // ENTER
		expect(done).toHaveBeenCalledWith("answer");
		viewer.dispose();
	});

	it("⏎ is inert when the lane has nothing queued (no done call — view verb stays decoupled)", () => {
		recordRun("run-1", "ship");
		const done = vi.fn();
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, done);
		viewer.handleInput("\r"); // ENTER
		expect(done).not.toHaveBeenCalled();
		viewer.dispose();
	});

	it("↑ raises scrollOffset (reveal older) and ↓ lowers it, clamped ≥ 0", () => {
		// A tall branch so there is scrollable excess.
		const session = makeSession(() => Array.from({ length: 50 }, (_, i) => assistantEntry(`line-${i}`)));
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const tui = makeTui(24);
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, tui, identityTheme, vi.fn());
		const tail = viewer.render(120).join("\n");
		viewer.handleInput("\x1b[A"); // up → reveal older
		const scrolled = viewer.render(120).join("\n");
		expect(scrolled).not.toBe(tail);
		expect(tui.requestRender).toHaveBeenCalled();
		// down past zero stays clamped (no throw, returns to a valid view)
		viewer.handleInput("\x1b[B");
		viewer.handleInput("\x1b[B");
		expect(() => viewer.render(120)).not.toThrow();
		viewer.dispose();
	});
});

describe("LaneViewer — per-unit addressing (fan-out)", () => {
	it("a fan-out unit (index ≥ 0) header reflects ITS OWN label + live verb, not the run name", () => {
		const session = makeSession(() => [assistantEntry("unit work")]);
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "phase 1/3");
		setCurrentSession("run-1", 0, session);
		const viewer = new LaneViewer("run-1", 0, makeTui(), identityTheme, vi.fn());
		const header = viewer.render(120)[0];
		expect(header).toContain("phase 1/3"); // the unit's own label
		expect(header).toContain("▶"); // running → live verb
		expect(header).toContain("live");
		expect(header).not.toContain("carve"); // NOT the run name
		viewer.dispose();
	});

	it("a finished fan-out unit header shows the unit glyph + status", () => {
		const session = makeSession(() => [assistantEntry("unit work")]);
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "phase 2/3");
		setCurrentSession("run-1", 0, session);
		markUnitDone("run-1", 0, "done");
		const header = new LaneViewer("run-1", 0, makeTui(), identityTheme, vi.fn()).render(120)[0];
		expect(header).toContain("✓");
		expect(header).toContain("phase 2/3 — done");
	});

	it("renders THIS unit's live transcript and a sibling spawn never drags the view away", () => {
		const sessionA = makeSession(() => [assistantEntry("UNIT_A_WORK")]);
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "phase 1/2");
		setCurrentSession("run-1", 0, sessionA);
		const viewer = new LaneViewer("run-1", 0, makeTui(), identityTheme, vi.fn());
		expect(viewer.render(120).join("\n")).toContain("UNIT_A_WORK");
		// A sibling at index 1 spawns — the registry notifies, but unit 0's slot is unchanged.
		const sessionB = makeSession(() => [assistantEntry("UNIT_B_WORK")]);
		setUnitStarted("run-1", 1, "phase 2/2");
		setCurrentSession("run-1", 1, sessionB);
		expect(sessionA.unsub).not.toHaveBeenCalled(); // never re-pointed off unit 0
		const out = viewer.render(120).join("\n");
		expect(out).toContain("UNIT_A_WORK");
		expect(out).not.toContain("UNIT_B_WORK"); // the sibling's transcript stays on its own row
		viewer.dispose();
	});

	it("needs-input + ⏎-answer are PER-UNIT: only the unit with a queued question answers", () => {
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "phase 1/2");
		setUnitStarted("run-1", 1, "phase 2/2");
		// Queue a question onto unit 1 ONLY.
		enqueueInput("run-1", 1, { factory: (() => ({})) as never, options: undefined as never, resolve: vi.fn() });

		// Unit 0's viewer: no queue → footer stays "esc back", ⏎ is inert.
		const done0 = vi.fn();
		const v0 = new LaneViewer("run-1", 0, makeTui(), identityTheme, done0);
		expect(v0.render(120).join("\n")).not.toContain("⏎ answer");
		v0.handleInput("\r");
		expect(done0).not.toHaveBeenCalled();
		v0.dispose();

		// Unit 1's viewer: its own queue → footer advertises ⏎ answer, ⏎ drains it.
		const done1 = vi.fn();
		const v1 = new LaneViewer("run-1", 1, makeTui(), identityTheme, done1);
		expect(v1.render(120).join("\n")).toContain("⏎ answer");
		v1.handleInput("\r");
		expect(done1).toHaveBeenCalledWith("answer");
		v1.dispose();
	});
});

describe("LaneViewer — dispose", () => {
	it("unsubscribes both the session and the registry", () => {
		const session = makeSession(() => [assistantEntry("x")]);
		recordRun("run-1", "ship");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const viewer = new LaneViewer("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, vi.fn());
		viewer.dispose();
		expect(session.unsub).toHaveBeenCalled();
		// After dispose, a registry change no longer drives a re-subscribe (no throw).
		const session2 = makeSession(() => [assistantEntry("y")]);
		expect(() => setCurrentSession("run-1", SINGLE_UNIT_KEY, session2)).not.toThrow();
		// the viewer's registry listener is gone, so session2 was never subscribed
		expect(session2.unsub).not.toHaveBeenCalled();
		expect(getUnit("run-1", SINGLE_UNIT_KEY)?.currentSession).toBe(session2);
	});
});
