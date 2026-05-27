/**
 * Tests for `finalizeOutput` — the single source of output metadata
 * authorship in the workflow runtime. Every outcome (collector +
 * optional parser) flows through this function on its way to disk + the
 * next stage; the invariants this file pins are: ctx wins over payload
 * for meta fields, the `artifacts` list passes through unchanged
 * (including the empty-list case), and every meta field is stamped
 * from ctx.
 */

import { describe, expect, it } from "vitest";
import { fs } from "./handle.js";
import { finalizeOutput } from "./output.js";

const baseCtx = {
	stage: "research",
	skill: "research",
	stageNumber: 3,
	ts: "2026-05-24T08:00:00Z",
	runId: "2026-05-24_08-00-00-abcd",
};

describe("finalizeOutput", () => {
	it("stamps every meta field from ctx (skill, stageNumber, ts, runId)", () => {
		const m = finalizeOutput(
			{
				kind: "artifact-md",
				artifacts: [{ handle: fs(".rpiv/artifacts/research/r.md"), role: "primary" }],
				data: { foo: 1 },
			},
			baseCtx,
		);
		expect(m.meta).toEqual({
			stage: "research",
			skill: "research",
			stageNumber: 3,
			ts: "2026-05-24T08:00:00Z",
			runId: "2026-05-24_08-00-00-abcd",
		});
	});

	it("forwards `kind`, `artifacts`, and `data` from the input unchanged", () => {
		const artifacts = [{ handle: fs(".rpiv/artifacts/prior/x.md") }];
		const m = finalizeOutput({ kind: "git-commit", artifacts, data: { sha: "deadbeef" } }, baseCtx);
		expect(m.kind).toBe("git-commit");
		expect(m.data).toEqual({ sha: "deadbeef" });
		expect(m.artifacts).toBe(artifacts);
	});

	it("accepts an empty `artifacts` list (side-effect / passthrough stages)", () => {
		const m = finalizeOutput({ kind: "side-effect", artifacts: [], data: {} }, baseCtx);
		expect(m.artifacts).toEqual([]);
		expect(m.kind).toBe("side-effect");
	});

	it("ctx.skill wins even if data carries an unexpected `skill`-ish field", () => {
		// Collectors/parsers must NOT be able to spoof meta.skill — the runner sets it
		// from the resolved stage. Smuggling a `skill` key inside `data` must
		// not affect meta.
		const m = finalizeOutput({ kind: "artifact-md", artifacts: [], data: { skill: "evil-skill", foo: 1 } }, baseCtx);
		expect(m.meta.skill).toBe("research");
		// The data-side `skill` field is preserved — it's just data; the consumer
		// can read it but it never reaches meta.
		expect((m.data as Record<string, unknown>).skill).toBe("evil-skill");
	});

	it("preserves payload data structurally — no defensive clone, no field stripping", () => {
		const data = { nested: { deep: [1, 2, 3] } };
		const m = finalizeOutput({ kind: "artifact-md", artifacts: [], data }, baseCtx);
		// Same object reference — finalizeOutput does NOT clone.
		// Downstream callers that need immutability MUST clone themselves;
		// this keeps the hot path cheap.
		expect(m.data).toBe(data);
	});
});
