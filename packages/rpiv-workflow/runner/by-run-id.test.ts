import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowHostContext } from "../host.js";
import type { WorkflowHeader } from "../state/state.js";

// Mock the loader + state reads + core runner so the convenience layer is tested
// in isolation (no jiti, no filesystem, no Pi session runtime).
vi.mock("../load/index.js", () => ({
	loadWorkflows: vi.fn(),
	findWorkflow: vi.fn(),
}));
vi.mock("../state/index.js", () => ({
	resolveRun: vi.fn(),
}));
vi.mock("./runner.js", () => ({
	resumeWorkflow: vi.fn(),
}));

import { findWorkflow, loadWorkflows } from "../load/index.js";
import { resolveRun } from "../state/index.js";
import { resumeWorkflowByRunId } from "./by-run-id.js";
import { resumeWorkflow } from "./runner.js";

// Type-only context — resumeWorkflowByRunId only reads ctx.cwd and forwards ctx.
const ctx = { cwd: "/repo" } as unknown as WorkflowHostContext;

const RUN_ID = "2026-06-03_07-30-00-ab12";
const header: WorkflowHeader = {
	runId: RUN_ID,
	workflow: "research",
	input: "add dark mode",
	ts: "2026-06-03T07:30:00Z",
};

const loaded = (over: Partial<Awaited<ReturnType<typeof loadWorkflows>>> = {}) =>
	({ workflows: [{ name: "research" }], issues: [], ...over }) as unknown as Awaited<ReturnType<typeof loadWorkflows>>;

beforeEach(() => {
	vi.mocked(resolveRun).mockReset();
	vi.mocked(loadWorkflows).mockReset();
	vi.mocked(findWorkflow).mockReset();
	vi.mocked(resumeWorkflow).mockReset();
});

describe("resumeWorkflowByRunId", () => {
	it("returns a not-found envelope when the run-id doesn't resolve; never loads or resumes", async () => {
		vi.mocked(resolveRun).mockReturnValue(undefined);

		const result = await resumeWorkflowByRunId(ctx, "bogus-id");

		expect(result.success).toBe(false);
		expect(result.stagesCompleted).toBe(0);
		expect(result.error).toContain('no run found for "bogus-id"');
		// No runId on the envelope — command's discriminator notifies this once.
		expect(result.runId).toBeUndefined();
		expect(resolveRun).toHaveBeenCalledWith("/repo", "bogus-id");
		expect(loadWorkflows).not.toHaveBeenCalled();
		expect(resumeWorkflow).not.toHaveBeenCalled();
	});

	it("refuses on error-severity load issues; never resolves the workflow or resumes", async () => {
		vi.mocked(resolveRun).mockReturnValue(header);
		vi.mocked(loadWorkflows).mockResolvedValue(
			loaded({
				issues: [
					{ severity: "error", message: "bad overlay" },
					{ severity: "warning", message: "ignore me" },
				],
			} as unknown as Awaited<ReturnType<typeof loadWorkflows>>),
		);

		const result = await resumeWorkflowByRunId(ctx, RUN_ID);

		expect(result.success).toBe(false);
		expect(result.error).toContain("config error");
		expect(result.runId).toBeUndefined();
		expect(findWorkflow).not.toHaveBeenCalled();
		expect(resumeWorkflow).not.toHaveBeenCalled();
	});

	it("returns a workflow-gone envelope when the run's workflow is no longer loaded", async () => {
		vi.mocked(resolveRun).mockReturnValue({ ...header, workflow: "deleted-wf" });
		vi.mocked(loadWorkflows).mockResolvedValue(loaded());
		vi.mocked(findWorkflow).mockReturnValue(undefined);

		const result = await resumeWorkflowByRunId(ctx, RUN_ID);

		expect(result.success).toBe(false);
		expect(result.error).toContain('"deleted-wf"');
		expect(result.error).toContain("no longer registered");
		expect(result.runId).toBeUndefined();
		expect(resumeWorkflow).not.toHaveBeenCalled();
	});

	it("delegates to resumeWorkflow with the resolved workflow, header, run-id as ref, and opts", async () => {
		const wf = { name: "research" };
		vi.mocked(resolveRun).mockReturnValue(header);
		// Warnings do not gate.
		vi.mocked(loadWorkflows).mockResolvedValue(
			loaded({ issues: [{ severity: "warning", message: "non-fatal" }] } as unknown as Awaited<
				ReturnType<typeof loadWorkflows>
			>),
		);
		vi.mocked(findWorkflow).mockReturnValue(wf as unknown as ReturnType<typeof findWorkflow>);
		vi.mocked(resumeWorkflow).mockResolvedValue({ runId: RUN_ID, stagesCompleted: 2, success: true });

		const host = {
			getCommands: vi.fn(),
		} as unknown as NonNullable<Parameters<typeof resumeWorkflowByRunId>[2]>["host"];
		const result = await resumeWorkflowByRunId(ctx, RUN_ID, { host });

		// ref is the run-id; opts flow through alongside workflow + header.
		expect(resumeWorkflow).toHaveBeenCalledWith(ctx, { workflow: wf, header, ref: RUN_ID, host });
		expect(result).toEqual({ runId: RUN_ID, stagesCompleted: 2, success: true });
	});
});
