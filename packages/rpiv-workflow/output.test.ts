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
import { FAILED_OUTPUT_KIND, failedOutput, finalizeOutput, isFailedOutput, outputMeta } from "./output.js";

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

describe("failedOutput / isFailedOutput (collect-all sentinel)", () => {
	it("builds a real Output with the failed kind, NO artifacts, and the reason in data", () => {
		const o = failedOutput(baseCtx, "validation exhausted");
		expect(o.kind).toBe(FAILED_OUTPUT_KIND);
		expect(o.artifacts).toEqual([]); // no artifacts → fanin readers skip it naturally
		expect(o.data).toEqual({ reason: "validation exhausted" });
		expect(o.meta).toEqual(baseCtx); // stamps meta like any other Output
	});

	it("isFailedOutput discriminates the sentinel from a normal Output", () => {
		expect(isFailedOutput(failedOutput(baseCtx, "boom"))).toBe(true);
		const normal = finalizeOutput({ kind: "artifacts", artifacts: [{ handle: fs("a.md") }], data: {} }, baseCtx);
		expect(isFailedOutput(normal)).toBe(false);
	});
});

describe("outputMeta (the single OutputMeta construction home)", () => {
	it("omits the `skill` key entirely when `skill` is absent (script-row contract)", () => {
		// Script-stage rows carry NO skill field — the omission must be a real key
		// omission, not `{ skill: undefined }`, because JSON.stringify drops
		// `undefined` but the in-memory shape must not advertise a skill slot.
		const m = outputMeta({ stage: "impl", stageNumber: 1, ts: "t1", runId: "r1" });
		expect(m).toStrictEqual({ stage: "impl", stageNumber: 1, ts: "t1", runId: "r1" });
		expect("skill" in m).toBe(false); // NOT `{ skill: undefined }`
	});

	it("includes the `skill` key when `skill` is supplied", () => {
		const m = outputMeta({ stage: "research", skill: "research", stageNumber: 3, ts: "t3", runId: "r3" });
		expect(m).toStrictEqual({ stage: "research", skill: "research", stageNumber: 3, ts: "t3", runId: "r3" });
	});

	it("reproduces `ts` verbatim — no `nowIso()` is injected inside the assembler", () => {
		// The contract that lets the resume fold replay a persisted `row.ts`:
		// outputMeta must NOT mint its own timestamp. A fixed ts round-trips exactly.
		const fixedTs = "2026-06-24T23:05:06-0400";
		expect(outputMeta({ stage: "x", stageNumber: 9, ts: fixedTs, runId: "rx" }).ts).toBe(fixedTs);
	});

	it("live-vs-resume parity: identical field values produce structurally equal meta", () => {
		// A representative persisted WorkflowStage row's fields, fed through
		// outputMeta the way the resume fold does (`ts: row.ts`) and the way the
		// live path does (minting the same ts) — byte-identical. Once both route
		// through outputMeta, a structural divergence is unrepresentable.
		const row = { stage: "impl (phase-2)", skill: "impl", stageNumber: 2, ts: "t2", runId: "run-id" };
		const resumeMeta = outputMeta({ ...row, ts: row.ts });
		const liveMeta = outputMeta({ ...row, ts: row.ts });
		expect(resumeMeta).toStrictEqual(liveMeta);
	});
});
