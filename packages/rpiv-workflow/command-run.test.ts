/**
 * command-run.test.ts — the float boundary.
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
import {
	MSG_FLAG_REPEATED,
	MSG_JUMP_CAP_ABOVE_LAP_CEILING,
	MSG_NAME_IGNORED_ON_RESUME,
	MSG_RESUME_USAGE,
	MSG_WORKFLOW_THREW,
} from "./messages.js";

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
// The REAL defaults — the handler reads them from run-context.ts directly,
// past the barrel mock above, so these pins move with a constants bump.
import { MAX_BACKWARD_JUMPS, MAX_LAPS } from "./runner/run-context.js";

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

// The settle tails fire on the ctx captured at /wf time, which pi invalidates
// on any launcher session replacement (/new, resume, /reload, auto-compaction)
// — every ctx getter then throws the stale error. Pre-guard, that throw
// escaped the .catch tail as an unhandled rejection → uncaughtException → pi
// exited (frequent with parallel runs: one replacement poisons every floated
// promise at once). The pinned message is pi-core's exact phrase.
describe("float tails on a stale launcher ctx", () => {
	const STALE_CTX_MESSAGE = "This extension ctx is stale after session replacement or reload.";

	it("drops the failure toast when the ctx went stale while the run floated — no unhandled rejection", async () => {
		const ctx = makeCtx();
		vi.mocked(ctx.ui.notify).mockImplementation(() => {
			throw new Error(STALE_CTX_MESSAGE);
		});
		vi.mocked(runWorkflow).mockRejectedValue(new Error("boom"));
		const unhandled = vi.fn();
		process.once("unhandledRejection", unhandled);

		await handleWorkflowCommand(HOST, "ship do the thing", ctx);
		await flush();

		// The toast was attempted, threw stale, and was dropped — pi survives.
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(unhandled).not.toHaveBeenCalled();
		process.removeListener("unhandledRejection", unhandled);
	});

	it("drops the resume-tail toast on a stale ctx — no unhandled rejection", async () => {
		const ctx = makeCtx();
		vi.mocked(ctx.ui.notify).mockImplementation(() => {
			throw new Error(STALE_CTX_MESSAGE);
		});
		vi.mocked(resumeWorkflowByRunId).mockRejectedValue(new Error("resume boom"));
		const unhandled = vi.fn();
		process.once("unhandledRejection", unhandled);

		await handleWorkflowCommand(HOST, "@my-run", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(unhandled).not.toHaveBeenCalled();
		process.removeListener("unhandledRejection", unhandled);
	});

	it("drops a stale pre-flight toast in the .then tail without cascading into the .catch", async () => {
		const ctx = makeCtx();
		vi.mocked(ctx.ui.notify).mockImplementationOnce(() => {
			throw new Error(STALE_CTX_MESSAGE);
		});
		vi.mocked(runWorkflow).mockResolvedValue({
			stagesCompleted: 0,
			success: false,
			runId: undefined,
			error: "name collision",
		});

		await handleWorkflowCommand(HOST, "ship do the thing", ctx);
		await flush();

		// Swallowed in the .then tail — the .catch never fires a second notify.
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
	});

	it("a non-stale notify throw still propagates (the .then tail's throw reaches the .catch)", async () => {
		const ctx = makeCtx();
		const err = new Error("tui exploded");
		vi.mocked(ctx.ui.notify).mockImplementationOnce(() => {
			throw err;
		});
		vi.mocked(runWorkflow).mockResolvedValue({
			stagesCompleted: 0,
			success: false,
			runId: undefined,
			error: "name collision",
		});

		await handleWorkflowCommand(HOST, "ship do the thing", ctx);
		await flush();

		// The genuine error escaped the guard and surfaced through the .catch tail.
		expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(MSG_WORKFLOW_THREW(formatError(err)), "error");
	});
});

// ---------------------------------------------------------------------------
// Caps threading — --max-jumps / --max-laps must reach BOTH float arms'
// runner options: runWorkflow (fresh run) and resumeWorkflowByRunId (@resume).
// The parseArgs fixpoint feeds both; these pins hold the handler seam.
// ---------------------------------------------------------------------------

describe("handleWorkflowCommand — caps threading (both arms)", () => {
	it("threads --max-jumps + --max-laps through to runWorkflow options", async () => {
		const ctx = makeCtx();
		vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "ship do the thing --max-jumps 6 --max-laps 8", ctx);
		await flush();

		const opts = vi.mocked(runWorkflow).mock.calls[0]?.[1];
		expect(opts?.maxBackwardJumps).toBe(6);
		expect(opts?.maxLaps).toBe(8);
	});

	it("threads --max-laps alone on the run arm (maxBackwardJumps stays undefined)", async () => {
		const ctx = makeCtx();
		vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "ship do the thing --max-laps 8", ctx);
		await flush();

		const opts = vi.mocked(runWorkflow).mock.calls[0]?.[1];
		expect(opts?.maxLaps).toBe(8);
		expect(opts?.maxBackwardJumps).toBeUndefined();
	});

	it("threads --max-jumps + --max-laps on the @resume arm into resumeWorkflowByRunId options", async () => {
		const ctx = makeCtx();
		vi.mocked(resumeWorkflowByRunId).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "@my-run --max-jumps 6 --max-laps 8", ctx);
		await flush();

		const opts = vi.mocked(resumeWorkflowByRunId).mock.calls[0]?.[2];
		expect(opts).toMatchObject({ maxBackwardJumps: 6, maxLaps: 8 });
		expect(opts?.host).toBe(HOST);
	});

	it("threads --max-laps alone on the @resume arm", async () => {
		const ctx = makeCtx();
		vi.mocked(resumeWorkflowByRunId).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "@my-run --max-laps 8", ctx);
		await flush();

		const opts = vi.mocked(resumeWorkflowByRunId).mock.calls[0]?.[2];
		expect(opts?.maxLaps).toBe(8);
		expect(opts?.maxBackwardJumps).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Repeated flags — a doubled `--max-jumps`/`--max-laps` once hijacked
// workflow resolution (the stranded repeat became the residual's first
// token, so the whole line ran as prompt input to the DEFAULT workflow).
// The parser now strips the repeat first-wins; the handler warns per token.
// ---------------------------------------------------------------------------

describe("handleWorkflowCommand — repeated flags", () => {
	it("a doubled leading --max-jumps warns once and still runs the user's workflow with the first value", async () => {
		const ctx = makeCtx();
		vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "--max-jumps 6 --max-jumps 7 ship do the thing", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_FLAG_REPEATED("--max-jumps"), "warning");
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		const opts = vi.mocked(runWorkflow).mock.calls[0]?.[1];
		expect(opts?.workflow).toMatchObject({ name: "ship" });
		expect(opts).toMatchObject({ input: "do the thing", maxBackwardJumps: 6 });
	});

	it("both caps doubled warn once per token", async () => {
		const ctx = makeCtx();
		vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "--max-jumps 6 --max-laps 8 ship do the thing --max-jumps 7 --max-laps 9", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_FLAG_REPEATED("--max-jumps"), "warning");
		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_FLAG_REPEATED("--max-laps"), "warning");
		expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
		expect(vi.mocked(runWorkflow).mock.calls[0]?.[1]).toMatchObject({
			input: "do the thing",
			maxBackwardJumps: 6,
			maxLaps: 8,
		});
	});

	it("a doubled trailing caps flag on the @resume arm warns and resumes with the first-TYPED value", async () => {
		const ctx = makeCtx();
		vi.mocked(resumeWorkflowByRunId).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "@my-run --max-laps 4 --max-laps 9", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_FLAG_REPEATED("--max-laps"), "warning");
		expect(vi.mocked(resumeWorkflowByRunId).mock.calls[0]?.[1]).toBe("my-run");
		expect(vi.mocked(resumeWorkflowByRunId).mock.calls[0]?.[2]).toMatchObject({ maxLaps: 4 });
	});

	it("a masked-head doubled --name: the duplicate toast fires, no mid-input warning, and the FIRST-typed name reaches the run", async () => {
		const ctx = makeCtx();
		vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		// `--max-jumps 6` heads the line, so `--name x` is masked in pass 1 and
		// the trailing `--name y` is extracted first; `x` was typed first and is
		// the name the run claims on disk.
		await handleWorkflowCommand(HOST, "--max-jumps 6 --name x ship do the thing --name y", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_FLAG_REPEATED("--name"), "warning");
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runWorkflow).mock.calls[0]?.[1]).toMatchObject({
			input: "do the thing",
			name: "x",
			maxBackwardJumps: 6,
		});
	});

	it("a doubled --name on the @resume arm warns ONCE (ignored-on-resume), not 'first value wins' on a name about to be dropped", async () => {
		const ctx = makeCtx();
		vi.mocked(resumeWorkflowByRunId).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "@my-run --name a --name b", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_NAME_IGNORED_ON_RESUME, "warning");
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(vi.mocked(resumeWorkflowByRunId).mock.calls[0]?.[1]).toBe("my-run");
	});

	it("a doubled caps flag beside a doubled --name on @resume still warns for the caps flag", async () => {
		const ctx = makeCtx();
		vi.mocked(resumeWorkflowByRunId).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "--max-laps 4 @my-run --name a --name b --max-laps 9", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_FLAG_REPEATED("--max-laps"), "warning");
		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_NAME_IGNORED_ON_RESUME, "warning");
		expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
		expect(vi.mocked(resumeWorkflowByRunId).mock.calls[0]?.[2]).toMatchObject({ maxLaps: 4 });
	});

	it("a masked-head doubled --max-jumps on the @resume arm resumes with the first-typed value", async () => {
		const ctx = makeCtx();
		vi.mocked(resumeWorkflowByRunId).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "--max-laps 8 --max-jumps 6 @my-run --max-jumps 7", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_FLAG_REPEATED("--max-jumps"), "warning");
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(vi.mocked(resumeWorkflowByRunId).mock.calls[0]?.[1]).toBe("my-run");
		expect(vi.mocked(resumeWorkflowByRunId).mock.calls[0]?.[2]).toMatchObject({ maxBackwardJumps: 6, maxLaps: 8 });
	});

	it("the two warnings agree on the head-flag shape: a masked leading --max-jumps still wins over the trailing repeat", async () => {
		const ctx = makeCtx();
		vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		// `--max-laps 8` heads the line, so `--max-jumps 9` is masked in pass 1
		// and the trailing `2` is extracted first. First-typed 9 ≥ ceiling 8:
		// both toasts fire on the same value, and 9 is what the run receives.
		await handleWorkflowCommand(HOST, "--max-laps 8 --max-jumps 9 ship do the thing --max-jumps 2", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_FLAG_REPEATED("--max-jumps"), "warning");
		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_JUMP_CAP_ABOVE_LAP_CEILING(9, 8), "warning");
		expect(ctx.ui.notify).toHaveBeenCalledTimes(2);
		expect(vi.mocked(runWorkflow).mock.calls[0]?.[1]).toMatchObject({
			input: "do the thing",
			maxBackwardJumps: 9,
			maxLaps: 8,
		});
	});

	it("the two warnings agree on a trailing double: the toast's kept value is the one the ceiling check arbitrates", async () => {
		const ctx = makeCtx();
		vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		// First-typed 20 wins (≥ the default ceiling) — so BOTH warnings fire;
		// under last-typed-wins the cap would be 6 and the ceiling toast silent
		// while the duplicate toast claimed "first value wins".
		await handleWorkflowCommand(HOST, "ship do the thing --max-jumps 20 --max-jumps 6", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_FLAG_REPEATED("--max-jumps"), "warning");
		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_JUMP_CAP_ABOVE_LAP_CEILING(20, MAX_LAPS), "warning");
		expect(vi.mocked(runWorkflow).mock.calls[0]?.[1]).toMatchObject({ maxBackwardJumps: 20 });
	});
});

// ---------------------------------------------------------------------------
// Cap-above-ceiling — the ceiling counts every re-entry and is arbitrated
// first, so a jump cap at or above the lap ceiling can never trip. The
// handler warns on the EFFECTIVE pair (absent flag ⇒ default) and proceeds.
// ---------------------------------------------------------------------------

describe("handleWorkflowCommand — --max-jumps at or above the lap ceiling", () => {
	it("--max-jumps alone above the default ceiling warns with the effective pair and still runs", async () => {
		const ctx = makeCtx();
		vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "ship do the thing --max-jumps 20", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_JUMP_CAP_ABOVE_LAP_CEILING(20, MAX_LAPS), "warning");
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runWorkflow).mock.calls[0]?.[1]).toMatchObject({ maxBackwardJumps: 20 });
		expect(vi.mocked(runWorkflow).mock.calls[0]?.[1]?.maxLaps).toBeUndefined();
	});

	it("equal budgets warn too (revisits ≤ laps — the ceiling still wins the tie)", async () => {
		const ctx = makeCtx();
		vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "ship do the thing --max-jumps 8 --max-laps 8", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_JUMP_CAP_ABOVE_LAP_CEILING(8, 8), "warning");
	});

	it("--max-laps alone BELOW the default cap warns on the effective pair (default cap ≥ ceiling 0)", async () => {
		const ctx = makeCtx();
		vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "ship do the thing --max-laps 0", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_JUMP_CAP_ABOVE_LAP_CEILING(MAX_BACKWARD_JUMPS, 0), "warning");
	});

	it("a cap strictly below the ceiling is silent", async () => {
		const ctx = makeCtx();
		vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "ship do the thing --max-jumps 6 --max-laps 8", ctx);
		await flush();

		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("the REAL defaults are silent — the production invariant, not a mocked pair", async () => {
		expect(MAX_BACKWARD_JUMPS).toBeLessThan(MAX_LAPS);
		const ctx = makeCtx();
		vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "ship do the thing", ctx);
		await flush();

		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("warns on the @resume arm as well (both arms thread the same budgets)", async () => {
		const ctx = makeCtx();
		vi.mocked(resumeWorkflowByRunId).mockResolvedValue({ stagesCompleted: 1, success: true, runId: "r1" });

		await handleWorkflowCommand(HOST, "@my-run --max-jumps 9", ctx);
		await flush();

		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_JUMP_CAP_ABOVE_LAP_CEILING(9, MAX_LAPS), "warning");
		expect(vi.mocked(resumeWorkflowByRunId).mock.calls[0]?.[2]).toMatchObject({ maxBackwardJumps: 9 });
	});
});
