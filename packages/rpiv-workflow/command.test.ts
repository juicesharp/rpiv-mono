import { createMockCommandCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acts, defineWorkflow, produces } from "./api.js";
import { registerBuiltInsProvider } from "./built-ins.js";

// Mock runner to avoid needing the full Pi session runtime. The resume path
// delegates to resumeWorkflowByRunId (which owns resolve → load-gate → find →
// resumeWorkflow); its internals are covered in runner/by-run-id.test.ts.
vi.mock("./runner/index.js", () => ({
	runWorkflow: vi.fn(async () => ({ stagesCompleted: 2, success: true })),
	resumeWorkflowByRunId: vi.fn(async () => ({ runId: "r", stagesCompleted: 1, success: true })),
}));

// Mock load.ts to avoid jiti + filesystem I/O. The mock provides a stable
// LoadedWorkflows shape every test reuses; per-test overrides via mockReturnValueOnce.
const tinyWorkflow = defineWorkflow({
	name: "tiny",
	start: "research",
	stages: { research: produces(), commit: acts() },
	edges: { research: "commit", commit: "stop" },
});
const midWorkflow = defineWorkflow({
	name: "mid",
	start: "research",
	stages: {
		research: produces(),
		implement: acts(),
		commit: acts(),
	},
	edges: { research: "implement", implement: "commit", commit: "stop" },
});
const reviewWorkflow = defineWorkflow({
	name: "review",
	start: "code-review",
	stages: { "code-review": produces(), commit: acts() },
	edges: { "code-review": "commit", commit: "stop" },
});

vi.mock("./load/index.js", () => ({
	loadWorkflows: vi.fn(async () => ({
		workflows: [tinyWorkflow, midWorkflow, reviewWorkflow],
		default: "mid",
		workflowSources: new Map([
			["tiny", "built-in"],
			["mid", "built-in"],
			["review", "built-in"],
		]),
		layers: ["built-in"],
		issues: [],
		skillAliases: {},
		skillContracts: new Map(),
	})),
	findWorkflow: vi.fn((loaded: { workflows: { name: string }[] }, name: string) =>
		loaded.workflows.find((w) => w.name === name),
	),
}));

import { MSG_RUNTIME_LOADING, makeWfHandler, PREWARM_DELAY_MS, parseArgs, registerWorkflowCommand } from "./command.js";
import { loadWorkflows } from "./load/index.js";
import { resumeWorkflowByRunId, runWorkflow } from "./runner/index.js";

beforeEach(() => {
	vi.mocked(runWorkflow).mockReset();
	vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 2, success: true });
	vi.mocked(resumeWorkflowByRunId).mockReset();
	vi.mocked(resumeWorkflowByRunId).mockResolvedValue({ runId: "r", stagesCompleted: 1, success: true });
});

// ---------------------------------------------------------------------------
// parseArgs — pure helper
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
	const built = {
		workflowNames: new Set(["tiny", "mid", "review"]),
		default: "mid",
	};

	it("parses workflow name + input", () => {
		expect(parseArgs("mid Add dark mode", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "Add dark mode",
		});
	});

	it("defaults to the default workflow when no name is recognized", () => {
		expect(parseArgs("Add dark mode", built)).toEqual({ kind: "run", workflow: "mid", input: "Add dark mode" });
	});

	it("parses a workflow-name-only token with no input", () => {
		expect(parseArgs("review", built)).toEqual({ kind: "run", workflow: "review", input: "" });
	});

	it("handles empty string", () => {
		expect(parseArgs("", built)).toEqual({ kind: "run", workflow: "mid", input: "" });
	});

	it("handles whitespace-only string", () => {
		expect(parseArgs("   ", built)).toEqual({ kind: "run", workflow: "mid", input: "" });
	});

	it("uses custom default when no workflow name is recognized", () => {
		const customConfig = {
			workflowNames: new Set(["my-flow"]),
			default: "my-flow",
		};
		expect(parseArgs("Add feature", customConfig)).toEqual({
			kind: "run",
			workflow: "my-flow",
			input: "Add feature",
		});
	});

	it("extracts a LEADING --name and strips it from the input", () => {
		expect(parseArgs("--name auth-spike mid Add dark mode", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "Add dark mode",
			name: "auth-spike",
		});
	});

	it("leaves a MID-INPUT --name in the prompt text untouched and flags it", () => {
		// `/wf mid fix the --name handling bug` — the flag tokens are the user's
		// own prompt text; silently claiming "handling" as a run name would
		// corrupt the input seed.
		expect(parseArgs("mid fix the --name handling bug", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "fix the --name handling bug",
			name: undefined,
			nameFlagIgnored: true,
		});
	});

	it("extracts --name when bound to the default workflow", () => {
		expect(parseArgs("Add dark mode --name spike", built)).toEqual({
			kind: "run",
			workflow: "mid",
			input: "Add dark mode",
			name: "spike",
		});
	});

	it("extracts --name on a workflow-name-only invocation", () => {
		expect(parseArgs("review --name r1", built)).toEqual({
			kind: "run",
			workflow: "review",
			input: "",
			name: "r1",
		});
	});

	it("leaves name absent when --name is not supplied", () => {
		expect(parseArgs("mid go", built)).toEqual({ kind: "run", workflow: "mid", input: "go" });
	});
});

// ---------------------------------------------------------------------------
// parseArgs — resume sigil
// ---------------------------------------------------------------------------

describe("parseArgs — resume (@ref)", () => {
	const built = {
		workflowNames: new Set(["tiny", "mid", "review"]),
		default: "mid",
	};

	it("parses @ref as resume kind", () => {
		expect(parseArgs("@2026-06-03_07-30-00-ab12", built)).toEqual({
			kind: "resume",
			ref: "2026-06-03_07-30-00-ab12",
		});
	});

	it("parses @ alone as resume with empty ref", () => {
		expect(parseArgs("@", built)).toEqual({ kind: "resume", ref: "" });
	});

	it("extracts only the first token after @ (ignores trailing tokens)", () => {
		expect(parseArgs("@run-id extra stuff", built)).toEqual({ kind: "resume", ref: "run-id" });
	});

	it("@ with whitespace-only trailing content returns empty ref", () => {
		expect(parseArgs("@   ", built)).toEqual({ kind: "resume", ref: "" });
	});

	it("tolerates a space after the sigil (@ ref === @ref)", () => {
		expect(parseArgs("@ run-id", built)).toEqual({ kind: "resume", ref: "run-id" });
	});

	it("carries a --name supplied with @resume as droppedName (resolved later as ignored)", () => {
		expect(parseArgs("@run-id --name x", built)).toEqual({
			kind: "resume",
			ref: "run-id",
			droppedName: "x",
		});
	});
});

// ---------------------------------------------------------------------------
// /wf handler shape + dispatch
// ---------------------------------------------------------------------------

describe("/wf — command shape", () => {
	it('registers under "wf"', () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		expect(captured.commands.has("wf")).toBe(true);
	});
});

describe("/wf — !hasUI", () => {
	it("notifies an error and exits without calling runWorkflow", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: false });
		await captured.commands.get("wf")?.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf — no input", () => {
	it("shows the workflow listing when no input is provided", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Available workflows"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf — valid invocation", () => {
	it("calls runWorkflow with the resolved workflow object", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("mid Add dark mode", ctx);
		expect(runWorkflow).toHaveBeenCalledTimes(1);
		const opts = vi.mocked(runWorkflow).mock.calls[0]?.[1];
		expect(opts?.workflow.name).toBe("mid");
		expect(opts?.input).toBe("Add dark mode");
	});

	it("falls back to default workflow when first token is unknown", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("Add dark mode", ctx);
		const opts = vi.mocked(runWorkflow).mock.calls[0]?.[1];
		expect(opts?.workflow.name).toBe("mid");
		expect(opts?.input).toBe("Add dark mode");
	});

	it("bare workflow-name token shows that workflow's detail view (not the full list)", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("review", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("workflow: review"), "info");
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Available workflows"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("whitespace-only input shows the full workflow list", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("   ", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Available workflows"), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf — --name flag", () => {
	it("rejects an invalid --name before calling runWorkflow", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("mid go --name 1bad", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("invalid name"), "error");
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("threads a valid trailing --name through to runWorkflow", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("mid go --name auth", ctx);
		expect(vi.mocked(runWorkflow).mock.calls[0]?.[1]?.name).toBe("auth");
	});

	it("warns on a mid-input --name and keeps it in the workflow input", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("mid fix the --name handling bug", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("first or last token"), "warning");
		expect(vi.mocked(runWorkflow).mock.calls[0]?.[1]?.name).toBeUndefined();
		expect(vi.mocked(runWorkflow).mock.calls[0]?.[1]?.input).toBe("fix the --name handling bug");
	});

	it("surfaces a pre-flight collision rejection (success:false, no runId)", async () => {
		vi.mocked(runWorkflow).mockResolvedValueOnce({
			stagesCompleted: 0,
			success: false,
			error: "name 'auth' already used by run r0",
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("mid --name auth go", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already used"), "error");
	});

	it("warns that --name is ignored on @resume and still resumes", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("@run-id --name x", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("--name has no effect"), "warning");
		expect(resumeWorkflowByRunId).toHaveBeenCalledWith(ctx, "run-id", expect.anything());
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Runtime memoization — Pi's jiti loader runs with moduleCache:false, so an
// unmemoized import() re-evaluates the whole command-run graph (~0.9s UI
// freeze) on every /wf. The handler closure memoizes the import promise.
// ---------------------------------------------------------------------------

describe("/wf — command-run import memoization", () => {
	it("runs the importer once across invocations", async () => {
		const importer = vi.fn(() => import("./command-run.js"));
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi, importer);
		await handler("mid first", createMockCommandCtx({ hasUI: true }));
		await handler("mid second", createMockCommandCtx({ hasUI: true }));
		expect(importer).toHaveBeenCalledTimes(1);
		expect(runWorkflow).toHaveBeenCalledTimes(2);
	});

	it("shows the cold-path loading toast on the first invocation only", async () => {
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi);
		const cold = createMockCommandCtx({ hasUI: true });
		await handler("mid go", cold);
		expect(cold.ui.notify).toHaveBeenCalledWith(MSG_RUNTIME_LOADING, "info");
		const warm = createMockCommandCtx({ hasUI: true });
		await handler("mid again", warm);
		expect(warm.ui.notify).not.toHaveBeenCalledWith(MSG_RUNTIME_LOADING, "info");
	});

	it("suppresses the loading toast when !hasUI", async () => {
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi);
		const ctx = createMockCommandCtx({ hasUI: false });
		await handler("mid go", ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(MSG_RUNTIME_LOADING, "info");
	});

	it("clears the memo on import rejection so the next /wf retries", async () => {
		const importer = vi
			.fn<() => Promise<typeof import("./command-run.js")>>()
			.mockRejectedValueOnce(new Error("transient import failure"))
			.mockImplementation(() => import("./command-run.js"));
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi, importer);
		await expect(handler("mid go", createMockCommandCtx({ hasUI: true }))).rejects.toThrow(
			"transient import failure",
		);
		await handler("mid go", createMockCommandCtx({ hasUI: true }));
		expect(importer).toHaveBeenCalledTimes(2);
		expect(runWorkflow).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Pre-warm — registerWorkflowCommand schedules the memoized import shortly
// after registration so the first real /wf finds the graph ready. A failed
// pre-warm clears the memo (degrades to the pre-warm-less behavior).
// ---------------------------------------------------------------------------

describe("/wf — pre-warm", () => {
	it("prewarm() shares the memo: a later /wf shows no toast and reuses the import", async () => {
		const importer = vi.fn(() => import("./command-run.js"));
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi, importer);
		await handler.prewarm();
		const ctx = createMockCommandCtx({ hasUI: true });
		await handler("mid go", ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(MSG_RUNTIME_LOADING, "info");
		expect(importer).toHaveBeenCalledTimes(1);
		expect(runWorkflow).toHaveBeenCalledTimes(1);
	});

	it("shows the toast when /wf arrives while the pre-warm is still in flight", async () => {
		let release!: (mod: typeof import("./command-run.js")) => void;
		const gate = new Promise<typeof import("./command-run.js")>((resolve) => {
			release = resolve;
		});
		const importer = vi.fn(() => gate);
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi, importer);
		const warming = handler.prewarm();
		const ctx = createMockCommandCtx({ hasUI: true });
		const invocation = handler("mid go", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_RUNTIME_LOADING, "info");
		release(await import("./command-run.js"));
		await Promise.all([warming, invocation]);
		expect(importer).toHaveBeenCalledTimes(1);
		expect(runWorkflow).toHaveBeenCalledTimes(1);
	});

	it("a failed prewarm() clears the memo — the next /wf retries the import", async () => {
		const importer = vi
			.fn<() => Promise<typeof import("./command-run.js")>>()
			.mockRejectedValueOnce(new Error("prewarm boom"))
			.mockImplementation(() => import("./command-run.js"));
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi, importer);
		await expect(handler.prewarm()).rejects.toThrow("prewarm boom");
		const ctx = createMockCommandCtx({ hasUI: true });
		await handler("mid go", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(MSG_RUNTIME_LOADING, "info");
		expect(importer).toHaveBeenCalledTimes(2);
		expect(runWorkflow).toHaveBeenCalledTimes(1);
	});

	it("prewarm() flushes lazy built-in providers ahead of the first /wf", async () => {
		const provider = vi.fn();
		registerBuiltInsProvider(provider);
		const { pi } = createMockPi();
		const handler = makeWfHandler(pi);
		await handler.prewarm();
		expect(provider).toHaveBeenCalledTimes(1);
	});

	it("registerWorkflowCommand pre-warms after PREWARM_DELAY_MS — first /wf shows no toast", async () => {
		vi.useFakeTimers();
		try {
			const { pi, captured } = createMockPi();
			registerWorkflowCommand(pi);
			await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
			const ctx = createMockCommandCtx({ hasUI: true });
			await captured.commands.get("wf")?.handler("mid go", ctx);
			expect(ctx.ui.notify).not.toHaveBeenCalledWith(MSG_RUNTIME_LOADING, "info");
			expect(runWorkflow).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// Issue surfacing — load + validation errors
// ---------------------------------------------------------------------------

describe("/wf — issue surfacing", () => {
	it("surfaces validation warnings as 'warning' notifies", async () => {
		vi.mocked(loadWorkflows).mockResolvedValueOnce({
			workflows: [tinyWorkflow],
			default: "tiny",
			workflowSources: new Map([["tiny", "built-in"]]),
			layers: ["built-in"],
			issues: [
				{
					kind: "validation",
					workflow: "tiny",
					stage: "research",
					severity: "warning",
					code: "stage-unreachable",
					params: { start: "research" },
					message: "orphan check",
					layer: "built-in",
				},
			],
			skillAliases: {},
			skillContracts: new Map(),
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("tiny Add feature", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("orphan check"), "warning");
	});

	it("aborts on load errors — runWorkflow is not invoked", async () => {
		vi.mocked(loadWorkflows).mockResolvedValueOnce({
			workflows: [tinyWorkflow],
			default: "tiny",
			workflowSources: new Map([["tiny", "built-in"]]),
			layers: ["built-in"],
			issues: [{ kind: "load", layer: "project", path: "rpiv.config.ts", severity: "error", message: "broke" }],
			skillAliases: {},
			skillContracts: new Map(),
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("tiny Add feature", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("config error"), "error");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Empty registry — standalone rpiv-workflow install (no rpiv-pi, no overlays).
// The loader used to return `default: "mid"` even with zero workflows; the
// dispatch then either silently went into a not-found notify or, worse,
// looked up "mid" in an empty map. Now: `default: undefined` and the command
// emits an explicit "no workflows registered" notify.
// ---------------------------------------------------------------------------

describe("/wf — empty registry", () => {
	it("emits MSG_NO_WORKFLOWS_REGISTERED when user provides input but no workflows are loaded", async () => {
		vi.mocked(loadWorkflows).mockResolvedValueOnce({
			workflows: [],
			default: undefined,
			workflowSources: new Map(),
			layers: [],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("Add dark mode", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no workflows registered"), "error");
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("no-args still shows the (empty) workflow listing instead of erroring", async () => {
		vi.mocked(loadWorkflows).mockResolvedValueOnce({
			workflows: [],
			default: undefined,
			workflowSources: new Map(),
			layers: [],
			issues: [],
			skillAliases: {},
			skillContracts: new Map(),
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "info");
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("parseArgs — empty registry", () => {
	it('returns workflow="" when no default is set and the first token doesn\'t match a workflow', () => {
		const empty = { workflowNames: new Set<string>(), default: undefined };
		expect(parseArgs("Add feature", empty)).toEqual({ kind: "run", workflow: "", input: "Add feature" });
		expect(parseArgs("", empty)).toEqual({ kind: "run", workflow: "", input: "" });
	});
});

// ---------------------------------------------------------------------------
// /wf @<ref> — resume dispatch
// ---------------------------------------------------------------------------

const RESUME_RUN_ID = "2026-06-03_07-30-00-ab12";

describe("/wf @<run-id> — guard: empty run-id", () => {
	it("notifies usage message and does not call resumeWorkflowByRunId", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("@", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("usage"), "error");
		expect(resumeWorkflowByRunId).not.toHaveBeenCalled();
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf @<run-id> — delegates to resumeWorkflowByRunId", () => {
	it("strips the @ sigil and forwards the run-id + host", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler(`@${RESUME_RUN_ID}`, ctx);
		expect(resumeWorkflowByRunId).toHaveBeenCalledTimes(1);
		const [, runId, opts] = vi.mocked(resumeWorkflowByRunId).mock.calls[0]!;
		expect(runId).toBe(RESUME_RUN_ID);
		expect(opts?.host).toBe(pi);
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});

describe("/wf @<run-id> — notify discriminator (runId presence)", () => {
	it("notifies a no-JSONL refusal (no runId on the envelope) exactly once", async () => {
		vi.mocked(resumeWorkflowByRunId).mockResolvedValueOnce({
			stagesCompleted: 0,
			success: false,
			error: 'rpiv: no run found for "gone"',
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler("@gone", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no run found"), "error");
	});

	it("does NOT re-notify an in-run failure (envelope carries a runId — machinery already notified)", async () => {
		vi.mocked(resumeWorkflowByRunId).mockResolvedValueOnce({
			runId: RESUME_RUN_ID,
			stagesCompleted: 1,
			success: false,
			error: "stage build failed",
		});
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler(`@${RESUME_RUN_ID}`, ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("stage build failed"), "error");
	});

	it("does not notify on success", async () => {
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler(`@${RESUME_RUN_ID}`, ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.anything(), "error");
	});
});

describe("/wf @<run-id> — hard throw", () => {
	it("catches a thrown resumeWorkflowByRunId and notifies the generic failure", async () => {
		vi.mocked(resumeWorkflowByRunId).mockRejectedValueOnce(new Error("boom"));
		const { pi, captured } = createMockPi();
		registerWorkflowCommand(pi);
		const ctx = createMockCommandCtx({ hasUI: true });
		await captured.commands.get("wf")?.handler(`@${RESUME_RUN_ID}`, ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("boom"), "error");
	});
});
