import { buildSessionEntries, createMockCtx, createMockPi, makeTodoToolResult } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const overlayMock = vi.hoisted(() => ({
	importGate: undefined as Promise<void> | undefined,
	moduleLoads: 0,
}));

vi.mock("./todo-overlay.js", async (importOriginal) => {
	overlayMock.moduleLoads++;
	await overlayMock.importGate;
	return importOriginal<typeof import("./todo-overlay.js")>();
});

function resumedBranch(subject: string) {
	return buildSessionEntries([
		makeTodoToolResult({
			action: "create",
			params: { subject },
			tasks: [{ id: 1, subject, status: "pending" }],
			nextId: 2,
		}),
	]);
}

async function setup(importOverlay?: () => Promise<typeof import("./todo-overlay.js")>) {
	const { default: registerTodo } = await import("./index.js");
	const { pi, captured } = createMockPi();
	registerTodo(pi, importOverlay);
	const start = captured.events.get("session_start")?.[0];
	const shutdown = captured.events.get("session_shutdown")?.[0];
	const toolEnd = captured.events.get("tool_execution_end")?.[0];
	const tool = captured.tools.get("todo");
	if (!start || !shutdown || !toolEnd || !tool) throw new Error("todo lifecycle was not registered");
	return { shutdown, start, tool, toolEnd };
}

beforeEach(() => {
	vi.resetModules();
	overlayMock.importGate = undefined;
	overlayMock.moduleLoads = 0;
});

afterEach(() => {
	if (vi.isFakeTimers()) vi.clearAllTimers();
	vi.useRealTimers();
});

it("keeps overlay construction foreground-gated and ignores stale imports", async () => {
	vi.useFakeTimers();
	let releaseImport!: () => void;
	overlayMock.importGate = new Promise<void>((resolve) => {
		releaseImport = resolve;
	});
	const staleLifecycle = await setup();
	const staleCtx = createMockCtx({ hasUI: true, sessionId: "stale" });

	// A foreground session_start now kicks the lazy import immediately (it
	// registers the zero-row widget), so the import gate hangs the start.
	const initialStart = staleLifecycle.start({} as never, staleCtx as never);
	await vi.waitFor(() => expect(overlayMock.moduleLoads).toBe(1));
	const staleUpdate = Promise.resolve(
		staleLifecycle.tool.execute?.(
			"tc",
			{ action: "create", subject: "stale task" } as never,
			undefined as never,
			undefined as never,
			staleCtx as never,
		),
	).then(() => staleLifecycle.toolEnd({ toolName: "todo", isError: false } as never, staleCtx as never));
	await staleLifecycle.shutdown({} as never, staleCtx as never);

	const replacementCtx = createMockCtx({
		branch: resumedBranch("replacement task"),
		hasUI: true,
		sessionId: "replacement",
	});
	const replacementStart = staleLifecycle.start({} as never, replacementCtx as never);
	releaseImport();
	await Promise.all([initialStart, staleUpdate, replacementStart]);

	expect(staleCtx.ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	expect(replacementCtx.ui.setWidget as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);

	// A clean empty session registers its zero-row widget immediately on
	// session_start (holding the Map insertion slot ahead of later widgets);
	// a later mutation refreshes through that same registration.
	await staleLifecycle.shutdown({} as never, replacementCtx as never);
	overlayMock.importGate = undefined;
	const currentLifecycle = await setup();
	const currentCtx = createMockCtx({ hasUI: true, sessionId: "current" });
	await currentLifecycle.start({} as never, currentCtx as never);
	expect(currentCtx.ui.setWidget as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
	expect(currentCtx.ui.setWidget as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
		"rpiv-todos",
		expect.any(Function),
		{ placement: "aboveEditor" },
	);
	await currentLifecycle.tool.execute?.(
		"tc",
		{ action: "create", subject: "first" } as never,
		undefined as never,
		undefined as never,
		currentCtx as never,
	);
	await currentLifecycle.toolEnd({ toolName: "todo", isError: false } as never, currentCtx as never);

	expect(currentCtx.ui.setWidget as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
});

it("drops a rejected overlay import memo so the next load retries", async () => {
	const { makeTodoOverlayLoader } = await import("./index.js");
	const healthyModule = { TodoOverlay: class {} } as unknown as typeof import("./todo-overlay.js");
	let shouldFail = true;
	const importer = vi.fn(async () => {
		if (shouldFail) {
			shouldFail = false;
			throw new Error("transient overlay load failure");
		}
		return healthyModule;
	});
	const load = makeTodoOverlayLoader(importer);

	await expect(load()).rejects.toThrow("transient overlay load failure");
	await expect(load()).resolves.toBe(healthyModule);
	expect(importer).toHaveBeenCalledTimes(2);
});

it("reports jiti's poisoned namespace shape instead of constructing undefined", async () => {
	const { makeTodoOverlayLoader } = await import("./index.js");
	const staleModule = { TodoOverlay: undefined } as unknown as typeof import("./todo-overlay.js");
	const load = makeTodoOverlayLoader(async () => staleModule);

	await expect(load()).rejects.toThrow("module cache is stale; restart Pi");
});

it("schedules the overlay pre-warm after startup", async () => {
	vi.useFakeTimers();
	const { PREWARM_DELAY_MS } = await import("./index.js");
	const overlayUpdate = vi.fn();
	const healthyModule = {
		TodoOverlay: class {
			setUICtx(): void {}
			resetCompletedDisplayState(): void {}
			update(): void {
				overlayUpdate();
			}
		},
	} as unknown as typeof import("./todo-overlay.js");
	const importer = vi.fn(async () => healthyModule);
	const lifecycle = await setup(importer);

	expect(importer).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS - 1);
	expect(importer).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(importer).toHaveBeenCalledTimes(1);

	const ctx = createMockCtx({ hasUI: true, sessionId: "empty" });
	await lifecycle.start({} as never, ctx as never);
	// session_start now constructs the overlay right away (the zero-row
	// registration) instead of deferring to the first mutation.
	expect(overlayUpdate).toHaveBeenCalledTimes(1);
});

it("swallows a failed pre-warm, then retries on the first real update", async () => {
	vi.useFakeTimers();
	const { PREWARM_DELAY_MS } = await import("./index.js");
	let shouldFail = true;
	const overlayUpdate = vi.fn();
	const healthyModule = {
		TodoOverlay: class {
			setUICtx(): void {}
			resetCompletedDisplayState(): void {}
			update(): void {
				overlayUpdate();
			}
		},
	} as unknown as typeof import("./todo-overlay.js");
	const importer = vi.fn(async (): Promise<typeof import("./todo-overlay.js")> => {
		if (shouldFail) {
			shouldFail = false;
			throw new Error("pre-warm load failure");
		}
		return healthyModule;
	});
	const lifecycle = await setup(importer);

	await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
	expect(importer).toHaveBeenCalledTimes(1);

	// session_start now retries the load itself (the memo was cleared after
	// the rejected pre-warm); the second import succeeds and the overlay
	// refreshes right away.
	const ctx = createMockCtx({ hasUI: true, sessionId: "retry" });
	await lifecycle.start({} as never, ctx as never);
	expect(overlayUpdate).toHaveBeenCalledTimes(1);
	await lifecycle.tool.execute?.(
		"tc",
		{ action: "create", subject: "retry task" } as never,
		undefined as never,
		undefined as never,
		ctx as never,
	);
	await lifecycle.toolEnd({ toolName: "todo", isError: false } as never, ctx as never);

	expect(importer).toHaveBeenCalledTimes(2);
	expect(overlayUpdate).toHaveBeenCalledTimes(2);
});

it("concurrent awaiters of one rejected import share a single retry", async () => {
	const { makeTodoOverlayLoader } = await import("./index.js");
	const healthyModule = { TodoOverlay: class {} } as unknown as typeof import("./todo-overlay.js");
	let shouldFail = true;
	const importer = vi.fn(async () => {
		if (shouldFail) {
			shouldFail = false;
			throw new Error("shared load failure");
		}
		return healthyModule;
	});
	const load = makeTodoOverlayLoader(importer);

	// Both callers join the same in-flight import and see the same rejection;
	// only one underlying import ran, and only one retry runs afterwards.
	const first = load();
	const second = load();
	await expect(first).rejects.toThrow("shared load failure");
	await expect(second).rejects.toThrow("shared load failure");
	expect(importer).toHaveBeenCalledTimes(1);

	await expect(load()).resolves.toBe(healthyModule);
	expect(importer).toHaveBeenCalledTimes(2);
});

it("tool_execution_end swallows a transient load failure and heals on the next event", async () => {
	let shouldFail = true;
	const overlayUpdate = vi.fn();
	const healthyModule = {
		TodoOverlay: class {
			setUICtx(): void {}
			resetCompletedDisplayState(): void {}
			update(): void {
				overlayUpdate();
			}
		},
	} as unknown as typeof import("./todo-overlay.js");
	const importer = vi.fn(async (): Promise<typeof import("./todo-overlay.js")> => {
		if (shouldFail) {
			shouldFail = false;
			throw new Error("transient overlay load failure");
		}
		return healthyModule;
	});
	const lifecycle = await setup(importer);
	const ctx = createMockCtx({ hasUI: true, sessionId: "fail-soft" });
	// session_start consumes the first (failing) load; its warn is the same
	// swallow path, so spy before the start instead of after the tool call.
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	await lifecycle.start({} as never, ctx as never);
	await lifecycle.tool.execute?.(
		"tc",
		{ action: "create", subject: "fail-soft task" } as never,
		undefined as never,
		undefined as never,
		ctx as never,
	);

	// The first toolEnd already retried the load (memo cleared by the failed
	// start) and healed, so the overlay refreshed once — no extension error
	// surfaced despite the failed start.
	await expect(
		lifecycle.toolEnd({ toolName: "todo", isError: false } as never, ctx as never),
	).resolves.toBeUndefined();
	expect(warn).toHaveBeenCalledTimes(1);
	expect(warn.mock.calls[0]?.[0]).toContain("transient overlay load failure");
	warn.mockRestore();
	expect(overlayUpdate).toHaveBeenCalledTimes(1);

	// The next event refreshes through the loaded module without importing.
	await lifecycle.toolEnd({ toolName: "todo", isError: false } as never, ctx as never);
	expect(importer).toHaveBeenCalledTimes(2);
	expect(overlayUpdate).toHaveBeenCalledTimes(2);
});

it("session_start still propagates the latched stale-namespace restart error", async () => {
	const staleModule = { TodoOverlay: undefined } as unknown as typeof import("./todo-overlay.js");
	const lifecycle = await setup(async () => staleModule);
	const ctx = createMockCtx({ hasUI: true, sessionId: "stale-latch" });

	// The first load now happens on session_start, so the latched error
	// rejects there instead of at the first tool_execution_end.
	await expect(lifecycle.start({} as never, ctx as never)).rejects.toThrow("module cache is stale; restart Pi");
});
