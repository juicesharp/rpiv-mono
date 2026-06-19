import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLaneRelayUiContext } from "./lane-relay-ui.js";
import { __resetRunLaneRegistry, recordRun } from "./run-lane-registry.js";
import {
	__resetSessionCaptureState,
	getCapturedModel,
	getCapturedModelRegistry,
	getCapturedUiContext,
	registerSessionCapture,
	resolveModel,
} from "./session-capture.js";

// The workflow-path lifecycle latch is retired (the SDK executor resolves
// per-child models at createAgentSession). What survives here is the live
// session_start capture + the shared resolveModel helper; the shared
// apply/restore helpers (applyEffectiveModel/restoreBaseline/applyOrSkipIfStale)
// are exercised through skill-bracket.test.ts.

type SessionStartHandler = (ev: unknown, ctx: unknown) => unknown | Promise<unknown>;

/** Minimal ExtensionAPI stub exposing only the `on("session_start")` surface. */
function makePi(): { pi: ExtensionAPI; sessionStart: () => SessionStartHandler | undefined } {
	let handler: SessionStartHandler | undefined;
	const pi = {
		on: vi.fn((event: string, h: SessionStartHandler) => {
			if (event === "session_start") handler = h;
		}),
	} as unknown as ExtensionAPI;
	return { pi, sessionStart: () => handler };
}

const BASELINE_MODEL = { provider: "anthropic", id: "baseline" };
const FAKE_UI = { notify: vi.fn(), setStatus: vi.fn() } as unknown as ExtensionUIContext;
const makeRegistry = () => ({ find: vi.fn((p: string, m: string) => ({ provider: p, id: m })) });

beforeEach(() => {
	__resetSessionCaptureState();
});

describe("session-capture", () => {
	it("__resetSessionCaptureState clears captured state", () => {
		const { pi, sessionStart } = makePi();
		registerSessionCapture(pi);
		void sessionStart()?.({}, { modelRegistry: makeRegistry(), model: BASELINE_MODEL, ui: FAKE_UI });

		__resetSessionCaptureState();

		expect(getCapturedModelRegistry()).toBeUndefined();
		expect(getCapturedModel()).toBeUndefined();
		expect(getCapturedUiContext()).toBeUndefined();
	});

	describe("session_start capture", () => {
		it("captures modelRegistry, the current model, and the foreground UI context", async () => {
			const { pi, sessionStart } = makePi();
			registerSessionCapture(pi);
			const handler = sessionStart();
			expect(handler).toBeDefined();

			const registry = makeRegistry();
			await handler!({}, { modelRegistry: registry, model: BASELINE_MODEL, ui: FAKE_UI });

			expect(getCapturedModelRegistry()).toBe(registry);
			expect(getCapturedModel()).toBe(BASELINE_MODEL);
			expect(getCapturedUiContext()).toBe(FAKE_UI);
		});

		it("refreshes the captured model on every session_start", async () => {
			const { pi, sessionStart } = makePi();
			registerSessionCapture(pi);
			const handler = sessionStart()!;
			const registry = makeRegistry();

			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL });
			expect(getCapturedModel()).toBe(BASELINE_MODEL);

			const next = { provider: "openai", id: "o3-pro" };
			await handler({}, { modelRegistry: registry, model: next });
			expect(getCapturedModel()).toBe(next);
		});

		it("ignores absent fields (does not clobber a prior capture)", async () => {
			const { pi, sessionStart } = makePi();
			registerSessionCapture(pi);
			const handler = sessionStart()!;
			const registry = makeRegistry();

			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL, ui: FAKE_UI });
			// A later session_start with no model/registry/ui must not wipe the capture.
			await handler({}, {});

			expect(getCapturedModelRegistry()).toBe(registry);
			expect(getCapturedModel()).toBe(BASELINE_MODEL);
			expect(getCapturedUiContext()).toBe(FAKE_UI);
		});

		it("skips a detached child's session_start (relay ui) — never re-points the capture (Phase 7.2)", async () => {
			__resetRunLaneRegistry();
			recordRun("child-run", "ship");
			const { pi, sessionStart } = makePi();
			registerSessionCapture(pi);
			const handler = sessionStart()!;
			const registry = makeRegistry();

			// Root launcher captures the real UI.
			await handler({}, { modelRegistry: registry, model: BASELINE_MODEL, ui: FAKE_UI });

			// A foreground child re-fires session_start with its branded relay ui — gated.
			const relay = createLaneRelayUiContext(FAKE_UI, "child-run");
			const childRegistry = makeRegistry();
			const childModel = { provider: "openai", id: "child-override" };
			await handler({}, { modelRegistry: childRegistry, model: childModel, ui: relay });

			// Capture is unchanged — the relay never became the launcher's foreground UI.
			expect(getCapturedUiContext()).toBe(FAKE_UI);
			expect(getCapturedModelRegistry()).toBe(registry);
			expect(getCapturedModel()).toBe(BASELINE_MODEL);
			__resetRunLaneRegistry();
		});
	});

	describe("resolveModel", () => {
		it("resolves a 'provider/modelId' key through the captured registry", async () => {
			const { pi, sessionStart } = makePi();
			registerSessionCapture(pi);
			const registry = makeRegistry();
			await sessionStart()!({}, { modelRegistry: registry, model: BASELINE_MODEL });

			expect(resolveModel("openai/o3-pro")).toEqual({ provider: "openai", id: "o3-pro" });
			expect(registry.find).toHaveBeenCalledWith("openai", "o3-pro");
		});

		it("returns undefined for an empty key or before any registry is captured", () => {
			expect(resolveModel(undefined)).toBeUndefined();
			expect(resolveModel("openai/o3-pro")).toBeUndefined(); // no registry captured yet
		});
	});
});
