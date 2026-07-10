import { buildSessionEntries, createMockCtx, createMockPi, makeTodoToolResult } from "@juicesharp/rpiv-test-utils";
import { beforeEach, expect, it, vi } from "vitest";

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

async function setup() {
	const { default: registerTodo } = await import("./index.js");
	const { pi, captured } = createMockPi();
	registerTodo(pi);
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

it("loads the overlay only when tasks need rendering and ignores stale imports", async () => {
	let releaseImport!: () => void;
	overlayMock.importGate = new Promise<void>((resolve) => {
		releaseImport = resolve;
	});
	const staleLifecycle = await setup();
	const staleCtx = createMockCtx({ hasUI: true, sessionId: "stale" });

	// Registering the extension and starting an empty session must not evaluate
	// the overlay module or touch the widget API.
	expect(overlayMock.moduleLoads).toBe(0);
	await staleLifecycle.start({} as never, staleCtx as never);
	expect(overlayMock.moduleLoads).toBe(0);
	expect(staleCtx.ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

	// The first successful mutation starts the lazy import. Replace the session
	// while that import is pending, and resume the replacement with persisted work.
	await staleLifecycle.tool.execute?.(
		"tc",
		{ action: "create", subject: "stale task" } as never,
		undefined as never,
		undefined as never,
		staleCtx as never,
	);
	const staleUpdate = staleLifecycle.toolEnd({ toolName: "todo", isError: false } as never, staleCtx as never);
	await vi.waitFor(() => expect(overlayMock.moduleLoads).toBe(1));
	await staleLifecycle.shutdown({} as never, staleCtx as never);

	const replacementCtx = createMockCtx({
		branch: resumedBranch("replacement task"),
		hasUI: true,
		sessionId: "replacement",
	});
	const replacementStart = staleLifecycle.start({} as never, replacementCtx as never);
	releaseImport();
	await Promise.all([staleUpdate, replacementStart]);

	expect(staleCtx.ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	expect(replacementCtx.ui.setWidget as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);

	// A clean empty session still renders immediately after its first successful
	// mutation, even when the module itself is already cached.
	await staleLifecycle.shutdown({} as never, replacementCtx as never);
	overlayMock.importGate = undefined;
	const currentLifecycle = await setup();
	const currentCtx = createMockCtx({ hasUI: true, sessionId: "current" });
	await currentLifecycle.start({} as never, currentCtx as never);
	expect(currentCtx.ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	await currentLifecycle.tool.execute?.(
		"tc",
		{ action: "create", subject: "first" } as never,
		undefined as never,
		undefined as never,
		currentCtx as never,
	);
	await currentLifecycle.toolEnd({ toolName: "todo", isError: false } as never, currentCtx as never);

	expect(currentCtx.ui.setWidget as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
		"rpiv-todos",
		expect.any(Function),
		{ placement: "aboveEditor" },
	);
});
