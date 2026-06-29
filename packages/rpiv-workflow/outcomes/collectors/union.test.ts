import { describe, expect, it } from "vitest";
import { fs } from "../../handle.js";
import type { ArtifactCollector } from "../../output-spec.js";
import { unionCollectors } from "./union.js";

const ctxOf = () => ({
	cwd: "/tmp",
	runId: "test",
	stageIndex: 0,
	state: {} as never,
	branch: [],
	branchOffset: undefined,
	snapshot: undefined,
	skill: "test",
});

const okCollector = (paths: string[]): ArtifactCollector => ({
	collect: () => ({ kind: "ok", artifacts: paths.map((p) => ({ handle: fs(p) })) }),
});

const fatalCollector = (msg: string): ArtifactCollector => ({
	collect: () => ({ kind: "fatal", message: msg }),
});

describe("unionCollectors", () => {
	it("throws when constructed with zero collectors", () => {
		expect(() => unionCollectors()).toThrow(/at least one collector/);
	});

	it("concatenates artifacts in collector order", async () => {
		const union = unionCollectors(okCollector(["a.ts", "b.ts"]), okCollector(["c.ts"]));
		const result = await union.collect(ctxOf());
		expect(
			result.kind === "ok" && result.artifacts.map((a) => (a.handle.kind === "fs" ? a.handle.path : "")),
		).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("returns ok+empty when every sub-collector yielded ok+empty", async () => {
		const union = unionCollectors(okCollector([]), okCollector([]));
		const result = await union.collect(ctxOf());
		expect(result.kind === "ok" && result.artifacts).toEqual([]);
	});

	it("returns ok when at least one sub-collector succeeds (even if others fatal)", async () => {
		const union = unionCollectors(fatalCollector("transcript: no match"), okCollector(["b.ts"]));
		const result = await union.collect(ctxOf());
		expect(
			result.kind === "ok" && result.artifacts.map((a) => (a.handle.kind === "fs" ? a.handle.path : "")),
		).toEqual(["b.ts"]);
	});

	it("returns fatal carrying the LAST fatal message when every sub-collector fataled", async () => {
		const union = unionCollectors(fatalCollector("first failure"), fatalCollector("second failure"));
		const result = await union.collect(ctxOf());
		expect(result.kind).toBe("fatal");
		if (result.kind !== "fatal") return;
		expect(result.message).toBe("second failure");
	});

	// ------------------------------------------------------------------------
	// Snapshot fanout — a snapshot-bearing collector inside a union must
	// behave exactly as it would standalone.
	// ------------------------------------------------------------------------

	it("declares NO snapshot hook when no sub-collector snapshots", () => {
		const union = unionCollectors(okCollector(["a.ts"]), okCollector(["b.ts"]));
		expect(union.snapshot).toBeUndefined();
	});

	it("captures every sub-collector's snapshot and threads snapshots[i] into sub-collector i", async () => {
		const seen: unknown[] = [];
		const snapshotting = (tag: string): ArtifactCollector => ({
			snapshot: () => `${tag}-baseline`,
			collect: (ctx) => {
				seen.push(ctx.snapshot);
				return { kind: "ok", artifacts: [{ handle: fs(`${tag}.ts`) }] };
			},
		});
		const snapshotless: ArtifactCollector = {
			collect: (ctx) => {
				seen.push(ctx.snapshot);
				return { kind: "ok", artifacts: [] };
			},
		};

		const union = unionCollectors(snapshotting("diff"), snapshotless, snapshotting("git"));
		expect(union.snapshot).toBeTypeOf("function");

		const captured = await union.snapshot!(ctxOf());
		expect(captured).toEqual(["diff-baseline", undefined, "git-baseline"]);

		const result = await union.collect({ ...ctxOf(), snapshot: captured });
		expect(result.kind).toBe("ok");
		// Each sub-collector saw ITS OWN snapshot, positionally.
		expect(seen).toEqual(["diff-baseline", undefined, "git-baseline"]);
	});

	it("degrades every sub-snapshot to undefined when the whole capture degraded (runner contract)", async () => {
		const seen: unknown[] = [];
		const snapshotting: ArtifactCollector = {
			snapshot: () => "baseline",
			collect: (ctx) => {
				seen.push(ctx.snapshot);
				return { kind: "ok", artifacts: [] };
			},
		};
		const union = unionCollectors(snapshotting);
		// captureStageSnapshot hands undefined when the capture threw.
		const result = await union.collect({ ...ctxOf(), snapshot: undefined });
		expect(result.kind).toBe("ok");
		expect(seen).toEqual([undefined]);
	});
});
