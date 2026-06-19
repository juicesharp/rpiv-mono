/**
 * command-run.test.ts — the float boundary (Phase 3 / FR1).
 *
 * `/wf` and `/wf @<ref>` no longer await the run — they `void` it off the prompt
 * with a `.then(surfacePreflight).catch(toast)` tail so the prompt returns
 * immediately, a pre-flight rejection still surfaces, and a thrown
 * predicate/invariant can never escape as an unhandled rejection (NFR).
 *
 * The runner is mocked at the float boundary (`./runner/index.js`); the loader
 * is mocked to a single registered workflow so parseArgs resolves a run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowHost, WorkflowHostContext } from "./host.js";
import { formatError } from "./internal-utils.js";
import { MSG_RESUME_USAGE, MSG_WORKFLOW_THREW } from "./messages.js";

// Mock the loader to a single registered workflow — parseArgs sees "ship" as a
// workflow name, so `/wf ship <input>` resolves a run without touching disk.
vi.mock("./load/index.js", () => ({
	loadWorkflows: vi.fn(async () => ({
		workflows: [{ name: "ship" }],
		issues: [],
		default: undefined,
		skillAliases: {},
	})),
	findWorkflow: vi.fn((_loaded: unknown, name: string) => (name === "ship" ? { name: "ship" } : undefined)),
}));

// Mock the float boundary — runWorkflow / resumeWorkflowByRunId are the two
// promises `/wf` floats off the prompt.
vi.mock("./runner/index.js", () => ({
	runWorkflow: vi.fn(),
	resumeWorkflowByRunId: vi.fn(),
}));

import { handleWorkflowCommand } from "./command-run.js";
import { resumeWorkflowByRunId, runWorkflow } from "./runner/index.js";

const HOST = {} as unknown as WorkflowHost;

/** Flush queued microtasks so a floated `.then`/`.catch` runs. */
const flush = () => new Promise((r) => setImmediate(r));

/** A deferred whose `promise` is resolved/rejected by hand — to control settle timing. */
function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeCtx(): WorkflowHostContext {
	return {
		hasUI: true,
		cwd: "/tmp/test-cwd",
		ui: { notify: vi.fn() },
	} as unknown as WorkflowHostContext;
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.mocked(runWorkflow).mockReset();
	vi.mocked(resumeWorkflowByRunId).mockReset();
});

describe("handleWorkflowCommand — float boundary", () => {
	it("returns BEFORE the run promise settles (the float)", async () => {
		const ctx = makeCtx();
		const d = deferred<Awaited<ReturnType<typeof runWorkflow>>>();
		vi.mocked(runWorkflow).mockReturnValue(d.promise);

		// Resolves even though the run promise is still pending — proof it floated.
		await handleWorkflowCommand(HOST, "ship do the thing", ctx);

		expect(runWorkflow).toHaveBeenCalledTimes(1);
		// No notify yet: the run is still in flight.
		expect(ctx.ui.notify).not.toHaveBeenCalled();

		// Settle the run after the fact — the floated .then runs on the next tick.
		d.resolve({ stagesCompleted: 1, success: true, runId: "r1" });
		await flush();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("surfaces MSG_WORKFLOW_THREW via notify(error) on a rejecting run — no unhandled rejection", async () => {
		const ctx = makeCtx();
		const err = new Error("boom");
		vi.mocked(runWorkflow).mockRejectedValue(err);
		const unhandled = vi.fn();
		process.once("unhandledRejection", unhandled);

		await handleWorkflowCommand(HOST, "ship do the thing", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_WORKFLOW_THREW(formatError(err)), "error");
		expect(unhandled).not.toHaveBeenCalled();
		process.removeListener("unhandledRejection", unhandled);
	});

	it("surfaces a pre-flight envelope (no runId) via notify(error)", async () => {
		const ctx = makeCtx();
		vi.mocked(runWorkflow).mockResolvedValue({
			stagesCompleted: 0,
			success: false,
			runId: undefined,
			error: "name collision",
		});

		await handleWorkflowCommand(HOST, "ship do the thing", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith("name collision", "error");
	});

	it("does NOT double-notify an in-run failure that carries a runId", async () => {
		const ctx = makeCtx();
		vi.mocked(runWorkflow).mockResolvedValue({
			stagesCompleted: 2,
			success: false,
			runId: "r1",
			error: "stage blew up",
		});

		await handleWorkflowCommand(HOST, "ship do the thing", ctx);
		await flush();

		// runId present ⇒ the stage machinery already notified; the float tail stays quiet.
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

describe("handleWorkflowCommand — resume float", () => {
	it("floats the resume and returns before it settles", async () => {
		const ctx = makeCtx();
		const d = deferred<Awaited<ReturnType<typeof resumeWorkflowByRunId>>>();
		vi.mocked(resumeWorkflowByRunId).mockReturnValue(d.promise);

		await handleWorkflowCommand(HOST, "@my-run", ctx);

		expect(resumeWorkflowByRunId).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).not.toHaveBeenCalled();

		d.resolve({ stagesCompleted: 1, success: true, runId: "r1" });
		await flush();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("surfaces MSG_WORKFLOW_THREW on a rejecting resume — no unhandled rejection", async () => {
		const ctx = makeCtx();
		const err = new Error("resume boom");
		vi.mocked(resumeWorkflowByRunId).mockRejectedValue(err);
		const unhandled = vi.fn();
		process.once("unhandledRejection", unhandled);

		await handleWorkflowCommand(HOST, "@my-run", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_WORKFLOW_THREW(formatError(err)), "error");
		expect(unhandled).not.toHaveBeenCalled();
		process.removeListener("unhandledRejection", unhandled);
	});

	it("surfaces a no-JSONL resume refusal (no runId) via notify(error)", async () => {
		const ctx = makeCtx();
		vi.mocked(resumeWorkflowByRunId).mockResolvedValue({
			stagesCompleted: 0,
			success: false,
			runId: undefined,
			error: "run not found",
		});

		await handleWorkflowCommand(HOST, "@missing", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith("run not found", "error");
	});

	it("still notifies MSG_RESUME_USAGE on an empty ref (the if(!ref) guard) — no resume floated", async () => {
		const ctx = makeCtx();

		await handleWorkflowCommand(HOST, "@", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_RESUME_USAGE, "error");
		expect(resumeWorkflowByRunId).not.toHaveBeenCalled();
	});
});
