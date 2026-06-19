import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createMockPi, createMockUI } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLaneRelayUiContext } from "./lane-relay-ui.js";
import { __resetLaneSwitcher, registerLaneSwitcher, switchIntoLane } from "./lane-switcher.js";
import { showLaneViewer } from "./lane-viewer.js";
import {
	__resetRunLaneRegistry,
	enqueueInput,
	getDockState,
	getFocusedRun,
	recordRun,
	setDockActive,
	setFocusedRun,
	subscribeLanes,
} from "./run-lane-registry.js";

// Mock the viewer so we can assert the switch flow without driving the real
// ctx.ui.custom overlay machinery.
vi.mock("./lane-viewer.js", () => ({ showLaneViewer: vi.fn() }));
// Keep the registry REAL (the dock + switcher both depend on its live behavior) but
// wrap subscribeLanes so we can count subscriptions and capture the returned unsub.
vi.mock("./run-lane-registry.js", async (importActual) => {
	const actual = await importActual<typeof import("./run-lane-registry.js")>();
	return {
		...actual,
		subscribeLanes: vi.fn((listener: () => void) => vi.fn(actual.subscribeLanes(listener))),
	};
});

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
	it("notifies and does NOT activate the dock when there are no in-flight runs", async () => {
		const { lanes } = register();
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await lanes("", { hasUI: true, ui });
		expect(ui.notify).toHaveBeenCalledWith("No in-flight runs.", "info");
		expect(getDockState().active).toBe(false);
	});

	it("is a no-op without a UI (headless command invocation)", async () => {
		const { lanes } = register();
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await lanes("", { hasUI: false, ui });
		expect(ui.notify).not.toHaveBeenCalled();
		expect(getDockState().active).toBe(false);
	});

	it("steps into the dock at the top row when at least one run is in-flight", async () => {
		const { lanes } = register();
		recordRun("run-1", "ship");
		recordRun("run-2", "build");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await lanes("", { hasUI: true, ui });
		expect(getDockState()).toEqual({ active: true, selection: 0 });
	});
});

describe("lane-switcher — Ctrl-Q shortcut", () => {
	it("registers a ctrl+q keyboard shortcut", () => {
		const { shortcut, shortcutKey } = register();
		expect(shortcutKey).toBe("ctrl+q");
		expect(typeof shortcut).toBe("function");
	});

	it("steps into the dock at root when a lane is in-flight", () => {
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		const { shortcut } = register();
		shortcut?.({ hasUI: true, ui });
		expect(getDockState().active).toBe(true);
	});

	it("is a no-op without a UI", () => {
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		const { shortcut } = register();
		shortcut?.({ hasUI: false, ui });
		expect(getDockState().active).toBe(false);
	});

	it("is a no-op when there are no in-flight lanes", () => {
		const ui = createMockUI() as unknown as ExtensionUIContext;
		const { shortcut } = register();
		shortcut?.({ hasUI: true, ui });
		expect(getDockState().active).toBe(false);
	});

	it("is a no-op when switched into a lane (focus set — viewer owns input)", () => {
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		const { shortcut } = register();
		setFocusedRun("run-1");
		shortcut?.({ hasUI: true, ui });
		expect(getDockState().active).toBe(false);
	});
});

describe("lane-switcher — switchIntoLane sequencing", () => {
	it("opens the viewer for the run on the launcher UI identity", async () => {
		recordRun("run-1", "ship");
		mockShowLaneViewer.mockResolvedValue(undefined);
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await switchIntoLane(ui, "run-1");
		expect(mockShowLaneViewer).toHaveBeenCalledTimes(1);
		expect(mockShowLaneViewer).toHaveBeenCalledWith(ui, "run-1");
	});

	it("does not stack a second viewer while one is already open", async () => {
		recordRun("run-1", "ship");
		mockShowLaneViewer.mockReturnValue(new Promise<void>(() => {})); // never resolves
		const ui = createMockUI() as unknown as ExtensionUIContext;
		void switchIntoLane(ui, "run-1");
		await Promise.resolve();
		void switchIntoLane(ui, "run-1"); // second call while viewer open → guarded
		await Promise.resolve();
		expect(mockShowLaneViewer).toHaveBeenCalledTimes(1);
	});

	it("deactivates the dock once the user returns to root", async () => {
		recordRun("run-1", "ship");
		mockShowLaneViewer.mockResolvedValue(undefined);
		setDockActive(true);
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await switchIntoLane(ui, "run-1");
		expect(getDockState().active).toBe(false);
	});
});

describe("lane-switcher — focus lifecycle", () => {
	it("sets focus while switched in and clears it in finally (even if the viewer throws)", async () => {
		recordRun("run-1", "ship");
		let focusDuringViewer: string | undefined;
		mockShowLaneViewer.mockImplementation(async () => {
			focusDuringViewer = getFocusedRun();
			throw new Error("viewer boom");
		});
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await expect(switchIntoLane(ui, "run-1")).rejects.toThrow("viewer boom");
		expect(focusDuringViewer).toBe("run-1"); // focused while the viewer was open
		expect(getFocusedRun()).toBeUndefined(); // cleared in finally despite the throw
	});

	it("clears focus after a normal switch completes", async () => {
		recordRun("run-1", "ship");
		mockShowLaneViewer.mockResolvedValue(undefined);
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await switchIntoLane(ui, "run-1");
		expect(getFocusedRun()).toBeUndefined();
	});
});

describe("lane-switcher — drainPendingInput (FR5)", () => {
	it("replays each queued questionnaire on the real UI in FIFO order and resolves each child", async () => {
		recordRun("run-1", "ship");
		const factoryA = (() => ({})) as never;
		const factoryB = (() => ({})) as never;
		const resolveA = vi.fn();
		const resolveB = vi.fn();
		enqueueInput("run-1", { factory: factoryA, options: "optsA" as never, resolve: resolveA });
		enqueueInput("run-1", { factory: factoryB, options: "optsB" as never, resolve: resolveB });

		const custom = vi.fn().mockResolvedValueOnce("ans-A").mockResolvedValueOnce("ans-B");
		const ui = createMockUI({ custom }) as unknown as ExtensionUIContext;
		mockShowLaneViewer.mockResolvedValue(undefined);

		await switchIntoLane(ui, "run-1");

		expect(custom).toHaveBeenNthCalledWith(1, factoryA, "optsA");
		expect(custom).toHaveBeenNthCalledWith(2, factoryB, "optsB");
		expect(resolveA).toHaveBeenCalledWith("ans-A");
		expect(resolveB).toHaveBeenCalledWith("ans-B");
	});

	it("settles the child with undefined when the replayed questionnaire throws / is dismissed", async () => {
		recordRun("run-1", "ship");
		const resolve = vi.fn();
		enqueueInput("run-1", { factory: (() => ({})) as never, options: undefined as never, resolve });

		const custom = vi.fn().mockRejectedValue(new Error("dismissed"));
		const ui = createMockUI({ custom }) as unknown as ExtensionUIContext;
		mockShowLaneViewer.mockResolvedValue(undefined);

		await switchIntoLane(ui, "run-1");
		expect(resolve).toHaveBeenCalledWith(undefined); // never strands the child
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

	it("session_start advertises the resolved binding in the dock footer", async () => {
		process.env[ENV] = "ctrl+l";
		const { sessionStart } = register();
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await sessionStart(undefined, { hasUI: true, ui });
		const setWidget = ui.setWidget as unknown as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0]?.[1] as
			| ((tui: { requestRender: () => void }, theme: unknown) => { render: (w: number) => string[] })
			| undefined;
		const identityTheme = {
			fg: (_c: string, s: string) => s,
			bg: (_c: string, s: string) => s,
			bold: (s: string) => s,
		} as unknown;
		const lines = factory?.({ requestRender: vi.fn() }, identityTheme).render(120) ?? [];
		const out = lines.join("\n");
		expect(out).toContain("^L"); // resolved hotkey glyph
		expect(out).toContain("↓"); // DOWN-from-empty entry gesture
		expect(out).toContain("/lanes"); // always-safe command
	});
});

describe("lane-switcher — registration / lifecycle", () => {
	it("session_start mounts the dock, subscribes once, and installs the dock editor once", async () => {
		const { sessionStart } = register();
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;

		await sessionStart(undefined, { hasUI: true, ui });
		await sessionStart(undefined, { hasUI: true, ui }); // a second start must not double-wire

		expect(ui.setWidget).toHaveBeenCalled(); // dock mounted (lane present)
		expect(mockSubscribeLanes).toHaveBeenCalledTimes(1);
		// Editor installed exactly once for this ctx identity.
		expect(ui.setEditorComponent as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
	});

	it("a new ctx (/reload) re-installs the dock editor", async () => {
		const { sessionStart } = register();
		recordRun("run-1", "ship");
		const ui1 = createMockUI() as unknown as ExtensionUIContext;
		const ui2 = createMockUI() as unknown as ExtensionUIContext;
		await sessionStart(undefined, { hasUI: true, ui: ui1 });
		await sessionStart(undefined, { hasUI: true, ui: ui2 });
		expect(ui1.setEditorComponent as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
		expect(ui2.setEditorComponent as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
	});

	it("session_start is a no-op without a UI", async () => {
		const { sessionStart } = register();
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await sessionStart(undefined, { hasUI: false, ui });
		expect(ui.setWidget).not.toHaveBeenCalled();
		expect(ui.setEditorComponent as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
		expect(mockSubscribeLanes).not.toHaveBeenCalled();
	});

	it("session_start is a no-op for a detached child (branded relay ui) — Phase 7.2", async () => {
		const { sessionStart } = register();
		recordRun("run-1", "ship");
		const realUi = createMockUI() as unknown as ExtensionUIContext;
		const relay = createLaneRelayUiContext(realUi, "run-1");
		await sessionStart(undefined, { hasUI: true, ui: relay });
		expect(realUi.setWidget).not.toHaveBeenCalled();
		expect(realUi.setEditorComponent as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
		expect(mockSubscribeLanes).not.toHaveBeenCalled();
	});

	it("__resetLaneSwitcher unsubscribes, disposes the dock, and restores the default editor", async () => {
		const { sessionStart } = register();
		recordRun("run-1", "ship");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		await sessionStart(undefined, { hasUI: true, ui });

		const unsub = mockSubscribeLanes.mock.results[0]?.value as ReturnType<typeof vi.fn>;
		__resetLaneSwitcher();

		expect(unsub).toHaveBeenCalled(); // registry listener removed
		expect(ui.setWidget).toHaveBeenLastCalledWith("rpiv-lanes", undefined); // dock disposed
		// Default editor restored (setEditorComponent(undefined)).
		expect(ui.setEditorComponent as unknown as ReturnType<typeof vi.fn>).toHaveBeenLastCalledWith(undefined);
	});
});
