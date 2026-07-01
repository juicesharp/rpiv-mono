import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionUIContext, initTheme, SessionManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import askUserQuestionExtension from "@juicesharp/rpiv-ask-user-question";
import { createMockPi, makeAssistantMessage, makeUserMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cappedTui, LaneConsole, showLaneConsole } from "./lane-console.js";
import type { ViewerMessage } from "./lane-transcript.js";
import type { LaneUsage } from "./lane-usage.js";
import {
	__resetRunLaneRegistry,
	enqueueInput,
	getUnit,
	type LaneSession,
	markUnitDone,
	peekInput,
	recordRun,
	retireRun,
	SINGLE_UNIT_KEY,
	seedPendingUnits,
	setCurrentSession,
	setLaneSessionFile,
	setUnitStarted,
} from "./run-lane-registry.js";

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
} as unknown as Theme;

function makeTui(rows = 24) {
	return { requestRender: vi.fn(), terminal: { rows, columns: 100 } } as unknown as TUI;
}

/** A LaneSession stub whose getBranch + subscribe + streaming partial + usage are controllable. */
function makeSession(getBranch: () => unknown): LaneSession & {
	fire: () => void;
	unsub: ReturnType<typeof vi.fn>;
	setStreaming: (m: ViewerMessage | undefined) => void;
	setUsage: (u: Record<string, unknown> | undefined) => void;
} {
	let listener: (() => void) | undefined;
	let streaming: ViewerMessage | undefined;
	let usage: Record<string, unknown> | undefined;
	const unsub = vi.fn();
	return {
		sessionId: "s",
		isStreaming: true,
		sessionManager: { getBranch, getCwd: () => "/tmp" },
		getToolDefinition: () => undefined,
		getStreamingMessage: () => streaming,
		getUsage: () => usage,
		subscribe: (l: () => void) => {
			listener = l;
			return unsub;
		},
		fire: () => listener?.(),
		unsub,
		setStreaming: (m: ViewerMessage | undefined) => {
			streaming = m;
		},
		setUsage: (u: Record<string, unknown> | undefined) => {
			usage = u;
		},
	} as unknown as LaneSession & {
		fire: () => void;
		unsub: ReturnType<typeof vi.fn>;
		setStreaming: (m: ViewerMessage | undefined) => void;
		setUsage: (u: Record<string, unknown> | undefined) => void;
	};
}

const assistantEntry = (text: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

/** Stub embedded question component that records forwarded keystrokes. */
function makeInner(lines = 3) {
	const handled: string[] = [];
	const dispose = vi.fn();
	const component = {
		render: (_w: number) => Array.from({ length: lines }, (_v, i) => `q${i}`),
		handleInput: (d: string) => {
			handled.push(d);
		},
		invalidate: vi.fn(),
		dispose,
	} as unknown as Component;
	return { component, handled, dispose };
}

/** Record + start a live single-stage lane with a controllable session (no question queued). */
function liveUnit(branch: () => unknown = () => [assistantEntry("ctx line")]): void {
	recordRun("run-1", "ship");
	setUnitStarted("run-1", SINGLE_UNIT_KEY, "unit");
	setCurrentSession("run-1", SINGLE_UNIT_KEY, makeSession(branch));
}

/** Enqueue a question whose factory returns `component`; resolves via `resolve`. */
function enqueueQuestion(component: Component, resolve = vi.fn()): void {
	enqueueInput("run-1", SINGLE_UNIT_KEY, {
		factory: (() => component) as never,
		options: undefined as never,
		resolve,
	});
}

/** The real ask_user_question tool's overlay factory shape: (tui, theme, kb, done) → component. */
type RealQuestionFactory = (tui: TUI, theme: Theme, kb: unknown, done: (result: unknown) => void) => Component;

/**
 * Register the real ask_user_question tool and capture the overlay factory its execute()
 * hands to ctx.ui.custom. execute() awaits a dynamic import before reaching custom(), and
 * the mock custom() parks forever (only the factory is extracted), so execute() itself never
 * settles — we fire it WITHOUT awaiting and settle the capture via vi.waitFor.
 */
async function captureRealFactory(params: Record<string, unknown>): Promise<RealQuestionFactory> {
	const { pi, captured } = createMockPi();
	askUserQuestionExtension(pi);
	const tool = captured.tools.get("ask_user_question");
	let factory: RealQuestionFactory | undefined;
	const ctx = {
		hasUI: true,
		ui: {
			custom: async (f: RealQuestionFactory) => {
				factory = f;
				return new Promise<unknown>(() => {}); // permanently parked — only the factory is extracted
			},
		},
	} as never;
	void tool!.execute("tcid", params, undefined, undefined, ctx);
	await vi.waitFor(() => {
		if (!factory) throw new Error("ask_user_question factory was not captured");
	});
	return factory!;
}

/** Enqueue the real questionnaire factory as a PendingInput (mirrors lane-relay-ui.ts:79). */
function enqueueRealFactory(factory: RealQuestionFactory, resolve = vi.fn()): void {
	enqueueInput("run-1", SINGLE_UNIT_KEY, { factory: factory as never, options: undefined as never, resolve });
}

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

describe("cappedTui", () => {
	it("reports the capped rows and forwards columns + requestRender", () => {
		const real = makeTui(40);
		const capped = cappedTui(real, () => 7);
		expect(capped.terminal.rows).toBe(7);
		expect(capped.terminal.columns).toBe(100);
		capped.requestRender();
		expect(real.requestRender).toHaveBeenCalled();
	});
});

describe("LaneConsole — read-only mode", () => {
	it("renders the transcript + a '←/esc back' footer when no question is queued", () => {
		liveUnit();
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		const out = panel.render(80);
		expect(out.join("\n")).toContain("ctx line"); // transcript band
		expect(out[out.length - 1]).toContain("←/esc back"); // read-only footer advertises BOTH back-out keys
		expect(out.some((l) => l.includes("─"))).toBe(false); // no divider (read-only)
		panel.dispose();
	});

	it("↑ raises scrollOffset (reveal older), ↓ lowers it clamped ≥ 0", () => {
		const tui = makeTui(24);
		liveUnit(() => Array.from({ length: 50 }, (_v, i) => assistantEntry(`line-${i}`)));
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, tui, identityTheme, {} as never, vi.fn());
		const tail = panel.render(80).join("\n");
		panel.handleInput("\x1b[A"); // up
		expect(panel.render(80).join("\n")).not.toBe(tail);
		expect(tui.requestRender).toHaveBeenCalled();
		panel.handleInput("\x1b[B"); // down past zero stays clamped
		panel.handleInput("\x1b[B");
		expect(() => panel.render(80)).not.toThrow();
		panel.dispose();
	});

	it("`t` toggles tool expansion — footer flips and collapsed-only content reveals", () => {
		liveUnit(() => [
			{
				type: "message",
				message: { role: "compactionSummary", summary: "EXPANDED_ONLY_SUMMARY", tokensBefore: 1234 },
			},
		]);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		const collapsed = panel.render(120).join("\n");
		expect(collapsed).toContain("t expand");
		expect(collapsed).not.toContain("EXPANDED_ONLY_SUMMARY");
		panel.handleInput("t");
		const expanded = panel.render(120).join("\n");
		expect(expanded).toContain("t collapse");
		expect(expanded).toContain("EXPANDED_ONLY_SUMMARY");
		panel.handleInput("t");
		expect(panel.render(120).join("\n")).toContain("t expand");
		panel.dispose();
	});

	it("esc backs out (done resolves) with nothing queued", () => {
		liveUnit();
		const done = vi.fn();
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, done);
		panel.handleInput("\x1b"); // esc
		expect(done).toHaveBeenCalledTimes(1);
		panel.dispose();
	});

	it("← backs out in read-only mode (mirrors → opening the console)", () => {
		liveUnit();
		const done = vi.fn();
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, done);
		panel.handleInput("\x1b[D"); // Left arrow
		expect(done).toHaveBeenCalledTimes(1);
		panel.dispose();
	});
});

describe("LaneConsole — header (migrated from the viewer)", () => {
	it("a running lane header reads '▶ name — live'", () => {
		liveUnit(() => [assistantEntry("hi")]);
		const header = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn()).render(
			120,
		)[0];
		expect(header).toContain("▶ ship — live");
	});

	it("a retired lane header reflects the terminal status + glyph", () => {
		liveUnit(() => [assistantEntry("final answer")]);
		retireRun("run-1", "completed");
		const out = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn()).render(120);
		expect(out[0]).toContain("completed");
		expect(out[0]).toContain("✓");
		expect(out.join("\n")).toContain("final answer"); // snapshot transcript still renders read-only
	});

	it("a retired failed lane header shows the failure reason in full", () => {
		liveUnit(() => [assistantEntry("partial work")]);
		retireRun("run-1", "failed", "blueprint produced no plan artifact — stopping workflow");
		const header = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn()).render(
			200,
		)[0];
		expect(header).toContain("failed: blueprint produced no plan artifact — stopping workflow");
		expect(header).toContain("✗");
	});

	it("a fan-out unit header reflects ITS OWN label + live verb, not the run name", () => {
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "phase 1/3");
		setCurrentSession(
			"run-1",
			0,
			makeSession(() => [assistantEntry("unit work")]),
		);
		const header = new LaneConsole("run-1", 0, makeTui(), identityTheme, {} as never, vi.fn()).render(120)[0];
		expect(header).toContain("phase 1/3");
		expect(header).toContain("▶");
		expect(header).toContain("live");
		expect(header).not.toContain("carve");
	});

	it("a finished fan-out unit header shows the unit glyph + status", () => {
		recordRun("run-1", "carve");
		setUnitStarted("run-1", 0, "phase 2/3");
		setCurrentSession(
			"run-1",
			0,
			makeSession(() => [assistantEntry("unit work")]),
		);
		markUnitDone("run-1", 0, "done");
		const header = new LaneConsole("run-1", 0, makeTui(), identityTheme, {} as never, vi.fn()).render(120)[0];
		expect(header).toContain("✓");
		expect(header).toContain("phase 2/3 — done");
	});

	it("a switched-into pending unit header renders '○ <name> — pending' (never undefined)", () => {
		recordRun("run-1", "ship");
		seedPendingUnits("run-1", [{ index: 0, label: "phase 1/3" }]);
		const out = new LaneConsole("run-1", 0, makeTui(), identityTheme, {} as never, vi.fn()).render(120);
		expect(out[0]).toContain("○ phase 1/3 — pending");
		expect(out[0]).not.toContain("undefined");
	});
});

describe("LaneConsole — token detail header (migrated from the viewer)", () => {
	/** Retire a fan-out unit at `idx` to terminal state, then inject `finalUsage` directly. */
	function setupRetiredUnit(runId: string, idx: number, finalUsage: LaneUsage | undefined): LaneConsole {
		recordRun(runId, "carve");
		setUnitStarted(runId, idx, `phase ${idx + 1}/2`);
		setCurrentSession(
			runId,
			idx,
			makeSession(() => [assistantEntry("unit transcript")]),
		);
		markUnitDone(runId, idx, "done");
		const unit = getUnit(runId, idx);
		if (finalUsage !== undefined && unit) unit.finalUsage = finalUsage;
		return new LaneConsole(runId, idx, makeTui(), identityTheme, {} as never, vi.fn());
	}

	it("renders the full ↑in ↓out R W CH% $cost segment set on a terminated unit's finalUsage", () => {
		const header = setupRetiredUnit("run-full", 0, {
			input: 1500,
			output: 800,
			cacheRead: 500,
			cacheWrite: 200,
			cost: 0.05,
			percent: 45.2,
			total: 3000,
		}).render(200)[0];
		expect(header).toContain("↑1.5k");
		expect(header).toContain("↓800");
		expect(header).toContain("R500");
		expect(header).toContain("W200");
		expect(header).toContain("CH45.2%");
		expect(header).toContain("$0.050");
	});

	it("omits each token segment when zero (footer.js omit-when-zero)", () => {
		const hA = setupRetiredUnit("run-omit-a", 0, {
			input: 1500,
			output: 300,
			cacheRead: 200,
			cacheWrite: 0,
			cost: 0.01,
			percent: 7.0,
			total: 2000,
		}).render(200)[0];
		expect(hA).toContain("↑1.5k");
		expect(hA).toContain("↓300");
		expect(hA).toContain("R200");
		expect(hA).not.toMatch(/W\d/); // cacheWrite omitted

		const hZero = setupRetiredUnit("run-omit-zero", 0, {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		}).render(200)[0];
		expect(hZero).toContain("phase 1/2 — done");
		expect(hZero).not.toContain("↑");
		expect(hZero).not.toContain("$");
	});

	it("renders CH% for a numeric percent and omits it for null/undefined", () => {
		expect(
			setupRetiredUnit("run-ch-num", 0, {
				input: 10,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				percent: 7.0,
				total: 10,
			}).render(200)[0],
		).toContain("CH7.0%");
		expect(
			setupRetiredUnit("run-ch-null", 0, {
				input: 10,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				percent: null,
				total: 10,
			}).render(200)[0],
		).not.toContain("CH%");
		expect(
			setupRetiredUnit("run-ch-absent", 0, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, total: 10 }).render(
				200,
			)[0],
		).not.toContain("CH%");
	});

	it("renders $cost at toFixed(3) when nonzero, omits when zero/absent", () => {
		expect(
			setupRetiredUnit("run-cost", 0, {
				input: 10,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.05,
				total: 10,
			}).render(200)[0],
		).toContain("$0.050");
		expect(
			setupRetiredUnit("run-cost-zero", 0, {
				input: 10,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				total: 10,
			}).render(200)[0],
		).not.toContain("$");
	});

	it("appends no detail when finalUsage is absent (retired unit with no capture)", () => {
		const header = setupRetiredUnit("run-no-final", 0, undefined).render(200)[0];
		expect(header).toContain("phase 1/2 — done");
		expect(header).not.toContain("↑");
		expect(header).not.toContain("$");
	});

	it("rightmost-clips the usage suffix under a narrow width (name survives, never throws)", () => {
		const panel = setupRetiredUnit("run-clip", 0, {
			input: 1500,
			output: 800,
			cacheRead: 500,
			cacheWrite: 200,
			cost: 0.05,
			percent: 45.2,
			total: 3000,
		});
		expect(() => panel.render(30)).not.toThrow();
		const header = panel.render(30)[0];
		expect(header).toContain("phase 1/2"); // name survives (left-anchored)
		expect(header).toContain("…"); // truncation kicked in
		expect(header).not.toContain("$0.050"); // rightmost suffix clipped
	});

	it("renders the full detail LIVE off a running unit's getUsage() (no teardown)", () => {
		const session = makeSession(() => [assistantEntry("unit transcript")]);
		session.setUsage({
			tokens: { input: 1500, output: 800, cacheRead: 500, cacheWrite: 200, total: 3000 },
			cost: 0.05,
			contextUsage: { percent: 45.2 },
		});
		recordRun("run-live", "carve");
		setUnitStarted("run-live", 0, "phase 1/2");
		setCurrentSession("run-live", 0, session);
		const header = new LaneConsole("run-live", 0, makeTui(), identityTheme, {} as never, vi.fn()).render(200)[0];
		expect(header).toContain("phase 1/2 — live");
		expect(header).toContain("↑1.5k");
		expect(header).toContain("CH45.2%");
		expect(header).toContain("$0.050");
	});
});

describe("LaneConsole — disk fallback (migrated from the viewer)", () => {
	it("a retired lane with no finalBranch renders from the on-disk jsonl", () => {
		const tmp = mkdtempSync(join(tmpdir(), "rpiv-console-disk-"));
		try {
			const sessionDir = join(tmp, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			const mgr = SessionManager.create(tmp, sessionDir);
			mgr.appendMessage(makeUserMessage("a user turn"));
			mgr.appendMessage(makeAssistantMessage({ text: "ON_DISK_TRANSCRIPT" }));
			const file = mgr.getSessionFile();
			expect(file).toBeDefined();

			recordRun("run-1", "ship");
			retireRun("run-1", "failed", "boom");
			setLaneSessionFile("run-1", SINGLE_UNIT_KEY, file);
			expect(getUnit("run-1", SINGLE_UNIT_KEY)?.finalBranch).toBeUndefined();

			const out = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn()).render(
				120,
			);
			expect(out.join("\n")).toContain("ON_DISK_TRANSCRIPT");
			expect(out.join("\n")).not.toContain("(no transcript");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("LaneConsole — question mode (reactive, self-draining)", () => {
	it("mounts the question band inline when a question is queued at construction", async () => {
		liveUnit();
		enqueueQuestion(makeInner().component);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		await Promise.resolve(); // let the async mount settle
		const out = panel.render(80).join("\n");
		expect(out).toContain("q0"); // question band
		expect(out).toContain("ctx line"); // transcript still shows above it
		expect(out).toContain("esc defer"); // header hint flips to question mode
		expect(panel.render(80).some((l) => l.includes("─"))).toBe(true); // divider
		panel.dispose();
	});

	it("mounts a question that ARRIVES while the console is open (reactive, no swap)", async () => {
		liveUnit();
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		expect(panel.render(80).join("\n")).toContain("esc back"); // read-only initially
		enqueueQuestion(makeInner().component);
		await Promise.resolve();
		const out = panel.render(80).join("\n");
		expect(out).toContain("q0"); // mounted inline
		expect(out).toContain("esc defer");
		panel.dispose();
	});

	it("forwards a printable key to the mounted question", async () => {
		liveUnit();
		const inner = makeInner();
		enqueueQuestion(inner.component);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		panel.handleInput("a");
		expect(inner.handled).toContain("a");
		panel.dispose();
	});

	it("PageUp scrolls the transcript and is NOT forwarded to the question", async () => {
		liveUnit();
		const inner = makeInner();
		const tui = makeTui();
		enqueueQuestion(inner.component);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, tui, identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		panel.handleInput("\x1b[5~"); // PageUp (CSI 5~)
		expect(inner.handled).not.toContain("\x1b[5~");
		expect(tui.requestRender).toHaveBeenCalled();
		panel.dispose();
	});

	it("commits an answer and advances to the next queued question in place (no overlay swap)", async () => {
		liveUnit(() => [assistantEntry("ctx")]);
		const resolveA = vi.fn();
		const resolveB = vi.fn();
		const factoryB = vi.fn(() => makeInner().component); // count B's builds — the commit-ordering guard
		let submitA!: (r: unknown) => void;
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: ((_t: never, _th: never, _k: never, done: (r: unknown) => void) => {
				submitA = done;
				return makeInner().component;
			}) as never,
			options: undefined as never,
			resolve: resolveA,
		});
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: factoryB as never,
			options: undefined as never,
			resolve: resolveB,
		});
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		await Promise.resolve(); // let A's async mount settle
		submitA({ answers: ["a"] }); // questionnaire A submits
		expect(resolveA).toHaveBeenCalledWith({ answers: ["a"] }); // committed exactly once
		expect(peekInput("run-1", SINGLE_UNIT_KEY)?.resolve).toBe(resolveB); // advanced to B in place
		expect(resolveB).not.toHaveBeenCalled();
		// commit()'s dequeue notifies synchronously → sync() re-enters mid-commit. B must mount ONCE,
		// not once via the re-entrant sync() AND again via the trailing sync() (unmount-before-dequeue).
		expect(factoryB).toHaveBeenCalledTimes(1);
		panel.dispose();
	});

	it("commits the LAST queued question and backs out to the lanes view (no follow-up → done resolves)", async () => {
		// A unit's ask_user_question is a blocking tool call, so its agent can't issue a
		// follow-up until it generates again — the per-unit queue drains to empty on answer.
		// Rather than strand the user on the questionless read-only transcript, back out.
		liveUnit(() => [assistantEntry("ctx")]);
		const resolveA = vi.fn();
		const done = vi.fn();
		let submitA!: (r: unknown) => void;
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: ((_t: never, _th: never, _k: never, d: (r: unknown) => void) => {
				submitA = d;
				return makeInner().component;
			}) as never,
			options: undefined as never,
			resolve: resolveA,
		});
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, done);
		await Promise.resolve(); // let A's async mount settle
		submitA({ answers: ["a"] }); // answer the ONLY queued question
		expect(resolveA).toHaveBeenCalledWith({ answers: ["a"] }); // committed
		expect(peekInput("run-1", SINGLE_UNIT_KEY)).toBeUndefined(); // queue drained (no follow-up queued)
		expect(done).toHaveBeenCalledTimes(1); // drained → overlay backs out to the lanes dock exactly once
		panel.dispose();
	});

	it("esc backs out and leaves a mounted question queued (deferred, child not resolved)", async () => {
		liveUnit();
		const inner = makeInner();
		const resolve = vi.fn();
		const done = vi.fn();
		enqueueQuestion(inner.component, resolve);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, done);
		await Promise.resolve();
		panel.handleInput("\x1b"); // esc
		expect(done).toHaveBeenCalledTimes(1);
		expect(resolve).not.toHaveBeenCalled(); // child stays parked
		expect(inner.handled).not.toContain("\x1b"); // esc reserved, not forwarded
		expect(peekInput("run-1", SINGLE_UNIT_KEY)?.resolve).toBe(resolve); // still queued
		panel.dispose();
	});

	it("retiring the lane while a question shows drains the child (undefined) and drops to read-only", async () => {
		liveUnit();
		const resolve = vi.fn();
		enqueueQuestion(makeInner().component, resolve);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		expect(panel.render(80).join("\n")).toContain("q0"); // question mounted
		retireRun("run-1", "completed"); // settles child undefined + clears FIFO → sync drops to read-only
		expect(resolve).toHaveBeenCalledWith(undefined);
		const out = panel.render(80).join("\n");
		expect(out).toContain("esc back"); // back to the read-only footer
		expect(out).not.toContain("q0");
		panel.dispose();
	});

	it("dispose disposes the mounted question", async () => {
		liveUnit();
		const inner = makeInner();
		enqueueQuestion(inner.component);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		panel.dispose();
		expect(inner.dispose).toHaveBeenCalled();
	});
});

describe("LaneConsole — constant height (ghost-block safety)", () => {
	it("renders exactly maxRows in BOTH read-only and question modes", async () => {
		liveUnit();
		const readonly = new LaneConsole(
			"run-1",
			SINGLE_UNIT_KEY,
			makeTui(24),
			identityTheme,
			{} as never,
			vi.fn(),
		).render(80).length;
		expect(readonly).toBe(Math.floor(24 * 0.9)); // 21

		enqueueQuestion(makeInner(15).component); // a TALL question
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(24), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		expect(panel.render(80).length).toBe(readonly); // padded → identical height across the transition
		panel.dispose();
	});
});

describe("LaneConsole — tiny-terminal constant height (TRANSCRIPT_MIN floor)", () => {
	/** Transcript-band floor (mirrors production lane-console.ts TRANSCRIPT_MIN). The question
	 *  band caps at `available − TRANSCRIPT_MIN`, so a tall question can never squeeze the
	 *  context below this floor — the invariant that bites on tiny terminals. */
	const TRANSCRIPT_MIN = 4;
	/** Read-only = header + available + footer, so the constant-height invariant is
	 *  total = available + 2 (i.e. available = readonlyHeight − 2). */
	const available = (readonlyHeight: number) => readonlyHeight - 2;
	/** Index of the divider row; the question band is everything after it, the transcript
	 *  band is everything between header and it. The `─` comes only from lane-console's
	 *  divider() — the transcript view never emits it, so this is unambiguous. */
	const dividerIndex = (out: string[]) => out.findIndex((l) => l.includes("─"));

	it.each([8, 9, 10])("constant height: read-only ≡ question ≡ available+2 at %d rows", async (rows) => {
		liveUnit(() => [assistantEntry("ctx")]);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(rows), identityTheme, {} as never, vi.fn());
		const readonly = panel.render(80).length; // read-only baseline (no mount pending)
		enqueueQuestion(makeInner(15).component); // a TALL question (caps at available − TRANSCRIPT_MIN)
		await Promise.resolve(); // let the async mountInner settle
		const question = panel.render(80).length;
		expect(question).toBe(readonly); // both === available + 2 — holds where it's least-obvious
		panel.dispose();
	});

	it("TRANSCRIPT_MIN floor bites at 8 rows: tall question capped, transcript band floors at TRANSCRIPT_MIN", async () => {
		liveUnit(() => Array.from({ length: 50 }, (_v, i) => assistantEntry(`line-${i}`))); // long transcript body
		enqueueQuestion(makeInner(15).component); // tall question — hits the available − TRANSCRIPT_MIN cap
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(8), identityTheme, {} as never, vi.fn());
		const readonly = panel.render(80).length; // read-only baseline (mount pending)
		await Promise.resolve(); // let the async mountInner settle
		const out = panel.render(80);
		const di = dividerIndex(out);
		expect(di).toBeGreaterThan(0); // divider present in question mode
		const transcriptBand = di - 1; // header(0) … divider → transcript rows between them
		const questionBand = out.length - di - 1; // divider … end → question rows
		expect(transcriptBand).toBe(TRANSCRIPT_MIN); // the floor that bites
		expect(questionBand).toBe(available(readonly) - TRANSCRIPT_MIN); // the cap (=== 2 at 8 rows)
		expect(out.length).toBe(readonly); // padding keeps total height constant
		panel.dispose();
	});

	it("no shape change across mount → commit-advance → drain → read-only at 8 rows", async () => {
		liveUnit(() => [assistantEntry("ctx")]);
		const resolveA = vi.fn();
		const resolveB = vi.fn();
		let submitA!: (r: unknown) => void;
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: ((_t: never, _th: never, _k: never, done: (r: unknown) => void) => {
				submitA = done; // capture A's submit (the factory-with-done-capture pattern)
				return makeInner(15).component;
			}) as never,
			options: undefined as never,
			resolve: resolveA,
		});
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: (() => makeInner(15).component) as never,
			options: undefined as never,
			resolve: resolveB,
		});
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(8), identityTheme, {} as never, vi.fn());
		const readonly = panel.render(80).length; // read-only (A's async mount pending)
		await Promise.resolve(); // let A's async mount settle
		const mount = panel.render(80).length; // question A mounted
		submitA({ answers: ["a"] }); // commit A → dequeue notify re-enters sync() → mount B
		await Promise.resolve(); // let B's async mount settle
		const commitAdvance = panel.render(80).length; // question B mounted (advanced in place)
		retireRun("run-1", "completed"); // drain B (settle undefined + clear FIFO) → sync drops to read-only
		const drain = panel.render(80).length; // read-only again
		expect([mount, commitAdvance, drain]).toEqual([readonly, readonly, readonly]);
		panel.dispose();

		// esc back-out does not corrupt surface shape (fresh 8-row panel, one mounted question).
		recordRun("run-2", "ship");
		setUnitStarted("run-2", SINGLE_UNIT_KEY, "unit");
		setCurrentSession(
			"run-2",
			SINGLE_UNIT_KEY,
			makeSession(() => [assistantEntry("ctx")]),
		);
		const escDone = vi.fn();
		enqueueInput("run-2", SINGLE_UNIT_KEY, {
			factory: (() => makeInner(15).component) as never,
			options: undefined as never,
			resolve: vi.fn(),
		});
		const escPanel = new LaneConsole("run-2", SINGLE_UNIT_KEY, makeTui(8), identityTheme, {} as never, escDone);
		await Promise.resolve(); // let the async mount settle
		const beforeEsc = escPanel.render(80).length;
		escPanel.handleInput("\x1b"); // esc → defer (question stays queued, child not resolved)
		expect(escPanel.render(80).length).toBe(beforeEsc); // shape unchanged on back-out
		expect(escDone).toHaveBeenCalledTimes(1); // overlay resolved exactly once
		escPanel.dispose();
	});
});

describe("LaneConsole — real ask_user_question factory (cappedTui self-windowing)", () => {
	// A single-select question whose natural questionnaire height (17 @ width 80) exceeds the
	// 15-row question budget at 24 terminal rows, so the cap — not questionnaire shortness — is
	// what constrains the band. Author option labels + the "Type something." sentinel are chrome
	// a makeInner() stub cannot produce.
	const REAL_PARAMS: Record<string, unknown> = {
		questions: [
			{
				question: "Which library should we use for date formatting?",
				header: "Library",
				options: [
					{ label: "date-fns", description: "Functional, tree-shakeable." },
					{ label: "Day.js", description: "Lightweight moment.js alternative." },
					{ label: "Temporal (polyfill)", description: "The upcoming TC39 standard." },
				],
			},
		],
	};
	// At 24 rows: maxRows = floor(24 * 0.9) = 21; available = maxRows − 2 = 19;
	// question budget = available − TRANSCRIPT_MIN(4) = 15; surface height = available + 2 = 21.
	const QUESTION_BUDGET_24 = 15;
	const SURFACE_HEIGHT_24 = 21;

	it("renders real questionnaire chrome a makeInner() stub cannot produce", async () => {
		const factory = await captureRealFactory(REAL_PARAMS);
		liveUnit();
		enqueueRealFactory(factory);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(24), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		// The mounted+capped render carries the author option label (real chrome through cappedTui).
		expect(panel.render(80).join("\n")).toContain("date-fns");
		// The full standalone render shows the complete chrome a makeInner() stub cannot produce:
		// every author option label AND the single-select "Type something." sentinel (the 15-row cap
		// scrolls option 4 out of the mounted band, so the sentinel is asserted on the full render).
		const standalone = factory(makeTui(24), identityTheme, {} as never, vi.fn())
			.render(80)
			.join("\n");
		expect(standalone).toContain("date-fns");
		expect(standalone).toContain("Temporal (polyfill)");
		expect(standalone).toContain("Type something.");
		panel.dispose();
	});

	it("cappedTui reports the 15-row budget to the embedded questionnaire, not the full 24", async () => {
		const factory = await captureRealFactory(REAL_PARAMS);
		let receivedTui: TUI | undefined;
		liveUnit();
		enqueueRealFactory((tui: TUI, theme: Theme, kb: unknown, done: (result: unknown) => void) => {
			receivedTui = tui;
			return factory(tui, theme, kb, done);
		});
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(24), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		panel.render(80); // render sets budgetRef.rows = available − TRANSCRIPT_MIN BEFORE inner.render
		// cappedTui is a lazy proxy over budgetRef — after render it reports the allocated band, not 24.
		expect((receivedTui!.terminal as { rows: number }).rows).toBe(QUESTION_BUDGET_24);
		panel.dispose();
	});

	it("the rendered question band is ≤ the 15-row budget", async () => {
		const factory = await captureRealFactory(REAL_PARAMS);
		liveUnit();
		enqueueRealFactory(factory);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(24), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		const out = panel.render(80);
		const dividerIdx = out.findIndex((l) => l.includes("─"));
		expect(dividerIdx).toBeGreaterThan(-1);
		expect(out.length - dividerIdx - 1).toBeLessThanOrEqual(QUESTION_BUDGET_24); // lines after the divider
		panel.dispose();
	});

	it("the same factory rendered standalone at 24 rows yields strictly more lines than the capped band", async () => {
		const factory = await captureRealFactory(REAL_PARAMS);
		liveUnit();
		enqueueRealFactory(factory);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(24), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		const out = panel.render(80);
		const dividerIdx = out.findIndex((l) => l.includes("─"));
		const cappedBand = out.length - dividerIdx - 1;
		// Standalone at the FULL 24 rows the questionnaire is NOT capped — its natural height (17)
		// exceeds the 15-row budget, so the cap (not questionnaire shortness) constrained the band.
		const standalone = factory(makeTui(24), identityTheme, {} as never, vi.fn()).render(80);
		expect(standalone.length).toBeGreaterThan(cappedBand);
		panel.dispose();
	});

	it("surface height is identical across read-only ↔ real-question mode (available + 2 = 21)", async () => {
		liveUnit();
		const readonlyPanel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(24), identityTheme, {} as never, vi.fn());
		const readonly = readonlyPanel.render(80).length;
		expect(readonly).toBe(SURFACE_HEIGHT_24); // available + 2 = 19 + 2
		readonlyPanel.dispose();

		const factory = await captureRealFactory(REAL_PARAMS);
		enqueueRealFactory(factory);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(24), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		expect(panel.render(80).length).toBe(readonly); // padded → identical height across the transition
		panel.dispose();
	});

	it("a real mount/commit cycle forces requestRender(true) and Enter-submits the last question → backs out", async () => {
		const factory = await captureRealFactory(REAL_PARAMS);
		const resolve = vi.fn();
		const done = vi.fn();
		liveUnit();
		enqueueRealFactory(factory, resolve);
		const tui = makeTui(24);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, tui, identityTheme, {} as never, done);
		await Promise.resolve(); // mount transition
		const requestRender = tui.requestRender as ReturnType<typeof vi.fn>;
		const fullRepaints = () => requestRender.mock.calls.filter((c) => c[0] === true).length;
		expect(fullRepaints()).toBeGreaterThanOrEqual(1); // mount forced a full repaint

		expect(() => panel.handleInput("\r")).not.toThrow(); // Enter on the focused single-select option
		expect(fullRepaints()).toBeGreaterThan(1); // commit forced another full repaint
		expect(resolve).toHaveBeenCalledTimes(1); // pendingInput resolved exactly once
		expect(resolve).toHaveBeenCalledWith(
			expect.objectContaining({
				cancelled: false,
				answers: expect.arrayContaining([expect.objectContaining({ kind: "option", answer: "date-fns" })]),
			}),
		);
		expect(peekInput("run-1", SINGLE_UNIT_KEY)).toBeUndefined(); // queue drained — no follow-up possible
		expect(done).toHaveBeenCalledTimes(1); // last question answered → overlay backs out to the lanes view
		panel.dispose();
	});
});

describe("showLaneConsole", () => {
	it("resolves when the user backs out (esc)", async () => {
		liveUnit();
		const ui = {
			custom: async (
				factory: (tui: TUI, theme: Theme, kb: unknown, done: () => void) => Promise<Component> | Component,
			) => {
				let outerDone!: () => void;
				const p = new Promise<void>((r) => {
					outerDone = () => r();
				});
				const comp = await factory(makeTui(), identityTheme, {}, outerDone);
				(comp as Component).handleInput?.("\x1b"); // esc → finish → done
				return p;
			},
		} as unknown as ExtensionUIContext;
		await expect(showLaneConsole(ui, "run-1", SINGLE_UNIT_KEY)).resolves.toBeUndefined();
	});
});
