/**
 * Tests for `finalizeManifest` — the single source of manifest metadata
 * authorship in the workflow runtime. Every outcome result flows through
 * this function on its way to disk + the next stage; the invariants this
 * file pins are: ctx wins over payload for meta fields, missing
 * artifact_path passes through as `undefined`, and every meta field is
 * stamped from ctx.
 *
 * Closes G1 from the 2026-05-24 review.
 */

import { describe, expect, it } from "vitest";
import { type ExtractPayload, finalizeManifest } from "./manifest.js";

const baseCtx = {
	skill: "research",
	stageNumber: 3,
	ts: "2026-05-24T08:00:00Z",
	runId: "2026-05-24_08-00-00-abcd",
};

describe("finalizeManifest", () => {
	it("stamps every meta field from ctx (skill, stageNumber, ts, runId)", () => {
		const payload: ExtractPayload = {
			kind: "artifact-md",
			artifact_path: ".rpiv/artifacts/research/r.md",
			data: { foo: 1 },
		};
		const m = finalizeManifest(payload, baseCtx);
		expect(m.meta).toEqual({
			skill: "research",
			stageNumber: 3,
			ts: "2026-05-24T08:00:00Z",
			runId: "2026-05-24_08-00-00-abcd",
		});
	});

	it("forwards `kind`, `data`, and `artifact_path` from the payload unchanged", () => {
		const payload: ExtractPayload<"git-commit", { sha: string }> = {
			kind: "git-commit",
			artifact_path: ".rpiv/artifacts/prior/x.md",
			data: { sha: "deadbeef" },
		};
		const m = finalizeManifest(payload, baseCtx);
		expect(m.kind).toBe("git-commit");
		expect(m.data).toEqual({ sha: "deadbeef" });
		expect(m.artifact_path).toBe(".rpiv/artifacts/prior/x.md");
	});

	it("passes `artifact_path: undefined` through (does not promote payload absence to a default)", () => {
		const payload: ExtractPayload = { kind: "side-effect", data: {} };
		const m = finalizeManifest(payload, baseCtx);
		// `undefined` rather than absent — downstream consumers check
		// `manifest.artifact_path === undefined` to detect a missing path.
		expect("artifact_path" in m).toBe(true);
		expect(m.artifact_path).toBeUndefined();
	});

	it("ctx.skill wins even if payload carries an unexpected `skill`-ish field", () => {
		// Extractors must NOT be able to spoof meta.skill — the runner sets it
		// from the resolved node. Smuggling a `skill` key inside `data` must
		// not affect meta.
		const payload: ExtractPayload = {
			kind: "artifact-md",
			data: { skill: "evil-skill", foo: 1 },
		};
		const m = finalizeManifest(payload, baseCtx);
		expect(m.meta.skill).toBe("research");
		// The payload-side `skill` field is preserved inside data — it's just
		// data, the consumer can read it but it never reaches meta.
		expect((m.data as Record<string, unknown>).skill).toBe("evil-skill");
	});

	it("preserves payload data structurally — no defensive clone, no field stripping", () => {
		const data = { nested: { deep: [1, 2, 3] } };
		const payload: ExtractPayload = { kind: "artifact-md", data };
		const m = finalizeManifest(payload, baseCtx);
		// Same object reference — finalizeManifest does NOT clone.
		// Downstream callers that need immutability MUST clone themselves;
		// this keeps the hot path cheap.
		expect(m.data).toBe(data);
	});
});
