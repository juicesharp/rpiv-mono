import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowHostContext } from "../host.js";

// Mock the loader + core runner so the convenience layer is tested in isolation
// (no jiti, no filesystem, no Pi session runtime).
vi.mock("../load/index.js", () => ({
	loadWorkflows: vi.fn(),
	findWorkflow: vi.fn(),
}));
vi.mock("./runner.js", () => ({
	runWorkflow: vi.fn(),
}));

import { findWorkflow, loadWorkflows } from "../load/index.js";
import { runWorkflowByName } from "./by-name.js";
import { runWorkflow } from "./runner.js";

// Type-only context — runWorkflowByName only reads ctx.cwd and forwards ctx.
const ctx = { cwd: "/repo" } as unknown as WorkflowHostContext;

beforeEach(() => {
	vi.mocked(loadWorkflows).mockReset();
	vi.mocked(findWorkflow).mockReset();
	vi.mocked(runWorkflow).mockReset();
});

describe("runWorkflowByName", () => {
	it("refuses when the overlay has error-severity load issues, listing only errors", async () => {
		vi.mocked(loadWorkflows).mockResolvedValue({
			workflows: [],
			issues: [
				{ severity: "error", message: "bad overlay A" },
				{ severity: "warning", message: "ignore me" },
				{ severity: "error", message: "bad overlay B" },
			],
		} as unknown as Awaited<ReturnType<typeof loadWorkflows>>);

		const result = await runWorkflowByName(ctx, "research", "input");

		expect(result.success).toBe(false);
		expect(result.stagesCompleted).toBe(0);
		expect(result.error).toContain("2 load error(s)");
		expect(result.error).toContain("bad overlay A");
		expect(result.error).toContain("bad overlay B");
		expect(result.error).not.toContain("ignore me");
		// Never resolves or dispatches off a partial set.
		expect(findWorkflow).not.toHaveBeenCalled();
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("returns a not-found envelope listing available workflow names", async () => {
		vi.mocked(loadWorkflows).mockResolvedValue({
			workflows: [{ name: "research" }, { name: "ship" }],
			issues: [],
		} as unknown as Awaited<ReturnType<typeof loadWorkflows>>);
		vi.mocked(findWorkflow).mockReturnValue(undefined);

		const result = await runWorkflowByName(ctx, "nope", "input");

		expect(result.success).toBe(false);
		expect(result.stagesCompleted).toBe(0);
		expect(result.error).toContain('"nope" not found');
		expect(result.error).toContain("research, ship");
		expect(runWorkflow).not.toHaveBeenCalled();
	});

	it("reports 'none' when no workflows are available", async () => {
		vi.mocked(loadWorkflows).mockResolvedValue({
			workflows: [],
			issues: [],
		} as unknown as Awaited<ReturnType<typeof loadWorkflows>>);
		vi.mocked(findWorkflow).mockReturnValue(undefined);

		const result = await runWorkflowByName(ctx, "nope", "input");

		expect(result.error).toContain("available: none");
	});

	it("delegates to runWorkflow with the resolved workflow, input, and opts", async () => {
		const wf = { name: "research" };
		vi.mocked(loadWorkflows).mockResolvedValue({
			workflows: [wf],
			issues: [{ severity: "warning", message: "non-fatal" }],
		} as unknown as Awaited<ReturnType<typeof loadWorkflows>>);
		vi.mocked(findWorkflow).mockReturnValue(wf as unknown as ReturnType<typeof findWorkflow>);
		vi.mocked(runWorkflow).mockResolvedValue({ stagesCompleted: 3, success: true });

		const host = { withSession: vi.fn() } as unknown as NonNullable<Parameters<typeof runWorkflowByName>[3]>["host"];
		const result = await runWorkflowByName(ctx, "research", "add dark mode", { host });

		// Warnings do not gate; opts flow through alongside workflow + input.
		expect(runWorkflow).toHaveBeenCalledWith(ctx, { workflow: wf, input: "add dark mode", host });
		expect(result).toEqual({ stagesCompleted: 3, success: true });
	});
});
