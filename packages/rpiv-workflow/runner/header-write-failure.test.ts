/**
 * A failed run-header append refuses the run start. A lost
 * header makes the run unlistable and unresumable while its stage rows land,
 * and the name claim has already burned the name — so `runWorkflow` must
 * reject BEFORE any stage executes and roll the claim back.
 *
 * Lives in its own file because `vi.mock` is module-scoped: every test here
 * runs with `writeHeader` forced to fail.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockSessionChain } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "../api.js";
import { readNamesIndex } from "../state/index.js";
import { runWorkflow } from "./runner.js";

vi.mock("../state/writes.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../state/writes.js")>();
	return { ...actual, writeHeader: vi.fn(() => false) };
});

const tinyWorkflow: Workflow = {
	name: "tiny",
	start: "research",
	stages: { research: { kind: "produces", sessionPolicy: "fresh" } },
	edges: { research: "stop" },
};

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "rpiv-workflow-header-fail-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("runWorkflow — header write failure", () => {
	it("refuses the run start with no runId and zero stages executed", async () => {
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, { workflow: tinyWorkflow, input: "x" });

		expect(result.success).toBe(false);
		expect(result.runId).toBeUndefined(); // pre-flight rejection — no JSONL exists
		expect(result.stagesCompleted).toBe(0);
		expect(result.error).toContain("could not write the run header");
		expect(chain.remaining()).toBe(0); // no session was ever opened
	});

	it("rolls back the name claim so the index never points at a run that doesn't exist", async () => {
		const chain = createMockSessionChain({ cwd: tmpDir, steps: [] });
		const result = await runWorkflow(chain.ctx, { workflow: tinyWorkflow, input: "x", name: "auth" });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/could not write the run header/);
		// claimName persisted the entry before writeHeader ran; the refusal
		// must have released it.
		expect(readNamesIndex(tmpDir) ?? {}).toEqual({});
	});
});
