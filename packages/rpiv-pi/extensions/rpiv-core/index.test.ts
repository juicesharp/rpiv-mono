/**
 * index.test.ts — launcher-decouple + relay wiring.
 *
 * Covers the SDK execution-host provider rpiv-core registers at startup
 * (`workflow-execution-host.ts`): the ESC/Ctrl-C abort tap, the headless
 * degrade (no UI ⇒ no signal/dispose), the config→domain model mapping, the
 * `/startup`-seam registration, and the retirement of the workflow-path
 * model lifecycle latch (the per-child model now lives in
 * SdkWorkflowHost).
 *
 * The abort tap is the load-bearing logic: `ctx.signal` is dead during
 * orchestration, so the ONLY working interrupt is `ctx.ui.onTerminalInput`
 * (tapped ahead of the editor). Keystroke DELIVERY can't be exercised headless —
 * that is the one remaining manual check — but the listener registration, the
 * abort firing, and the `{ consume: true }` return are all deterministic here.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createMockCommandCtx, createMockModelRegistry } from "@juicesharp/rpiv-test-utils";
import { registerWorkflowExecutionHost } from "@juicesharp/rpiv-workflow/startup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRunLaneRegistry, getLane, recordRun, setFocusedRun } from "./run-lane-registry.js";
import { __resetSessionCaptureState, registerSessionCapture } from "./session-capture.js";
import {
	createWorkflowExecution,
	DEFAULT_MAX_CONCURRENCY,
	registerWorkflowExecutionHostProvider,
	toModelSelection,
} from "./workflow-execution-host.js";

// Capture the provider rpiv-core registers with the /startup seam without
// pulling in the whole runner graph — the only symbol the registrar reaches for.
vi.mock("@juicesharp/rpiv-workflow/startup", () => ({
	registerWorkflowExecutionHost: vi.fn(),
}));

const ESC = "\x1b";
const CTRL_C = "\x03";

type SessionStartHandler = (ev: unknown, ctx: unknown) => unknown | Promise<unknown>;
type TapHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/** A spy `onTerminalInput` that records the handler it was bound and the
 *  unsubscribe it hands back — the two things the abort tap wires up. */
function makeSpyUi() {
	const unsub = vi.fn();
	const onTerminalInput = vi.fn((_handler: TapHandler) => unsub);
	const ui = { onTerminalInput, notify: vi.fn(), setStatus: vi.fn() } as unknown as ExtensionUIContext;
	return { ui, onTerminalInput, unsub };
}

/** Populate the session_start capture (modelRegistry + foreground uiContext) the
 *  executor factory borrows — mirrors the real session_start path. */
function captureSession(ui: ExtensionUIContext): void {
	let handler: SessionStartHandler | undefined;
	const pi = {
		on: vi.fn((event: string, h: SessionStartHandler) => {
			if (event === "session_start") handler = h;
		}),
	} as unknown as ExtensionAPI;
	registerSessionCapture(pi);
	// ctx is `unknown` at the hook boundary — fire the capture directly.
	void handler?.({}, { modelRegistry: createMockModelRegistry(), ui });
}

function writeModels(config: unknown): void {
	const dir = join(process.env.HOME!, ".config", "rpiv-pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "models.json"), JSON.stringify(config), "utf-8");
}

beforeEach(() => {
	__resetSessionCaptureState();
	__resetRunLaneRegistry();
	vi.clearAllMocks();
});

describe("createWorkflowExecution — focus-gated abort tap + lane lifecycle", () => {
	it("registers an onTerminalInput listener and returns { host, signal, dispose } when the observer has UI", () => {
		const { ui, onTerminalInput } = makeSpyUi();
		captureSession(ui);
		const observer = createMockCommandCtx({ hasUI: true });

		const exec = createWorkflowExecution(observer, { runId: "run-1", childSessionsDir: "/tmp/run-1/sessions" });

		expect(onTerminalInput).toHaveBeenCalledTimes(1);
		expect(exec.host).toBeDefined();
		expect(exec.host.hasUI).toBe(true);
		expect(exec.signal).toBeInstanceOf(AbortSignal);
		expect(exec.signal?.aborted).toBe(false);
		// dispose is now a wrapper (unsub + evictRun), not identity-equal to unsub.
		expect(typeof exec.dispose).toBe("function");
	});

	it("records the lane at build under its name; dispose unsubscribes the tap and retires a still-running lane (Phase A retention)", () => {
		const { ui, unsub } = makeSpyUi();
		captureSession(ui);
		const observer = createMockCommandCtx({ hasUI: true });

		const exec = createWorkflowExecution(observer, {
			runId: "run-1",
			childSessionsDir: "/tmp/run-1/sessions",
			name: "ship",
		});

		expect(getLane("run-1")?.name).toBe("ship");

		// Phase A: terminal runs are RETAINED, not deleted. The normal retirement path is
		// onWorkflowEnd; dispose is the fallback for a throw/crash that left the lane
		// "running" — it retires to "aborted" so a lane is never stranded "running".
		exec.dispose?.();
		expect(unsub).toHaveBeenCalledTimes(1);
		expect(getLane("run-1")?.status).toBe("aborted");
	});

	it("falls back to the runId as the lane name when no name is given", () => {
		const { ui } = makeSpyUi();
		captureSession(ui);
		const observer = createMockCommandCtx({ hasUI: true });

		createWorkflowExecution(observer, { runId: "run-1", childSessionsDir: "/tmp/run-1/sessions" });

		expect(getLane("run-1")?.name).toBe("run-1");
	});

	it("passes ESC through (never consumed) regardless of focus", () => {
		const { ui, onTerminalInput } = makeSpyUi();
		captureSession(ui);
		const observer = createMockCommandCtx({ hasUI: true });

		const exec = createWorkflowExecution(observer, { runId: "run-1", childSessionsDir: "/tmp/run-1/sessions" });
		const tap = onTerminalInput.mock.calls[0][0];

		// Even when switched into this lane, ESC belongs to the viewer (esc = back to root).
		recordRun("run-1", "ship");
		setFocusedRun("run-1");
		expect(tap(ESC)).toBeUndefined();
		expect(exec.signal?.aborted).toBe(false);
	});

	it("fires the AbortController on Ctrl-C ONLY when this run is focused", () => {
		const { ui, onTerminalInput } = makeSpyUi();
		captureSession(ui);
		const observer = createMockCommandCtx({ hasUI: true });

		const exec = createWorkflowExecution(observer, { runId: "run-1", childSessionsDir: "/tmp/run-1/sessions" });
		const tap = onTerminalInput.mock.calls[0][0];

		recordRun("run-1", "ship");
		setFocusedRun("run-1");
		const result = tap(CTRL_C);

		expect(result).toEqual({ consume: true });
		expect(exec.signal?.aborted).toBe(true);
	});

	it("passes Ctrl-C through when this run is NOT focused (root or a sibling is focused)", () => {
		const { ui, onTerminalInput } = makeSpyUi();
		captureSession(ui);
		const observer = createMockCommandCtx({ hasUI: true });

		const exec = createWorkflowExecution(observer, { runId: "run-1", childSessionsDir: "/tmp/run-1/sessions" });
		const tap = onTerminalInput.mock.calls[0][0];

		// At root (focus undefined): pass through.
		expect(tap(CTRL_C)).toBeUndefined();
		expect(exec.signal?.aborted).toBe(false);

		// A sibling focused: still pass through (never abort an arbitrary run).
		setFocusedRun("other-run");
		expect(tap(CTRL_C)).toBeUndefined();
		expect(exec.signal?.aborted).toBe(false);
	});

	it("passes non-interrupt keystrokes through without aborting", () => {
		const { ui, onTerminalInput } = makeSpyUi();
		captureSession(ui);
		const observer = createMockCommandCtx({ hasUI: true });

		const exec = createWorkflowExecution(observer, { runId: "run-1", childSessionsDir: "/tmp/run-1/sessions" });
		const tap = onTerminalInput.mock.calls[0][0];

		recordRun("run-1", "ship");
		setFocusedRun("run-1");
		expect(tap("a")).toBeUndefined();
		expect(exec.signal?.aborted).toBe(false);
	});

	it("headless (no UI) registers no listener and yields signal undefined — but still records + dispose retires", () => {
		const { ui, onTerminalInput } = makeSpyUi();
		captureSession(ui);
		const observer = createMockCommandCtx({ hasUI: false });

		const exec = createWorkflowExecution(observer, {
			runId: "run-1",
			childSessionsDir: "/tmp/run-1/sessions",
			name: "ship",
		});

		expect(onTerminalInput).not.toHaveBeenCalled();
		expect(exec.signal).toBeUndefined();
		expect(exec.host).toBeDefined(); // the host is still built — only the abort handle degrades
		// Retirement is symmetric even with signal/tap undefined.
		expect(getLane("run-1")?.name).toBe("ship");
		expect(typeof exec.dispose).toBe("function");
		exec.dispose?.();
		expect(getLane("run-1")?.status).toBe("aborted");
	});
});

describe("toModelSelection", () => {
	it("maps a config with model + thinking to a ModelSelection", () => {
		expect(toModelSelection({ model: "anthropic/opus", thinking: "high" })).toEqual({
			model: "anthropic/opus",
			thinking: "high",
		});
	});

	it("returns undefined for an absent or empty config", () => {
		expect(toModelSelection(undefined)).toBeUndefined();
		expect(toModelSelection({})).toBeUndefined();
	});
});

describe("registerWorkflowExecutionHostProvider", () => {
	it("registers a provider whose createHost is the executor factory and whose resolveModel reads models.json", async () => {
		writeModels({ stages: { plan: { model: "anthropic/opus", thinking: "high" } } });

		await registerWorkflowExecutionHostProvider();

		expect(registerWorkflowExecutionHost).toHaveBeenCalledTimes(1);
		const provider = vi.mocked(registerWorkflowExecutionHost).mock.calls[0][0];
		expect(provider.createHost).toBe(createWorkflowExecution);
		// resolveModel threads the stage/skill cascade through to a ModelSelection.
		expect(provider.resolveModel?.({ stage: "plan", skill: "build" })).toEqual({
			model: "anthropic/opus",
			thinking: "high",
		});
		// An unconfigured stage with no defaults resolves to no override.
		expect(provider.resolveModel?.({ stage: "unknown", skill: "build" })).toBeUndefined();
	});
});

describe("default-concurrency cap", () => {
	it("defaults the background-lane cap to 4", () => {
		expect(DEFAULT_MAX_CONCURRENCY).toBe(4);
	});
});

describe("model-override lifecycle latch is retired", () => {
	it("index.ts no longer registers registerModelOverrideLifecycle", () => {
		const indexPath = fileURLToPath(new URL("./index.ts", import.meta.url));
		const src = readFileSync(indexPath, "utf-8");
		expect(src).not.toContain("registerModelOverrideLifecycle");
	});
});
