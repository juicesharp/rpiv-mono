import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerMessage } from "./lane-transcript.js";
import { LaneTranscriptView } from "./lane-transcript-view.js";
import {
	__resetRunLaneRegistry,
	type LaneSession,
	recordRun,
	retireRun,
	SINGLE_UNIT_KEY,
	seedPendingUnits,
	setCurrentSession,
	setUnitStarted,
} from "./run-lane-registry.js";

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
} as unknown as Theme;

function makeTui(rows = 24) {
	return { requestRender: vi.fn(), terminal: { rows } } as unknown as TUI;
}

function makeSession(getBranch: () => unknown): LaneSession & {
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
		getUsage: () => undefined,
		subscribe: (l: () => void) => {
			listener = l;
			return unsub;
		},
		fire: () => listener?.(),
		unsub,
		setStreaming: (m: ViewerMessage | undefined) => {
			streaming = m;
		},
	} as unknown as LaneSession & {
		fire: () => void;
		unsub: ReturnType<typeof vi.fn>;
		setStreaming: (m: ViewerMessage | undefined) => void;
	};
}

const assistantEntry = (text: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

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

describe("LaneTranscriptView", () => {
	it("renders the live branch body", () => {
		recordRun("run-1", "ship");
		const session = makeSession(() => [assistantEntry("hello from the lane")]);
		setUnitStarted("run-1", SINGLE_UNIT_KEY, "unit");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const view = new LaneTranscriptView("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme);
		expect(view.renderBody(80, false).join("\n")).toContain("hello from the lane");
		expect(view.hasLiveSession()).toBe(true);
	});

	it("appends the streaming partial then clears it on commit", () => {
		recordRun("run-1", "ship");
		const session = makeSession(() => [assistantEntry("committed turn")]);
		setUnitStarted("run-1", SINGLE_UNIT_KEY, "unit");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const view = new LaneTranscriptView("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme);
		session.setStreaming({
			role: "assistant",
			content: [{ type: "text", text: "…thinking live" }],
		} as unknown as ViewerMessage);
		expect(view.renderBody(80, false).join("\n")).toContain("…thinking live");
		session.setStreaming(undefined); // turn commits
		expect(view.renderBody(80, false).join("\n")).not.toContain("…thinking live");
	});

	it("returns a dim placeholder when the run is dismissed", () => {
		const view = new LaneTranscriptView("ghost", SINGLE_UNIT_KEY, makeTui(), identityTheme);
		expect(view.renderBody(80, false).join("\n")).toContain("run dismissed");
		expect(view.hasLiveSession()).toBe(false);
	});

	it("returns a stage-starting placeholder for a running lane with no session/snapshot", () => {
		recordRun("run-1", "ship");
		const view = new LaneTranscriptView("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme);
		expect(view.renderBody(80, false).join("\n")).toContain("stage starting");
	});

	it("shows a fanned-out placeholder on the lane row during a live fan-out generation", () => {
		recordRun("run-1", "build");
		seedPendingUnits("run-1", [
			{ index: 0, label: "phase 1/2" },
			{ index: 1, label: "phase 2/2" },
		]);
		// The lane (parent) row resolves the scalar slot, which clearUnitLanes wiped —
		// the disk glob would show an ARBITRARY sibling's transcript, so it must not run.
		const view = new LaneTranscriptView("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme);
		expect(view.renderBody(80, false).join("\n")).toContain("fanned out — select a unit row");
	});

	it("keeps the disk fallback for a RETIRED lane's row (no fanned-out placeholder)", () => {
		recordRun("run-1", "build");
		seedPendingUnits("run-1", [{ index: 0, label: "phase 1/1" }]);
		retireRun("run-1", "completed");
		const view = new LaneTranscriptView("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme);
		// No jsonl exists under this cwd, so the disk path degrades to the terminal
		// placeholder — the point is the fan-out gate did NOT fire on a retired lane.
		const body = view.renderBody(80, false).join("\n");
		expect(body).not.toContain("fanned out");
		expect(body).toContain("no transcript");
	});

	it("shows a pending placeholder for a seeded-but-unstarted unit sub-row", () => {
		recordRun("run-1", "build");
		seedPendingUnits("run-1", [
			{ index: 0, label: "phase 1/2" },
			{ index: 1, label: "phase 2/2" },
		]);
		const view = new LaneTranscriptView("run-1", 1, makeTui(), identityTheme);
		expect(view.renderBody(80, false).join("\n")).toContain("unit pending — no transcript yet");
		// The unit starts and publishes its live session → the placeholder yields to the body.
		const session = makeSession(() => [assistantEntry("unit one is live")]);
		setUnitStarted("run-1", 1, "phase 2/2");
		setCurrentSession("run-1", 1, session);
		expect(view.renderBody(80, false).join("\n")).toContain("unit one is live");
	});

	it("re-points to a new child session on a stage transition", () => {
		recordRun("run-1", "ship");
		const first = makeSession(() => [assistantEntry("stage one")]);
		setUnitStarted("run-1", SINGLE_UNIT_KEY, "unit");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, first);
		const view = new LaneTranscriptView("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme);
		expect(view.renderBody(80, false).join("\n")).toContain("stage one");
		const second = makeSession(() => [assistantEntry("stage two")]);
		setCurrentSession("run-1", SINGLE_UNIT_KEY, second); // registry change → syncSession re-points
		expect(first.unsub).toHaveBeenCalled(); // old session unsubscribed
		expect(view.renderBody(80, false).join("\n")).toContain("stage two");
	});

	it("dispose unsubscribes the session and the registry", () => {
		recordRun("run-1", "ship");
		const session = makeSession(() => [assistantEntry("x")]);
		setUnitStarted("run-1", SINGLE_UNIT_KEY, "unit");
		setCurrentSession("run-1", SINGLE_UNIT_KEY, session);
		const view = new LaneTranscriptView("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme);
		view.dispose();
		expect(session.unsub).toHaveBeenCalled();
	});
});
