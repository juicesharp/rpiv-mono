/**
 * workflow-execution-host tests — the root-gated provider registration hook
 * (Phase 7.2). The execution-host provider lives in a process-global,
 * last-writer-wins box; a detached child re-loading rpiv-core must NOT register
 * it (else the next /wf dispatches through the child instance). The hook gates on
 * session_start: ROOT launcher (hasUI + real ui) registers; a foreground child
 * (branded relay ui) and any non-UI session do not.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the rpiv-workflow /startup seam so registration is observable without the
// real provider box — registerWorkflowExecutionHostProvider() imports it lazily.
const registerWorkflowExecutionHost = vi.fn();
vi.mock("@juicesharp/rpiv-workflow/startup", () => ({ registerWorkflowExecutionHost }));

import { createLaneRelayUiContext } from "./lane-relay-ui.js";
import { SINGLE_UNIT_KEY } from "./run-lane-registry.js";
import { registerWorkflowExecutionHostProviderHook } from "./workflow-execution-host.js";

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

beforeEach(() => {
	registerWorkflowExecutionHost.mockClear();
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("registerWorkflowExecutionHostProviderHook (Phase 7.2)", () => {
	it("registers the provider on the ROOT launcher's session_start", async () => {
		const { pi, sessionStart } = makePi();
		registerWorkflowExecutionHostProviderHook(pi);
		await sessionStart()!({}, { hasUI: true, ui: REAL_UI });
		expect(registerWorkflowExecutionHost).toHaveBeenCalledTimes(1);
	});

	it("does NOT register for a detached foreground child (branded relay ui)", async () => {
		const { pi, sessionStart } = makePi();
		registerWorkflowExecutionHostProviderHook(pi);
		const relay = createLaneRelayUiContext(REAL_UI, "child-run", SINGLE_UNIT_KEY);
		await sessionStart()!({}, { hasUI: true, ui: relay });
		expect(registerWorkflowExecutionHost).not.toHaveBeenCalled();
	});

	it("does NOT register for a non-UI session (background fanout child / headless)", async () => {
		const { pi, sessionStart } = makePi();
		registerWorkflowExecutionHostProviderHook(pi);
		await sessionStart()!({}, { hasUI: false, ui: undefined });
		expect(registerWorkflowExecutionHost).not.toHaveBeenCalled();
	});
});
