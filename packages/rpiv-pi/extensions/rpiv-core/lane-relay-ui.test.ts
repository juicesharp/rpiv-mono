/**
 * lane-relay-ui tests — the deferring, leak-proof ExtensionUIContext bound to a
 * floated run's foreground stage (FR5 + Phase 7.1). Verifies the allow-policy:
 * `custom` defers (enqueue + pending promise + one-shot toast), `notify` is
 * focus-gated, ambient-surface mutators are suppressed at root, `onTerminalInput`
 * is a no-op tap, other members forward with `this` bound, the relay is branded,
 * and the deferred promise settles on drain or evict.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLaneRelayUiContext, isLaneRelayUiContext } from "./lane-relay-ui.js";
import {
	__resetRunLaneRegistry,
	dequeueInput,
	evictRun,
	getLane,
	recordRun,
	setFocusedRun,
} from "./run-lane-registry.js";

/**
 * A hand-built real ctx stub. `marker` + the method bodies reading `this.marker`
 * prove the Proxy binds forwarded methods to the real target (an unbound forward
 * would lose `this`). `confirm` stands in for a FORWARDED method (setWidget is
 * now suppressed, so it can't be the binding probe).
 */
function makeRealCtx() {
	const theme = { fg: (_c: string, t: string) => t };
	const notify = vi.fn();
	const setWidget = vi.fn();
	const setStatus = vi.fn();
	const setWorkingMessage = vi.fn();
	const setHiddenThinkingLabel = vi.fn();
	const pasteToEditor = vi.fn();
	const onTerminalInput = vi.fn(() => () => {});
	const confirmCalls: Array<string | undefined> = [];
	const real = {
		marker: "REAL",
		theme,
		notify,
		setWidget,
		setStatus,
		setWorkingMessage,
		setHiddenThinkingLabel,
		pasteToEditor,
		onTerminalInput,
		confirm(this: { marker: string }, _msg: string) {
			// Records `this.marker` so the test can assert correct binding.
			confirmCalls.push(this.marker);
			return Promise.resolve(true);
		},
	} as unknown as ExtensionUIContext;
	return {
		real,
		theme,
		notify,
		setWidget,
		setStatus,
		setWorkingMessage,
		setHiddenThinkingLabel,
		pasteToEditor,
		onTerminalInput,
		confirmCalls,
	};
}

/** Resolve-state probe: did the promise settle (and to what)? */
function track<T>(p: Promise<T>): { settled: boolean; value: T | undefined } {
	const state: { settled: boolean; value: T | undefined } = { settled: false, value: undefined };
	void p.then((v) => {
		state.settled = true;
		state.value = v;
	});
	return state;
}

const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

beforeEach(() => {
	__resetRunLaneRegistry();
});
afterEach(() => {
	__resetRunLaneRegistry();
});

describe("lane-relay-ui — custom defers", () => {
	it("enqueues the factory/options/resolve into the lane and returns a pending promise", async () => {
		recordRun("run-1", "ship");
		const { real } = makeRealCtx();
		const relay = createLaneRelayUiContext(real, "run-1");

		const factory = (() => ({})) as never;
		const options = { overlay: true } as never;
		const result = track(relay.custom(factory, options));

		const pending = getLane("run-1")?.pendingInput;
		expect(pending).toHaveLength(1);
		expect(pending?.[0].factory).toBe(factory);
		expect(pending?.[0].options).toBe(options);
		expect(typeof pending?.[0].resolve).toBe("function");

		// The promise parks the child's tool turn — it must stay pending until drained.
		await flush();
		expect(result.settled).toBe(false);
	});

	it("toasts once on the real ctx when a questionnaire is deferred (the relay's own signal — always)", () => {
		recordRun("run-1", "ship");
		const { real, notify } = makeRealCtx();
		const relay = createLaneRelayUiContext(real, "run-1");

		void relay.custom((() => ({})) as never, undefined as never);

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("⚑ a background run needs input — /lanes to switch in", "warning");
	});
});

describe("lane-relay-ui — notify is focus-gated (Phase 7.1)", () => {
	it("drops a child notify at root (this lane is NOT focused)", () => {
		recordRun("run-1", "ship");
		const { real, notify } = makeRealCtx();
		const relay = createLaneRelayUiContext(real, "run-1");

		relay.notify("Advisor restored", "info");
		expect(notify).not.toHaveBeenCalled(); // never reaches the launcher
	});

	it("forwards a child notify only while the user is switched into THIS lane", () => {
		recordRun("run-1", "ship");
		const { real, notify } = makeRealCtx();
		const relay = createLaneRelayUiContext(real, "run-1");

		setFocusedRun("run-1");
		relay.notify("hello", "warning");
		expect(notify).toHaveBeenCalledWith("hello", "warning");

		// Focused on a DIFFERENT lane → dropped again.
		notify.mockClear();
		setFocusedRun("run-2");
		relay.notify("nope", "info");
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("lane-relay-ui — ambient surfaces suppressed (Phase 7.1)", () => {
	it("never forwards setWidget/setStatus/setWorkingMessage/setHiddenThinkingLabel/pasteToEditor", () => {
		recordRun("run-1", "ship");
		const ctx = makeRealCtx();
		const relay = createLaneRelayUiContext(ctx.real, "run-1") as unknown as Record<
			string,
			(...a: unknown[]) => unknown
		>;

		// No throw, returns undefined, and the real ctx is never touched.
		expect(relay.setWidget("rpiv-todos", () => ({}))).toBeUndefined();
		expect(relay.setStatus("k", "v")).toBeUndefined();
		expect(relay.setWorkingMessage("working…")).toBeUndefined();
		expect(relay.setHiddenThinkingLabel("…")).toBeUndefined();
		expect(relay.pasteToEditor("text")).toBeUndefined();

		expect(ctx.setWidget).not.toHaveBeenCalled();
		expect(ctx.setStatus).not.toHaveBeenCalled();
		expect(ctx.setWorkingMessage).not.toHaveBeenCalled();
		expect(ctx.setHiddenThinkingLabel).not.toHaveBeenCalled();
		expect(ctx.pasteToEditor).not.toHaveBeenCalled();
	});

	it("onTerminalInput returns a no-op unsubscribe and never taps the launcher", () => {
		recordRun("run-1", "ship");
		const { real, onTerminalInput } = makeRealCtx();
		const relay = createLaneRelayUiContext(real, "run-1");

		const unsub = relay.onTerminalInput(() => undefined);
		expect(typeof unsub).toBe("function");
		expect(() => unsub()).not.toThrow();
		expect(onTerminalInput).not.toHaveBeenCalled(); // child never taps the real terminal
	});
});

describe("lane-relay-ui — forwarding (Proxy get trap)", () => {
	it("forwards a non-suppressed method to the real ctx with `this` bound", async () => {
		recordRun("run-1", "ship");
		const { real, confirmCalls } = makeRealCtx();
		const relay = createLaneRelayUiContext(real, "run-1");

		await (relay as unknown as { confirm(m: string): Promise<boolean> }).confirm("ok?");

		// `this.marker` resolved to the real target → method was bound correctly.
		expect(confirmCalls).toEqual(["REAL"]);
	});

	it("forwards the theme getter to the real ctx", () => {
		recordRun("run-1", "ship");
		const { real, theme } = makeRealCtx();
		const relay = createLaneRelayUiContext(real, "run-1");

		expect((relay as unknown as { theme: unknown }).theme).toBe(theme);
	});
});

describe("lane-relay-ui — brand (Phase 7.2 child detection)", () => {
	it("a relay is detectable via isLaneRelayUiContext; a plain ctx is not", () => {
		const { real } = makeRealCtx();
		const relay = createLaneRelayUiContext(real, "run-1");
		expect(isLaneRelayUiContext(relay)).toBe(true);
		expect(isLaneRelayUiContext(real)).toBe(false);
		expect(isLaneRelayUiContext(undefined)).toBe(false);
		expect(isLaneRelayUiContext({})).toBe(false);
	});
});

describe("lane-relay-ui — settling the deferred promise", () => {
	it("resolves the parked promise with the drained answer", async () => {
		recordRun("run-1", "ship");
		const { real } = makeRealCtx();
		const relay = createLaneRelayUiContext(real, "run-1");

		const result = track(relay.custom((() => ({})) as never, undefined as never));
		await flush();
		expect(result.settled).toBe(false);

		// The switcher drains the queue and resolves the child (drainPendingInput).
		const pending = dequeueInput("run-1");
		pending?.resolve("the-answer");
		await flush();

		expect(result.settled).toBe(true);
		expect(result.value).toBe("the-answer");
	});

	it("resolves the parked promise with undefined when the run is evicted (never strands the child)", async () => {
		recordRun("run-1", "ship");
		const { real } = makeRealCtx();
		const relay = createLaneRelayUiContext(real, "run-1");

		const result = track(relay.custom((() => ({})) as never, undefined as never));
		await flush();
		expect(result.settled).toBe(false);

		// Run finishes with input still queued → evictRun settles every pending with undefined.
		evictRun("run-1");
		await flush();

		expect(result.settled).toBe(true);
		expect(result.value).toBeUndefined();
	});
});
