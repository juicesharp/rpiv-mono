import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createMockPi, createMockUI } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagerResult } from "./lane-manager.js";
import { showLaneManager } from "./lane-manager.js";
import { createLaneRelayUiContext } from "./lane-relay-ui.js";
import { __resetLaneSwitcher, registerLaneSwitcher } from "./lane-switcher.js";
import { showLaneViewer } from "./lane-viewer.js";
import {
	__resetRunLaneRegistry,
	enqueueInput,
	getFocusedRun,
	getLane,
	recordRun,
	setFocusedRun,
	setLaneAbort,
	subscribeLanes,
} from "./run-lane-registry.js";

// Mock the focused overlays so we can assert sequencing (manager → viewer → drain)
// without driving the real ctx.ui.custom overlay machinery.
vi.mock("./lane-manager.js", () => ({ showLaneManager: vi.fn() }));
vi.mock("./lane-viewer.js", () => ({ showLaneViewer: vi.fn() }));
// Keep the registry REAL (lane-overlay + the switcher both depend on its live
// behavior) but wrap subscribeLanes so we can count subscriptions and capture the
// returned unsub. Each subscription still actually delegates to the real registry.
vi.mock("./run-lane-registry.js", async (importActual) => {
	const actual = await importActual<typeof import("./run-lane-registry.js")>();
	return {
		...actual,
		subscribeLanes: vi.fn((listener: () => void) => vi.fn(actual.subscribeLanes(listener))),
	};
});

const mockShowLaneManager = vi.mocked(showLaneManager);
const mockShowLaneViewer = vi.mocked(showLaneViewer);
const mockSubscribeLanes = vi.mocked(subscribeLanes);

type LanesCtx = { hasUI: boolean; ui: ExtensionUIContext };
type LanesHandler = (args: string, ctx: LanesCtx) => Promise<void>;
type SessionStartHandler = (event: unknown, ctx: { hasUI?: boolean; ui?: ExtensionUIContext }) => Promise<void>;
type ShortcutHandler = (ctx: { hasUI: boolean; ui: ExtensionUIContext }) => void | Promise<void>;

function register(): {
	pi: ExtensionAPI;
	lanes: LanesHandler;
	sessionStart: SessionStartHandler;
	shortcut: ShortcutHandler | undefined;
	shortcutKey: string | undefined;
} {
	const { pi, captured } = createMockPi();
	registerLaneSwitcher(pi);
	const lanes = captured.commands.get("lanes")?.handler as unknown as LanesHandler;
	const sessionStart = captured.events.get("session_start")?.[0] as unknown as SessionStartHandler;
	const shortcutKey = [...captured.shortcuts.keys()][0];
	const shortcut = captured.shortcuts.get(shortcutKey ?? "")?.handler as unknown as ShortcutHandler | undefined;
	return { pi, lanes, sessionStart, shortcut, shortcutKey };
}

/** Let queued microtasks settle (manager await, viewer await). */
const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

beforeEach(() => {
	vi.clearAllMocks();
	__resetRunLaneRegistry();
	__resetLaneSwitcher();
});
afterEach(() => {
	__resetLaneSwitcher();
	__resetRunLaneRegistry();
});

describe("lane-switcher — /lanes command", () => {
	it("notifies and does not open the manager when there are no in-flight runs", async () => {
		const { lanes } = register();
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await lanes("", { hasUI: true, ui });
		expect(ui.notify).toHaveBeenCalledWith("No in-flight runs.", "info");
		expect(mockShowLaneManager).not.toHaveBeenCalled();
	});

	it("is a no-op without a UI (headless command invocation)", async () => {
		const { lanes } = register();
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await lanes("", { hasUI: false, ui });
		expect(ui.notify).not.toHaveBeenCalled();
		expect(mockShowLaneManager).not.toHaveBeenCalled();
	});

	it("opens the manager when at least one run is in-flight", async () => {
		const { lanes } = register();
		recordRun("run-1", "ship");
		mockShowLaneManager.mockResolvedValue({ kind: "dismiss" });
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await lanes("", { hasUI: true, ui });
		expect(mockShowLaneManager).toHaveBeenCalledWith(ui);
	});
});

describe("lane-switcher — Ctrl-Q shortcut (Phase 8.4)", () => {
	it("registers a ctrl+q keyboard shortcut", () => {
		const { shortcut, shortcutKey } = register();
		expect(shortcutKey).toBe("ctrl+q");
		expect(typeof shortcut).toBe("function");
	});

	it("opens the switcher at root when a lane is in-flight", async () => {
		recordRun("run-1", "ship");
		mockShowLaneManager.mockResolvedValue({ kind: "dismiss" });
		const ui = createMockUI() as unknown as ExtensionUIContext;
		const { shortcut } = register();
		await shortcut?.({ hasUI: true, ui });
		await flush();
		expect(mockShowLaneManager).toHaveBeenCalledWith(ui);
	});

	it("is a no-op without a UI", async () => {
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		const { shortcut } = register();
		await shortcut?.({ hasUI: false, ui });
		expect(mockShowLaneManager).not.toHaveBeenCalled();
	});

	it("is a no-op when there are no in-flight lanes", async () => {
		const ui = createMockUI() as unknown as ExtensionUIContext;
		const { shortcut } = register();
		await shortcut?.({ hasUI: true, ui });
		expect(mockShowLaneManager).not.toHaveBeenCalled();
	});

	it("is a no-op when switched into a lane (focus set — viewer owns input)", async () => {
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		const { shortcut } = register();
		setFocusedRun("run-1");
		await shortcut?.({ hasUI: true, ui });
		expect(mockShowLaneManager).not.toHaveBeenCalled();
	});

	it("does not stack a second switcher while one is already open", async () => {
		recordRun("run-1", "ship");
		mockShowLaneManager.mockReturnValue(new Promise<ManagerResult>(() => {})); // never resolves
		const ui = createMockUI() as unknown as ExtensionUIContext;
		const { shortcut } = register();
		await shortcut?.({ hasUI: true, ui });
		await flush();
		await shortcut?.({ hasUI: true, ui }); // second press while manager open → guarded
		await flush();
		expect(mockShowLaneManager).toHaveBeenCalledTimes(1);
	});
});

describe("lane-switcher — openLaneSwitcher sequencing", () => {
	it("opens the viewer only AFTER the manager has resolved (overlays never stack)", async () => {
		const { lanes } = register();
		recordRun("run-1", "ship");
		let resolveManager!: (r: ManagerResult) => void;
		mockShowLaneManager.mockReturnValue(new Promise<ManagerResult>((res) => (resolveManager = res)));
		mockShowLaneViewer.mockResolvedValue(undefined);
		const ui = createMockUI() as unknown as ExtensionUIContext;

		const handlerPromise = lanes("", { hasUI: true, ui });
		await flush();
		// Manager still open → viewer must not have been opened yet.
		expect(mockShowLaneViewer).not.toHaveBeenCalled();

		resolveManager({ kind: "switch", runId: "run-1" });
		await handlerPromise;
		expect(mockShowLaneViewer).toHaveBeenCalledTimes(1);
		// Same launcher UI identity is handed to the viewer (read-only; nothing swaps it).
		expect(mockShowLaneViewer).toHaveBeenCalledWith(ui, "run-1");
	});

	it("does NOT open the viewer or drain on dismiss / ambient", async () => {
		const { lanes } = register();
		recordRun("run-1", "ship");
		const ui = createMockUI({ custom: vi.fn() }) as unknown as ExtensionUIContext;

		mockShowLaneManager.mockResolvedValue({ kind: "dismiss" });
		await lanes("", { hasUI: true, ui });
		mockShowLaneManager.mockResolvedValue({ kind: "ambient" });
		await lanes("", { hasUI: true, ui });

		expect(mockShowLaneViewer).not.toHaveBeenCalled();
		expect((ui.custom as ReturnType<typeof vi.fn>) ?? vi.fn()).not.toHaveBeenCalled();
	});
});

describe("lane-switcher — cancel / remove (Phase D)", () => {
	it("cancel selection calls the run's stored abort handle (no switch-in needed)", async () => {
		const { lanes } = register();
		recordRun("run-1", "ship");
		const abort = vi.fn();
		setLaneAbort("run-1", abort);
		mockShowLaneManager.mockResolvedValue({ kind: "cancel", runId: "run-1" });
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await lanes("", { hasUI: true, ui });
		expect(abort).toHaveBeenCalledTimes(1);
		expect(mockShowLaneViewer).not.toHaveBeenCalled(); // never opened the viewer
	});

	it("remove selection evicts the (retained) lane from the registry", async () => {
		const { lanes } = register();
		recordRun("run-1", "ship");
		mockShowLaneManager.mockResolvedValue({ kind: "remove", runId: "run-1" });
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await lanes("", { hasUI: true, ui });
		expect(getLane("run-1")).toBeUndefined();
		expect(mockShowLaneViewer).not.toHaveBeenCalled();
	});
});

describe("lane-switcher — hotkey resolution (Phase E)", () => {
	const ENV = "RPIV_LANES_HOTKEY";
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env[ENV];
	});
	afterEach(() => {
		if (saved === undefined) delete process.env[ENV];
		else process.env[ENV] = saved;
	});

	it("defaults to ctrl+q when the env var is unset", () => {
		delete process.env[ENV];
		const { shortcutKey } = register();
		expect(shortcutKey).toBe("ctrl+q");
	});

	it("registers NO shortcut when disabled (RPIV_LANES_HOTKEY=off) — /lanes still works", () => {
		process.env[ENV] = "off";
		const { shortcutKey, lanes } = register();
		expect(shortcutKey).toBeUndefined();
		expect(typeof lanes).toBe("function"); // command still registered
	});

	it("binds a custom KeyId from the env var", () => {
		process.env[ENV] = "ctrl+l";
		const { shortcutKey } = register();
		expect(shortcutKey).toBe("ctrl+l");
	});

	it("session_start advertises the resolved binding in the overlay footer", async () => {
		process.env[ENV] = "ctrl+l";
		const { sessionStart } = register();
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await sessionStart(undefined, { hasUI: true, ui });
		const setWidget = ui.setWidget as unknown as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0]?.[1] as
			| ((tui: { requestRender: () => void }, theme: unknown) => { render: (w: number) => string[] })
			| undefined;
		const identityTheme = { fg: (_c: string, s: string) => s } as unknown;
		const lines = factory?.({ requestRender: vi.fn() }, identityTheme).render(120) ?? [];
		expect(lines.join("\n")).toContain("^L");
	});
});

describe("lane-switcher — focus lifecycle", () => {
	it("sets focus while switched in and clears it in finally (even if the viewer throws)", async () => {
		const { lanes } = register();
		recordRun("run-1", "ship");
		let focusDuringViewer: string | undefined;
		mockShowLaneManager.mockResolvedValue({ kind: "switch", runId: "run-1" });
		mockShowLaneViewer.mockImplementation(async () => {
			focusDuringViewer = getFocusedRun();
			throw new Error("viewer boom");
		});
		const ui = createMockUI() as unknown as ExtensionUIContext;

		await expect(lanes("", { hasUI: true, ui })).rejects.toThrow("viewer boom");
		expect(focusDuringViewer).toBe("run-1"); // focused while the viewer was open
		expect(getFocusedRun()).toBeUndefined(); // cleared in finally despite the throw
	});

	it("clears focus after a normal switch completes", async () => {
		const { lanes } = register();
		recordRun("run-1", "ship");
		mockShowLaneManager.mockResolvedValue({ kind: "switch", runId: "run-1" });
		mockShowLaneViewer.mockResolvedValue(undefined);
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await lanes("", { hasUI: true, ui });
		expect(getFocusedRun()).toBeUndefined();
	});
});

describe("lane-switcher — drainPendingInput (FR5)", () => {
	it("replays each queued questionnaire on the real UI in FIFO order and resolves each child", async () => {
		const { lanes } = register();
		recordRun("run-1", "ship");
		const factoryA = (() => ({})) as never;
		const factoryB = (() => ({})) as never;
		const resolveA = vi.fn();
		const resolveB = vi.fn();
		enqueueInput("run-1", { factory: factoryA, options: "optsA" as never, resolve: resolveA });
		enqueueInput("run-1", { factory: factoryB, options: "optsB" as never, resolve: resolveB });

		const custom = vi.fn().mockResolvedValueOnce("ans-A").mockResolvedValueOnce("ans-B");
		const ui = createMockUI({ custom }) as unknown as ExtensionUIContext;
		mockShowLaneManager.mockResolvedValue({ kind: "switch", runId: "run-1" });
		mockShowLaneViewer.mockResolvedValue(undefined);

		await lanes("", { hasUI: true, ui });

		expect(custom).toHaveBeenNthCalledWith(1, factoryA, "optsA");
		expect(custom).toHaveBeenNthCalledWith(2, factoryB, "optsB");
		expect(resolveA).toHaveBeenCalledWith("ans-A");
		expect(resolveB).toHaveBeenCalledWith("ans-B");
	});

	it("settles the child with undefined when the replayed questionnaire throws / is dismissed", async () => {
		const { lanes } = register();
		recordRun("run-1", "ship");
		const resolve = vi.fn();
		enqueueInput("run-1", { factory: (() => ({})) as never, options: undefined as never, resolve });

		const custom = vi.fn().mockRejectedValue(new Error("dismissed"));
		const ui = createMockUI({ custom }) as unknown as ExtensionUIContext;
		mockShowLaneManager.mockResolvedValue({ kind: "switch", runId: "run-1" });
		mockShowLaneViewer.mockResolvedValue(undefined);

		await lanes("", { hasUI: true, ui });
		expect(resolve).toHaveBeenCalledWith(undefined); // never strands the child
	});
});

describe("lane-switcher — registration / lifecycle", () => {
	it("session_start mounts the overlay and subscribes the registry exactly once", async () => {
		const { sessionStart } = register();
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;

		await sessionStart(undefined, { hasUI: true, ui });
		await sessionStart(undefined, { hasUI: true, ui }); // a second start must not double-subscribe

		expect(ui.setWidget).toHaveBeenCalled(); // overlay mounted (lane present)
		expect(mockSubscribeLanes).toHaveBeenCalledTimes(1);
	});

	it("session_start is a no-op without a UI", async () => {
		const { sessionStart } = register();
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await sessionStart(undefined, { hasUI: false, ui });
		expect(ui.setWidget).not.toHaveBeenCalled();
		expect(mockSubscribeLanes).not.toHaveBeenCalled();
	});

	it("session_start is a no-op for a detached child (branded relay ui) — Phase 7.2", async () => {
		const { sessionStart } = register();
		recordRun("run-1", "ship");
		const realUi = createMockUI() as unknown as ExtensionUIContext;
		// A foreground child re-fires session_start with its branded relay ui — the
		// launcher's overlay must NOT mount on it (no widget, no extra subscription).
		const relay = createLaneRelayUiContext(realUi, "run-1");
		await sessionStart(undefined, { hasUI: true, ui: relay });
		expect(realUi.setWidget).not.toHaveBeenCalled();
		expect(mockSubscribeLanes).not.toHaveBeenCalled();
	});

	it("__resetLaneSwitcher unsubscribes the registry listener and disposes the overlay", async () => {
		const { sessionStart } = register();
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await sessionStart(undefined, { hasUI: true, ui });

		const unsub = mockSubscribeLanes.mock.results[0]?.value as ReturnType<typeof vi.fn>;
		__resetLaneSwitcher();

		expect(unsub).toHaveBeenCalled(); // registry listener removed
		expect(ui.setWidget).toHaveBeenLastCalledWith("rpiv-lanes", undefined); // overlay disposed
	});
});
