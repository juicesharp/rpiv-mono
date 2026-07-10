/**
 * workflow-question-warp-bridge tests — the root-gated lifecycle→Warp badge bridge.
 *
 * Mirrors the lane-progress test shape: registration is gated to the ROOT
 * launcher's session_start (a branded relay ui / a non-UI session skip it) and is
 * idempotent; the lifecycle aggregate transitions drive the transport; it degrades
 * to a silent no-op when the rpiv-warp sibling is absent.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the rpiv-warp seam so the transport is observable without real OSC I/O.
// Preserves the real module surface (via importOriginal) so test/setup.ts's
// `await import("../packages/rpiv-warp/index.js").__resetState()` — which resolves
// to this same root export — still works under the mock.
const transportAsked = vi.fn();
const transportResolved = vi.fn();
const createWorkflowQuestionTransport = vi.fn((_cwd: string) => ({
	asked: transportAsked,
	resolved: transportResolved,
}));
vi.mock("@juicesharp/rpiv-warp", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@juicesharp/rpiv-warp")>();
	return { ...actual, createWorkflowQuestionTransport };
});

import { createLaneRelayUiContext } from "./lane-relay-ui.js";
import {
	__resetQuestionLifecycle,
	emitQuestionAsked,
	emitQuestionResolved,
	subscribeQuestionLifecycle,
} from "./question-lifecycle.js";
import { SINGLE_UNIT_KEY } from "./run-lane-registry.js";
import {
	__resetWorkflowQuestionWarpBridge,
	registerWorkflowQuestionWarpBridge,
	registerWorkflowQuestionWarpBridgeHook,
} from "./workflow-question-warp-bridge.js";

/** Loose projection of the lifecycle event the bridge switches on. */
function asked(runId: string, unitIndex: number): void {
	emitQuestionAsked(runId, unitIndex, "ask_user_question", "ship", undefined);
}
function resolved(runId: string, unitIndex: number, reason: "answered" | "cleared"): void {
	emitQuestionResolved(runId, unitIndex, reason);
}

type SessionStartHandler = (ev: unknown, ctx: unknown) => unknown | Promise<unknown>;

function makePi(): { pi: ExtensionAPI; sessionStart: () => SessionStartHandler | undefined } {
	let handler: SessionStartHandler | undefined;
	const pi = {
		on: vi.fn((event: string, h: SessionStartHandler) => {
			if (event === "session_start") handler = h;
		}),
	} as unknown as ExtensionAPI;
	return { pi, sessionStart: () => handler };
}

const REAL_UI = { notify: vi.fn(), setStatus: vi.fn() } as unknown as ExtensionUIContext;
const CWD = "/tmp/projects/widget";

beforeEach(() => {
	createWorkflowQuestionTransport.mockClear();
	transportAsked.mockClear();
	transportResolved.mockClear();
	__resetQuestionLifecycle();
	__resetWorkflowQuestionWarpBridge();
});
afterEach(() => {
	__resetWorkflowQuestionWarpBridge();
	vi.restoreAllMocks();
});

describe("registerWorkflowQuestionWarpBridgeHook", () => {
	it("registers the bridge on the ROOT launcher's session_start", async () => {
		const { pi, sessionStart } = makePi();
		registerWorkflowQuestionWarpBridgeHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI, cwd: CWD });
		expect(createWorkflowQuestionTransport).toHaveBeenCalledTimes(1);
		expect(createWorkflowQuestionTransport).toHaveBeenCalledWith(CWD);
	});

	it("does NOT register for a detached foreground child (branded relay ui)", async () => {
		const { pi, sessionStart } = makePi();
		registerWorkflowQuestionWarpBridgeHook(pi);
		const relay = createLaneRelayUiContext(REAL_UI, "child-run", SINGLE_UNIT_KEY);
		await sessionStart()!({}, { hasUI: true, ui: relay, cwd: CWD });
		expect(createWorkflowQuestionTransport).not.toHaveBeenCalled();
	});

	it("does NOT register for a non-UI session", async () => {
		const { pi, sessionStart } = makePi();
		registerWorkflowQuestionWarpBridgeHook(pi);
		await sessionStart()!({}, { hasUI: false, ui: undefined, cwd: CWD });
		expect(createWorkflowQuestionTransport).not.toHaveBeenCalled();
	});

	it("does NOT register when cwd is absent", async () => {
		const { pi, sessionStart } = makePi();
		registerWorkflowQuestionWarpBridgeHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI, cwd: undefined });
		expect(createWorkflowQuestionTransport).not.toHaveBeenCalled();
	});

	it("is idempotent — a second session_start does not stack a duplicate listener", async () => {
		const { pi, sessionStart } = makePi();
		registerWorkflowQuestionWarpBridgeHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI, cwd: CWD });
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI, cwd: CWD });
		// registerWorkflowQuestionWarpBridge is called twice (once per handler fire),
		// but the guard short-circuits the second subscription — the transport is
		// built once and subscribeQuestionLifecycle is called once.
		expect(createWorkflowQuestionTransport).toHaveBeenCalledTimes(1);
		// A parked question emits asked exactly once (not doubled).
		asked("run-1", 0);
		expect(transportAsked).toHaveBeenCalledTimes(1);
	});
});

describe("aggregate badge transitions", () => {
	async function register(): Promise<void> {
		await registerWorkflowQuestionWarpBridge(CWD);
	}

	it("0→≥1: first parked unit emits asked (session_start + question_asked)", async () => {
		await register();
		asked("run-1", 0);
		expect(transportAsked).toHaveBeenCalledTimes(1);
		expect(transportAsked).toHaveBeenCalledWith("run-1");
		expect(transportResolved).not.toHaveBeenCalled();
	});

	it("≥1→≥1: a second unit parking while the run is Blocked emits nothing", async () => {
		await register();
		asked("run-1", 0); // → Blocked
		asked("run-1", 1); // stays Blocked
		expect(transportAsked).toHaveBeenCalledTimes(1); // only the first
		expect(transportResolved).not.toHaveBeenCalled();
	});

	it("≥1→≥0 via answered: resolving one of several units emits nothing; resolving the LAST emits resolved", async () => {
		await register();
		asked("run-1", 0);
		asked("run-1", 1);
		resolved("run-1", 0, "answered"); // still 1 outstanding → no-op
		expect(transportResolved).not.toHaveBeenCalled();
		resolved("run-1", 1, "answered"); // → 0 outstanding → tool_complete
		expect(transportResolved).toHaveBeenCalledTimes(1);
		expect(transportResolved).toHaveBeenCalledWith("run-1");
	});

	it("reason is irrelevant: a cleared event on the last unit also emits resolved", async () => {
		await register();
		asked("run-1", 0);
		resolved("run-1", 0, "cleared"); // teardown path → ≥1→0
		expect(transportResolved).toHaveBeenCalledTimes(1);
		expect(transportResolved).toHaveBeenCalledWith("run-1");
	});

	it("cleared for a run with several parked units clears the badge only on the last", async () => {
		await register();
		asked("run-1", 0);
		asked("run-1", 2);
		asked("run-1", 5);
		resolved("run-1", 0, "cleared");
		resolved("run-1", 2, "cleared");
		expect(transportResolved).not.toHaveBeenCalled();
		resolved("run-1", 5, "cleared"); // last → tool_complete
		expect(transportResolved).toHaveBeenCalledTimes(1);
	});

	it("a resolved for a unit that was never parked (stale/late) is a harmless no-op", async () => {
		await register();
		resolved("run-1", 9, "cleared"); // no outstanding set for the run
		expect(transportResolved).not.toHaveBeenCalled();
	});

	it("after a run returns to 0, a new parked unit re-emits asked (state re-arms)", async () => {
		await register();
		asked("run-1", 0);
		resolved("run-1", 0, "answered");
		asked("run-1", 0); // a fresh question parks again
		expect(transportAsked).toHaveBeenCalledTimes(2);
	});
});

describe("cross-run independence", () => {
	async function register(): Promise<void> {
		await registerWorkflowQuestionWarpBridge(CWD);
	}

	it("two runs each get their own asked/resolved keyed by their own runId", async () => {
		await register();
		asked("run-A", 0);
		asked("run-B", 0);
		expect(transportAsked).toHaveBeenCalledTimes(2);
		expect(transportAsked).toHaveBeenNthCalledWith(1, "run-A");
		expect(transportAsked).toHaveBeenNthCalledWith(2, "run-B");

		// Answering run-A does NOT clear run-B's badge.
		resolved("run-A", 0, "answered");
		expect(transportResolved).toHaveBeenCalledTimes(1);
		expect(transportResolved).toHaveBeenCalledWith("run-A");

		// run-B still outstanding → resolving nothing yet; then it clears on its own.
		resolved("run-B", 0, "answered");
		expect(transportResolved).toHaveBeenCalledTimes(2);
		expect(transportResolved).toHaveBeenNthCalledWith(2, "run-B");
	});

	it("answering run-A never clears run-B even when both are multi-unit", async () => {
		await register();
		asked("run-A", 0);
		asked("run-A", 1);
		asked("run-B", 0);
		resolved("run-A", 0, "answered");
		resolved("run-A", 1, "answered"); // run-A → 0
		expect(transportResolved).toHaveBeenCalledTimes(1); // only run-A
		// run-B still Blocked: asked still 2 (run-A + run-B first units), resolved still 1
		asked("run-B", 1); // ≥1→≥1 — no asked re-emit
		expect(transportAsked).toHaveBeenCalledTimes(2);
		resolved("run-B", 1, "answered"); // still 1 outstanding
		expect(transportResolved).toHaveBeenCalledTimes(1);
		resolved("run-B", 0, "answered"); // run-B → 0
		expect(transportResolved).toHaveBeenCalledTimes(2);
	});
});

describe("__resetWorkflowQuestionWarpBridge", () => {
	it("disposes the listener — a lifecycle event after reset drives no transport call", async () => {
		await registerWorkflowQuestionWarpBridge(CWD);
		asked("run-1", 0);
		expect(transportAsked).toHaveBeenCalledTimes(1);
		__resetWorkflowQuestionWarpBridge();
		asked("run-1", 1); // listener disposed → no asked
		expect(transportAsked).toHaveBeenCalledTimes(1); // unchanged
	});

	it("re-arms registration — after reset a fresh registration subscribes again", async () => {
		await registerWorkflowQuestionWarpBridge(CWD);
		__resetWorkflowQuestionWarpBridge();
		await registerWorkflowQuestionWarpBridge(CWD); // re-register
		asked("run-1", 0);
		expect(transportAsked).toHaveBeenCalledTimes(1);
	});
});

describe("clean-install no-op (rpiv-warp absent)", () => {
	afterEach(() => {
		vi.doUnmock("@juicesharp/rpiv-warp");
		vi.resetModules();
	});

	it("registers, subscribes, and is a silent no-op when the module is unresolvable", async () => {
		// Isolate the dynamic-import resolution the bridge performs: reset the module
		// cache so the throwing doMock is honored, then re-import the bridge so its
		// internal `import("@juicesharp/rpiv-warp")` resolves against it. This is the
		// LAST describe so the module-cache disruption it introduces never leaks into
		// a later test (the afterEach restores it regardless).
		vi.resetModules();
		vi.doMock("@juicesharp/rpiv-warp", () => {
			const err = Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" });
			throw err;
		});
		const fresh = await import("./workflow-question-warp-bridge.js");
		fresh.__resetWorkflowQuestionWarpBridge(); // ensure the process-global guard is clear
		// A lifecycle listener registered BEFORE the import resolves still works:
		// subscribe via the public API and assert no throw from the bridge.
		await expect(fresh.registerWorkflowQuestionWarpBridge(CWD)).resolves.toBeUndefined();
		// The lifecycle stream itself is unaffected — a direct subscriber fires.
		let fired = 0;
		const unsub = subscribeQuestionLifecycle(() => {
			fired++;
		});
		emitQuestionAsked("run-1", 0, "ask_user_question", "ship", undefined);
		expect(fired).toBe(1);
		unsub();
	});
});
