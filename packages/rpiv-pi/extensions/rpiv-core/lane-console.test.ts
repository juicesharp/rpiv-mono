import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionUIContext, initTheme, SessionManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import askUserQuestionExtension from "@juicesharp/rpiv-ask-user-question";
import { createMockPi, makeAssistantMessage, makeUserMessage } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cappedTui, LaneConsole, showLaneConsole } from "./lane-console.js";
import { renderLaneList } from "./lane-list.js";
import type { ViewerMessage } from "./lane-transcript.js";
import {
	__resetRunLaneRegistry,
	enqueueInput,
	getUnit,
	type LaneSession,
	peekInput,
	recordRun,
	retireRun,
	SINGLE_UNIT_KEY,
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

describe("LaneConsole — live output + bottom-pinned lane block", () => {
	it("renders a '── live output ──' top border, the transcript, and the shared lane block", () => {
		liveUnit();
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		const out = panel.render(80);
		expect(out[0]).toContain("live output"); // the labelled top border of the live-output region
		expect(out.join("\n")).toContain("ctx line"); // transcript, unfurling below the border
		expect(out.join("\n")).toContain("ship"); // the SHARED lane row (workflow: tag) at the bottom
		expect(out.some((l) => l.includes("❯"))).toBe(true); // the selection cursor on the lane block
		// The footer is the SECOND-to-last line (the lane block's bottom rule is last, matching the dock).
		expect(out[out.length - 2]).toContain("↑/↓ lanes");
		expect(out[out.length - 2]).toContain("←/esc back");
		panel.dispose();
	});

	it("the bottom lane row is byte-for-byte the ambient dock row plus the ❯ cursor (static lanes)", () => {
		liveUnit(() => [assistantEntry("ctx line")]);
		// The ambient dock row (active=false) and the console's selected row differ ONLY by the gutter.
		const ambientRow = renderLaneList(identityTheme, 80, { active: false, selection: 0, frame: 0, laneCap: 11 }).find(
			(l) => l.includes("ship"),
		);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		const consoleRow = panel.render(80).find((l) => l.includes("ship"));
		expect(ambientRow).toBeDefined();
		expect(consoleRow).toBeDefined();
		// Same content, differing only in the 2-col gutter (`  ` ambient vs `❯ ` selected).
		expect(consoleRow?.replace(/^❯ /, "  ")).toBe(ambientRow);
		panel.dispose();
	});

	it("PageUp freezes on a stable anchor, PageDown walks back and auto-resumes follow (↑/↓ are lane nav)", () => {
		const tui = makeTui(24);
		liveUnit(() => Array.from({ length: 50 }, (_v, i) => assistantEntry(`line-${i}`)));
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, tui, identityTheme, {} as never, vi.fn());
		const tail = panel.render(80).join("\n");
		panel.handleInput("\x1b[5~"); // PageUp → freeze on an older anchor (follow OFF)
		const paused = panel.render(80).join("\n");
		expect(paused).not.toBe(tail);
		expect(paused).toContain("paused"); // footer cue flips off "following"
		expect(tui.requestRender).toHaveBeenCalled();
		panel.handleInput("\x1b[6~"); // PageDown → walk the anchor toward the tail
		panel.handleInput("\x1b[6~"); // …reaching the tail auto-resumes follow; a further press is a no-op
		expect(panel.render(80).join("\n")).toBe(tail); // back at the newest tail, follow ON (window == initial)
		expect(panel.render(80).join("\n")).toContain("following");
		panel.dispose();
	});

	it("follow-mode anchor: following pins the newest tail; PageUp freezes on a stable index (no drift, fail-soft on shrink)", () => {
		const entries = Array.from({ length: 50 }, (_v, i) => assistantEntry(`line-${i}`));
		liveUnit(() => entries); // mutable branch — push/length mutate the live body
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(24), identityTheme, {} as never, vi.fn());

		// c1 — follow=ON: growing the body keeps the newest line pinned at the tail.
		panel.render(80);
		entries.push(assistantEntry("line-50"));
		expect(panel.render(80).join("\n")).toContain("line-50"); // newest visible while following

		// c2 — PageUp freezes on a stable anchor; growing the body does NOT drift the window.
		panel.handleInput("\x1b[5~"); // PageUp → pause on a stable anchor (follow OFF)
		const frozen = panel.render(80);
		entries.push(assistantEntry("line-51")); // grow further while paused
		const after = panel.render(80);
		expect(after).toEqual(frozen); // paused window is byte-identical (start decoupled from body.length)
		expect(after.join("\n")).not.toContain("line-51"); // the newly-added tail line is absent

		// Fail-soft — body shrinks below the anchor: start clamps down to maxStart, no negative start.
		entries.length = 5; // turn-commit-style shrink well below the paused anchorLine
		const shrunk = panel.render(80);
		expect(shrunk.length).toBe(after.length); // constant height — start clamped, band padded (no throw, no collapse)
		panel.dispose();
	});

	it("footer cue distinguishes following vs paused in lane focus", () => {
		liveUnit(() => Array.from({ length: 50 }, (_v, i) => assistantEntry(`line-${i}`)));
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(24), identityTheme, {} as never, vi.fn());
		expect(panel.render(80).join("\n")).toContain("following"); // follow=ON on a fresh console
		panel.handleInput("\x1b[5~"); // PageUp → paused
		const paused = panel.render(80).join("\n");
		expect(paused).toContain("paused");
		expect(paused).not.toContain("following"); // cue flipped (was "following", now "paused")
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

describe("LaneConsole — browser navigation (spine)", () => {
	/** A second live lane with distinct transcript text — recorded AFTER run-1. */
	function secondLane(): void {
		recordRun("run-2", "build");
		setUnitStarted("run-2", SINGLE_UNIT_KEY, "unit");
		setCurrentSession(
			"run-2",
			SINGLE_UNIT_KEY,
			makeSession(() => [assistantEntry("second lane body")]),
		);
	}

	/** The lane row currently carrying the ❯ cursor (the selected one). */
	const selectedRow = (out: string[]): string => out.find((l) => l.includes("❯")) ?? "";

	it("↓ moves the selection and re-targets the transcript to the newly selected lane", () => {
		liveUnit(() => [assistantEntry("first lane body")]);
		secondLane();
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		const before = panel.render(80);
		expect(before.join("\n")).toContain("first lane body"); // starts on run-1's transcript
		expect(selectedRow(before)).toContain("ship"); // cursor on run-1's row
		panel.handleInput("\x1b[B"); // ↓ → select run-2
		const after = panel.render(80);
		expect(after.join("\n")).toContain("second lane body"); // transcript re-targeted in place
		expect(after.join("\n")).not.toContain("first lane body");
		expect(selectedRow(after)).toContain("build"); // cursor moved to run-2's row
		panel.dispose();
	});

	it("↑ at the top backs out (done resolves)", () => {
		liveUnit(() => [assistantEntry("first lane body")]);
		secondLane();
		const done = vi.fn();
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, done);
		panel.handleInput("\x1b[A"); // ↑ at row 0 → back out (restored gesture)
		expect(done).toHaveBeenCalledTimes(1); // finish() resolves the browser exactly once
		panel.dispose();
	});

	it("↓ past the end still clamps", () => {
		liveUnit(() => [assistantEntry("first lane body")]);
		secondLane();
		const done = vi.fn();
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, done);
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B"); // ↓ past the last row clamps at run-2
		expect(selectedRow(panel.render(80))).toContain("build");
		expect(done).not.toHaveBeenCalled(); // clamp, not back-out
		panel.dispose();
	});

	it("x stops the selected running lane (retires it in place)", () => {
		liveUnit();
		secondLane();
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		panel.handleInput("x"); // stop the selected (run-1, running) → cooperative abort + retire
		expect(panel.render(80).join("\n")).toContain("aborted"); // its spine row reflects the terminal status
		panel.dispose();
	});

	it("disposes the previous lane's question when navigating to another lane", async () => {
		liveUnit();
		const innerA = makeInner();
		enqueueQuestion(innerA.component); // run-1 needs input → sorts to the top (row 0)
		secondLane(); // run-2 running, no question (row 1)
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		expect(panel.render(80).join("\n")).toContain("⏎ answer"); // run-1's question mounted (cue, not band)
		panel.handleInput("\x1b[B"); // ↓ → run-2 (no question)
		expect(innerA.dispose).toHaveBeenCalled(); // the previous question component is torn down
		expect(panel.render(80).join("\n")).not.toContain("q0"); // no band on run-2
		panel.dispose();
	});

	it("keeps a same-unit follow-up ARMED after answering (walks the queue without re-arming)", async () => {
		liveUnit(() => [assistantEntry("ctx")]);
		let submitA!: (r: unknown) => void;
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: ((_t: never, _th: never, _k: never, d: (r: unknown) => void) => {
				submitA = d;
				return makeInner().component;
			}) as never,
			options: undefined as never,
			resolve: vi.fn(),
		});
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: (() => makeInner().component) as never,
			options: undefined as never,
			resolve: vi.fn(),
		});
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		await Promise.resolve(); // A mounts
		panel.handleInput("\r"); // arm A → question focus
		expect(panel.render(80).join("\n")).toContain("esc → lanes");
		submitA({ answers: ["a"] }); // answer A → B is queued for the SAME unit
		await Promise.resolve(); // B mounts
		expect(peekInput("run-1", SINGLE_UNIT_KEY)).toBeDefined(); // B still queued
		expect(panel.render(80).join("\n")).toContain("esc → lanes"); // stays armed on B (no re-⏎ needed)
		panel.dispose();
	});

	it("retarget resets scroll to follow=ON — no per-unit scroll memory", () => {
		liveUnit(() => Array.from({ length: 50 }, (_v, i) => assistantEntry(`line-${i}`)));
		secondLane(); // run-2 with its own body
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(24), identityTheme, {} as never, vi.fn());
		panel.render(80); // prime lastMaxStart (cached in render; scroll reads it — see r1)
		panel.handleInput("\x1b[5~"); // PageUp on run-1 → paused (follow OFF, anchor set)
		expect(panel.render(80).join("\n")).toContain("paused");
		panel.handleInput("\x1b[B"); // ↓ → run-2 (retarget resets follow=ON)
		panel.handleInput("\x1b[A"); // ↑ → back to run-1 (retarget resets follow=ON — no scroll memory)
		const out = panel.render(80);
		expect(out.join("\n")).toContain("following"); // follow re-engaged on landing
		expect(out.join("\n")).toContain("line-49"); // run-1's newest tail — not the old paused position
		panel.dispose();
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
	it("hides the queued question on selection (lane focus) and reveals it only on arm (⏎)", async () => {
		liveUnit();
		enqueueQuestion(makeInner().component);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		await Promise.resolve(); // let the async mount settle (eager — ready to arm)
		const hidden = panel.render(80).join("\n");
		expect(hidden).not.toContain("q0"); // band held off in lane focus (arm-gate)…
		expect(hidden).toContain("ctx line"); // …so the transcript is the full, uncapped height
		expect(hidden).toContain("⏎ answer"); // the cue: footer advertises the arm gesture
		panel.handleInput("\r"); // ⏎ arms → question focus, the band paints
		const armed = panel.render(80).join("\n");
		expect(armed).toContain("q0"); // revealed on arm (the canonical arm-reveals assertion)
		expect(armed).toContain("esc → lanes"); // footer flips to the question-focus contract
		panel.dispose();
	});

	it("Enter reveals the question band and esc re-hides it (the arm-then-fire render-gate)", async () => {
		liveUnit();
		enqueueQuestion(makeInner().component);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		await Promise.resolve(); // mount settles eagerly (ready to arm)
		// Lane focus: the band is HIDDEN — full transcript, footer advertises the arm gesture.
		expect(panel.render(80).join("\n")).not.toContain("q0");
		expect(panel.render(80).join("\n")).toContain("⏎ answer");
		// Enter arms → the band paints, footer flips to the question's esc-to-lanes contract.
		panel.handleInput("\r");
		const armed = panel.render(80).join("\n");
		expect(armed).toContain("q0");
		expect(armed).toContain("esc → lanes");
		expect(armed).not.toContain("⏎ answer");
		// esc disarms → the band re-hides, footer returns to lane nav + the arm cue.
		panel.handleInput("\x1b");
		const rehidden = panel.render(80).join("\n");
		expect(rehidden).not.toContain("q0");
		expect(rehidden).toContain("↑/↓ lanes");
		expect(rehidden).toContain("⏎ answer"); // still queued — the cue persists after re-hide
		panel.dispose();
	});

	it("mounts a question that ARRIVES while the console is open (reactive, no swap)", async () => {
		liveUnit();
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		expect(panel.render(80).join("\n")).not.toContain("q0"); // no question mounted yet
		expect(panel.render(80).join("\n")).not.toContain("⏎ answer"); // …so no arm cue
		enqueueQuestion(makeInner().component);
		await Promise.resolve();
		const out = panel.render(80).join("\n");
		expect(out).not.toContain("q0"); // mounted but the band is held off (arm-gate)…
		expect(out).toContain("⏎ answer"); // …arrival surfaces as the footer cue, reactively
		panel.dispose();
	});

	it("forwards a printable key to the question only AFTER it is armed (⏎ → question focus)", async () => {
		liveUnit();
		const inner = makeInner();
		enqueueQuestion(inner.component);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		panel.handleInput("a"); // lane focus: NOT forwarded (arm-then-fire)
		expect(inner.handled).not.toContain("a");
		panel.handleInput("\r"); // ⏎ arms the question → question focus
		expect(panel.render(80).join("\n")).toContain("esc → lanes"); // header flips to question focus
		panel.handleInput("a"); // now forwarded to the questionnaire
		expect(inner.handled).toContain("a");
		panel.handleInput("\x1b"); // esc hands keys back to the spine (question stays deferred)
		expect(inner.handled).not.toContain("\x1b"); // esc reserved, not forwarded
		expect(panel.render(80).join("\n")).toContain("↑/↓ lanes"); // back in lane focus
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

	it("commits an answer and advances to the next queued question in place (no surface swap)", async () => {
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

	it("commits the LAST queued question and STAYS OPEN in lane focus (browser is never stranded)", async () => {
		// Unlike the old single-unit console (which backed out on drain), the browser keeps the
		// spine + transcript as the surface — answering the last question drops the band and
		// returns keys to lane navigation, but the browser stays open (esc/← closes it).
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
		panel.handleInput("\r"); // arm the question (question focus)
		submitA({ answers: ["a"] }); // answer the ONLY queued question
		expect(resolveA).toHaveBeenCalledWith({ answers: ["a"] }); // committed
		expect(peekInput("run-1", SINGLE_UNIT_KEY)).toBeUndefined(); // queue drained (no follow-up queued)
		expect(done).not.toHaveBeenCalled(); // browser stays open — not stranded
		const out = panel.render(80);
		expect(out.join("\n")).not.toContain("q0"); // question band dropped
		expect(out.join("\n")).toContain("↑/↓ lanes"); // returned to lane focus
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
		panel.handleInput("\r"); // arm → the band paints (so "a question shows" is genuinely true)
		expect(panel.render(80).join("\n")).toContain("q0"); // question mounted + armed
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

describe("LaneConsole — parent-row answer jump (fan-out lanes)", () => {
	/** A fan-out run: two real units (keys ≥ 0); the question queues on unit 0's own key,
	 *  so the lane PARENT row's ⚑ is an aggregate — its own queue key (single-unit slot)
	 *  stays empty. */
	function fanOutRunWithQuestion(inner: Component, resolve = vi.fn()): void {
		recordRun("run-1", "ship");
		setUnitStarted("run-1", 0, "unit-a");
		setUnitStarted("run-1", 1, "unit-b");
		setCurrentSession(
			"run-1",
			0,
			makeSession(() => [assistantEntry("ctx")]),
		);
		setCurrentSession(
			"run-1",
			1,
			makeSession(() => [assistantEntry("ctx")]),
		);
		enqueueInput("run-1", 0, { factory: (() => inner) as never, options: undefined as never, resolve });
	}

	it("⏎ on the flagged lane PARENT row jumps to the flagged unit sub-row and arms its question", async () => {
		const inner = makeInner();
		fanOutRunWithQuestion(inner.component);
		// Step-in lands on the top display row = the lane PARENT row (single-unit key).
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		expect(panel.render(80).join("\n")).not.toContain("q0"); // nothing mounted on the parent's own key
		panel.handleInput("\r"); // ⏎ on the aggregated ⚑ → jump + arm (never a dead-end)
		await Promise.resolve(); // the jumped-to unit's mount settles
		const armed = panel.render(80).join("\n");
		expect(armed).toContain("q0"); // the unit's question band paints
		expect(armed).toContain("esc → lanes"); // question focus
		panel.dispose();
	});

	it("the parent row's ⏎-answer footer cue mirrors the aggregate ⚑ (not just its own queue key)", async () => {
		fanOutRunWithQuestion(makeInner().component);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		expect(panel.render(80).join("\n")).toContain("⏎ answer"); // cue on the parent row
		panel.dispose();
	});

	it("committing the jumped-to question resolves the UNIT's child (the right queue drains)", async () => {
		const resolve = vi.fn();
		let submit!: (r: unknown) => void;
		recordRun("run-1", "ship");
		setUnitStarted("run-1", 0, "unit-a");
		setCurrentSession(
			"run-1",
			0,
			makeSession(() => [assistantEntry("ctx")]),
		);
		enqueueInput("run-1", 0, {
			factory: ((_t: never, _th: never, _k: never, done: (r: unknown) => void) => {
				submit = done;
				return makeInner().component;
			}) as never,
			options: undefined as never,
			resolve,
		});
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		panel.handleInput("\r"); // jump to unit 0 + arm
		await Promise.resolve();
		submit({ answers: ["a"] });
		expect(resolve).toHaveBeenCalledWith({ answers: ["a"] });
		expect(peekInput("run-1", 0)).toBeUndefined(); // the unit's FIFO drained
		panel.dispose();
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
		panel.handleInput("\r"); // arm → the band paints so the height check reflects the cap
		expect(panel.render(80).length).toBe(readonly); // padded → identical height across the transition
		panel.dispose();
	});
});

describe("LaneConsole — tiny-terminal constant height", () => {
	it.each([8, 9, 10])("constant height: lane-only ≡ question-mounted at %d rows", async (rows) => {
		liveUnit(() => [assistantEntry("ctx")]);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(rows), identityTheme, {} as never, vi.fn());
		const base = panel.render(80).length; // baseline (no mount pending)
		enqueueQuestion(makeInner(15).component); // a TALL question
		await Promise.resolve(); // let the async mountInner settle
		panel.handleInput("\r"); // arm → the band is painted/capped so the height check is real
		const question = panel.render(80).length;
		expect(question).toBe(base); // padding keeps the surface a constant maxRows across the mount
		panel.dispose();
	});

	it("a squeezed surface paints the ARMED band by yielding the transcript floor (16 rows)", async () => {
		liveUnit(() => [assistantEntry("ctx")]);
		enqueueQuestion(makeInner(3).component);
		// A second lane grows the lane block enough that the unconditional reclaim
		// (budget = maxRows − chrome) is what keeps the armed band from being squeezed out.
		recordRun("run-2", "audit");
		setUnitStarted("run-2", SINGLE_UNIT_KEY, "unit");
		setCurrentSession(
			"run-2",
			SINGLE_UNIT_KEY,
			makeSession(() => [assistantEntry("ctx")]),
		);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(16), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		panel.handleInput("\r"); // arm
		const out = panel.render(80);
		expect(out.join("\n")).toContain("q0"); // the band paints — the transcript floor gave way
		expect(out.length).toBe(Math.floor(16 * 0.9)); // constant height still holds
		panel.dispose();
	});

	it("no shape change across mount → commit-advance → drain → lane focus at 8 rows", async () => {
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
		panel.handleInput("\r"); // arm A → the band paints so the height check reflects the cap
		const mount = panel.render(80).length; // question A mounted + armed
		submitA({ answers: ["a"] }); // commit A → dequeue notify re-enters sync() → mount B (stays armed)
		await Promise.resolve(); // let B's async mount settle
		const commitAdvance = panel.render(80).length; // question B mounted + armed (advanced in place)
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
		expect(escDone).toHaveBeenCalledTimes(1); // browser resolved exactly once
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
	// At 32 rows: maxRows = floor(32 * 0.9) = 28; the bottom lane block for one lane is 7 rows
	// (blank + heading + blank + row + blank + footer + rule); the live-output region above it is
	// the `── live output ──` border + transcript + [question divider + question]. The armed band
	// outranks the transcript floor unconditionally, so the question budget =
	// maxRows − laneBlock(7) − border(1) − questionDivider(1) = 19 ≥ the questionnaire's natural
	// 17 rows — the band is no longer clipped.
	const QUESTION_BUDGET_24 = 19;
	const SURFACE_HEIGHT_24 = 28;
	/** The question band = the lines between the console's question divider (the FIRST bare
	 *  full-width rule, below the `── live output ──` border) and the bottom lane block. The lane
	 *  block for one lane is `["", heading, "", row, "", footer, rule]`, so the row (matched by its
	 *  `ship:` tag) sits 3 lines into it; the band spans from just after the divider to just before
	 *  the block's leading blank. */
	const questionBand = (out: string[]): number => {
		const qDiv = out.findIndex((l, i) => i > 0 && /^─+$/.test(l));
		const laneRowIdx = out.findIndex((l) => l.includes("ship:"));
		return laneRowIdx - qDiv - 4;
	};

	it("renders real questionnaire chrome a makeInner() stub cannot produce", async () => {
		const factory = await captureRealFactory(REAL_PARAMS);
		liveUnit();
		enqueueRealFactory(factory);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(32), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		panel.handleInput("\r"); // arm → the band paints so the real chrome is on the surface
		// The mounted band now carries ALL the chrome a makeInner() stub cannot produce: every
		// author option label AND the single-select "Type something." sentinel. The reclaim
		// (budget 19 ≥ natural 17) ended the old clip, so the standalone-only assertions move here.
		const mounted = panel.render(80).join("\n");
		expect(mounted).toContain("date-fns");
		expect(mounted).toContain("Temporal (polyfill)");
		expect(mounted).toContain("Type something.");
		panel.dispose();
	});

	it("cappedTui reports the armed band's allocated budget to the embedded questionnaire, not the full surface", async () => {
		const factory = await captureRealFactory(REAL_PARAMS);
		let receivedTui: TUI | undefined;
		liveUnit();
		enqueueRealFactory((tui: TUI, theme: Theme, kb: unknown, done: (result: unknown) => void) => {
			receivedTui = tui;
			return factory(tui, theme, kb, done);
		});
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(32), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		panel.handleInput("\r"); // arm → the render gate sets budgetRef.rows and calls inner.render
		panel.render(80); // render sets budgetRef.rows = maxRows − chrome BEFORE inner.render
		// cappedTui is a lazy proxy over budgetRef — after render it reports the allocated band, not 24.
		expect((receivedTui!.terminal as { rows: number }).rows).toBe(QUESTION_BUDGET_24);
		panel.dispose();
	});

	it("the rendered question band is ≤ the armed band's budget", async () => {
		const factory = await captureRealFactory(REAL_PARAMS);
		liveUnit();
		enqueueRealFactory(factory);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(32), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		panel.handleInput("\r"); // arm → the band paints so questionBand can locate its divider
		const band = questionBand(panel.render(80));
		expect(band).toBeGreaterThan(0);
		expect(band).toBeLessThanOrEqual(QUESTION_BUDGET_24); // between the question divider and the spine
		panel.dispose();
	});

	it("the armed band is no longer clipped: budget(19) ≥ the questionnaire's natural height(17)", async () => {
		const factory = await captureRealFactory(REAL_PARAMS);
		liveUnit();
		enqueueRealFactory(factory);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(32), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		panel.handleInput("\r"); // arm → the band paints
		const surface = panel.render(80).join("\n");
		// Regression guard for the root-cause clip. budget(19) ≥ natural(17) ⇒ no overflow in
		// dialog-builder ⇒ nothing clipped. If fixture drift recomputes the natural height to ≥ 20,
		// the cap re-engages and these fail loudly rather than silently re-clipping.
		expect(surface).toContain("Temporal (polyfill)"); // the option the old 15-row cap scrolled out
		expect(surface).toContain("Type something."); // the single-select free-text sentinel
		panel.dispose();
	});

	it("surface height is identical across read-only ↔ real-question mode (available + 2 = 21)", async () => {
		liveUnit();
		const readonlyPanel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(32), identityTheme, {} as never, vi.fn());
		const readonly = readonlyPanel.render(80).length;
		expect(readonly).toBe(SURFACE_HEIGHT_24); // available + 2 = 19 + 2
		readonlyPanel.dispose();

		const factory = await captureRealFactory(REAL_PARAMS);
		enqueueRealFactory(factory);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(32), identityTheme, {} as never, vi.fn());
		await Promise.resolve();
		panel.handleInput("\r"); // arm → the band paints so the height check reflects the real cap
		expect(panel.render(80).length).toBe(readonly); // padded → identical height across the transition
		panel.dispose();
	});

	it("a real arm → Enter-submit cycle forces requestRender(true), resolves once, and STAYS OPEN", async () => {
		const factory = await captureRealFactory(REAL_PARAMS);
		const resolve = vi.fn();
		const done = vi.fn();
		liveUnit();
		enqueueRealFactory(factory, resolve);
		const tui = makeTui(32);
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, tui, identityTheme, {} as never, done);
		await Promise.resolve(); // mount transition
		const requestRender = tui.requestRender as ReturnType<typeof vi.fn>;
		const fullRepaints = () => requestRender.mock.calls.filter((c) => c[0] === true).length;
		expect(fullRepaints()).toBeGreaterThanOrEqual(1); // mount forced a full repaint

		panel.handleInput("\r"); // ⏎ arms the question (lane focus → question focus)
		expect(() => panel.handleInput("\r")).not.toThrow(); // Enter on the focused single-select option submits
		expect(fullRepaints()).toBeGreaterThan(1); // arm + commit each forced a full repaint
		expect(resolve).toHaveBeenCalledTimes(1); // pendingInput resolved exactly once
		expect(resolve).toHaveBeenCalledWith(
			expect.objectContaining({
				cancelled: false,
				answers: expect.arrayContaining([expect.objectContaining({ kind: "option", answer: "date-fns" })]),
			}),
		);
		expect(peekInput("run-1", SINGLE_UNIT_KEY)).toBeUndefined(); // queue drained — no follow-up possible
		expect(done).not.toHaveBeenCalled(); // browser stays open on drain (never stranded)
		expect(panel.render(80).join("\n")).toContain("↑/↓ lanes"); // back in lane focus
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

describe("LaneConsole — dequeue re-entrancy guard (cross-lane re-sort)", () => {
	it("dequeues the captured questionTarget, not the live selection, when the notify re-sorts mid-commit", async () => {
		// Two live single-stage lanes, each with one queued question — the forced setup so the
		// synchronous dequeue notify can re-sort rows[selection] to a DIFFERENT lane mid-commit.
		recordRun("run-1", "ship");
		setUnitStarted("run-1", SINGLE_UNIT_KEY, "unit");
		setCurrentSession(
			"run-1",
			SINGLE_UNIT_KEY,
			makeSession(() => [assistantEntry("ship body")]),
		);
		recordRun("run-2", "build");
		setUnitStarted("run-2", SINGLE_UNIT_KEY, "unit");
		setCurrentSession(
			"run-2",
			SINGLE_UNIT_KEY,
			makeSession(() => [assistantEntry("build body")]),
		);

		// run-1: capture the submit callback (the factory-with-done-capture pattern at lane-console.ts:207-220).
		let submitRun1!: (r: unknown) => void;
		const resolveRun1 = vi.fn();
		enqueueInput("run-1", SINGLE_UNIT_KEY, {
			factory: ((_t: never, _th: never, _k: never, done: (r: unknown) => void) => {
				submitRun1 = done;
				return makeInner().component;
			}) as never,
			options: undefined as never,
			resolve: resolveRun1,
		});
		// run-2: spy its factory build count (the unmount-first ordering guard — mirrors lane-console.ts:250-251).
		const factoryRun2 = vi.fn(() => makeInner().component);
		const resolveRun2 = vi.fn();
		enqueueInput("run-2", SINGLE_UNIT_KEY, {
			factory: factoryRun2 as never,
			options: undefined as never,
			resolve: resolveRun2,
		});

		const done = vi.fn();
		const panel = new LaneConsole("run-1", SINGLE_UNIT_KEY, makeTui(), identityTheme, {} as never, done);
		// Both need input (bucket 0); insertion-stable → run-1 at row 0 (selected), run-2 at row 1.
		await Promise.resolve(); // let run-1's async mount settle (this.inner)
		panel.handleInput("\r"); // ⏎ arm run-1's question (lane focus → question focus)

		// Commit run-1's answer. dequeueInput("run-1") notifies synchronously → sync() re-enters
		// mid-commit; run-1 drains to running (bucket 1) while run-2 stays needs-input (bucket 0)
		// and re-sorts to rows[0]. The selection now points at run-2, but commit() dequeued the
		// CAPTURED run-1.
		submitRun1({ answers: ["a"] });

		// questionTarget guard: run-1 resolved exactly once with the answer; run-2 NEVER resolved.
		expect(resolveRun1).toHaveBeenCalledTimes(1);
		expect(resolveRun1).toHaveBeenCalledWith({ answers: ["a"] });
		expect(resolveRun2).not.toHaveBeenCalled();
		// queue state: run-1 drained, run-2 intact.
		expect(peekInput("run-1", SINGLE_UNIT_KEY)).toBeUndefined();
		expect(peekInput("run-2", SINGLE_UNIT_KEY)).toBeDefined();
		// unmount-first ordering: run-2's factory built EXACTLY ONCE (re-entrant sync() mounted it;
		// the trailing sync() was a no-op — head === mountedFor). The factory is invoked
		// synchronously inside mountInner, so the build count needs no await.
		expect(factoryRun2).toHaveBeenCalledTimes(1);

		await Promise.resolve(); // let run-2's async mount settle (this.inner)
		// selection re-sort + arm-then-fire: cursor lands on run-2, focus returns to the spine
		// (a fresh lane needs a fresh arm — even though run-1's answer was armed).
		const out = panel.render(80);
		expect(out.find((l) => l.includes("❯")) ?? "").toContain("build"); // cursor re-sorted to run-2
		expect(out.join("\n")).toContain("⏎ answer"); // run-2's question INERT (lane focus, not armed)
		expect(out.join("\n")).toContain("↑/↓ lanes"); // back in lane navigation focus
		expect(done).not.toHaveBeenCalled(); // no strand — browser stays open across the commit
		panel.dispose();
	});
});
