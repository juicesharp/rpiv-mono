/**
 * goal-baseline.test.ts — goal-channel verbatim-brief threading and the
 * run-start baseline dispatch on the built-in graph, moved verbatim from
 * built-in-workflows.test.ts.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunView } from "@juicesharp/rpiv-workflow";
import { fs as fsHandle } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkflow } from "../workflow-test-harness.js";

describe("build goal channel (verbatim brief threading)", () => {
	const build = () => findWorkflow("build");
	const out = (rel: string) => ({ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} });
	const promptFnOf = (stage: string) => {
		const prompt = build().stages[stage]?.prompt;
		if (typeof prompt !== "function") throw new Error(`build ${stage} stage has no prompt fn`);
		return prompt;
	};
	const gateUnits = (stage: string, named: Record<string, unknown>) => {
		const loop = build().stages[stage]?.loop;
		if (loop?.kind !== "fanout") throw new Error(`build ${stage} stage has no fanout loop`);
		return loop.units({ cwd: "/repo", artifact: undefined, state: { named } as unknown as RunView });
	};

	describe("goal capture stage", () => {
		let tmpDir: string;
		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "rpiv-build-goal-"));
		});
		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("is the start stage and writes the brief byte-for-byte", () => {
			expect(build().start).toBe("goal");
			const stage = build().stages.goal;
			if (!stage?.run) throw new Error("build goal stage has no run function");
			const run = stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
				artifacts: readonly { handle: { kind: string; path: string }; role?: string }[];
			};
			const brief = "add dark mode\n\nconstraints:\n- don't touch auth\n- keep it minimal";
			const output = run({
				cwd: tmpDir,
				input: undefined,
				state: { originalInput: brief, named: {} } as unknown as RunView,
			});
			const handle = output.artifacts[0]?.handle;
			expect(handle?.kind).toBe("fs");
			expect(handle?.path).toMatch(/^\.rpiv\/artifacts\/goal\/goal-.+\.md$/);
			expect(readFileSync(join(tmpDir, handle?.path ?? ""), "utf-8")).toBe(brief);
			// The run-start baseline rides SECOND on the same output, under its role —
			// per-run timestamped (no fixed rendezvous path), empty here (non-repo cwd).
			const baseline = output.artifacts[1];
			expect(baseline?.role).toBe("baseline");
			expect(baseline?.handle.path).toMatch(/^\.rpiv\/artifacts\/goal\/baseline-.+\.json$/);
			const parsed = JSON.parse(readFileSync(join(tmpDir, baseline?.handle.path ?? ""), "utf-8"));
			expect(parsed).toEqual({ paths: [] });
		});

		it("halts a garbage brief (< 12 non-whitespace chars) with the preflight error before any fs side effect", () => {
			const stage = build().stages.goal;
			if (!stage?.run) throw new Error("build goal stage has no run function");
			const run = stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
				artifacts: readonly { handle: { kind: string; path: string }; role?: string }[];
			};
			// 'do something' = 11 non-whitespace chars — exactly one below the threshold.
			expect(() =>
				run({
					cwd: tmpDir,
					input: undefined,
					state: { originalInput: "do something", named: {} } as unknown as RunView,
				}),
			).toThrow(/re-invoke with a fuller brief/);
			// The guard fires before the stamp — nothing was written (no goal dir,
			// no goal file, no baseline).
			expect(existsSync(join(tmpDir, ".rpiv/artifacts/goal"))).toBe(false);
		});

		it("passes a short-but-real brief through to the goal artifact and baseline", () => {
			const stage = build().stages.goal;
			if (!stage?.run) throw new Error("build goal stage has no run function");
			const run = stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
				artifacts: readonly { handle: { kind: string; path: string }; role?: string }[];
			};
			// 'fix the flaky lane-dock resize test' = 30 non-whitespace chars.
			const brief = "fix the flaky lane-dock resize test";
			const output = run({
				cwd: tmpDir,
				input: undefined,
				state: { originalInput: brief, named: {} } as unknown as RunView,
			});
			const handle = output.artifacts[0]?.handle;
			expect(handle?.kind).toBe("fs");
			expect(handle?.path).toMatch(/^\.rpiv\/artifacts\/goal\/goal-.+\.md$/);
			expect(readFileSync(join(tmpDir, handle?.path ?? ""), "utf-8")).toBe(brief);
			const baseline = output.artifacts[1];
			expect(baseline?.role).toBe("baseline");
			expect(baseline?.handle.path).toMatch(/^\.rpiv\/artifacts\/goal\/baseline-.+\.json$/);
			const parsed = JSON.parse(readFileSync(join(tmpDir, baseline?.handle.path ?? ""), "utf-8"));
			expect(parsed).toEqual({ paths: [] });
		});
	});

	it("vet's goal capture passes a bare review-scope token — the garbage floor is build/ship-only", () => {
		// `/wf vet staged` is a documented invocation whose whole brief is 6
		// non-whitespace characters. Vet captures via captureReviewScope (no
		// floor); the strict captureGoal would have halted it.
		const stage = findWorkflow("vet").stages.goal;
		if (!stage?.run) throw new Error("vet goal stage has no run function");
		const run = stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			artifacts: readonly { handle: { kind: string; path: string }; role?: string }[];
		};
		const tmp = mkdtempSync(join(tmpdir(), "rpiv-vet-goal-"));
		try {
			const output = run({
				cwd: tmp,
				input: undefined,
				state: { originalInput: "staged", named: {} } as unknown as RunView,
			});
			const handle = output.artifacts[0]?.handle;
			expect(handle?.kind).toBe("fs");
			expect(readFileSync(join(tmp, handle?.path ?? ""), "utf-8")).toBe("staged");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("research dispatches the raw brief via prompt (goal displaced it from the start slot)", () => {
		const dispatch = promptFnOf("research")({
			cwd: "/repo",
			input: undefined,
			state: { originalInput: "add dark mode", named: {} } as unknown as RunView,
		});
		expect(dispatch).toBe("/skill:research add dark mode");
	});

	it("threads --goal into completeness and correctness only, leaving --context untouched", async () => {
		const units = await gateUnits("plan-grade", {
			plans: [out(".rpiv/artifacts/plans/p.md")],
			research: [out(".rpiv/artifacts/research/r.md")],
			goal: [out(".rpiv/artifacts/goal/goal.md")],
			"plan-cite-check": [out(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
		});
		const byLabel = new Map(units.map((u) => [u.label, u.prompt]));
		expect(byLabel.get("completeness")).toContain("--goal .rpiv/artifacts/goal/goal.md");
		expect(byLabel.get("correctness")).toContain("--goal .rpiv/artifacts/goal/goal.md");
		for (const d of ["actionability", "pattern-following", "architecture-fit"]) {
			expect(byLabel.get(d)).not.toContain("--goal");
		}
		expect(byLabel.get("architecture-fit")).toContain("--context .rpiv/artifacts/research/r.md");
	});

	it("omits --goal when the channel is empty, and the slice gate stays goal-blind", async () => {
		const bare = await gateUnits("plan-grade", {
			plans: [out(".rpiv/artifacts/plans/p.md")],
			research: [out(".rpiv/artifacts/research/r.md")],
			"plan-cite-check": [out(".rpiv/artifacts/verdicts/plan-cite-check__p.json")],
		});
		expect(bare.every((u) => !u.prompt.includes("--goal"))).toBe(true);
		const slice = await gateUnits("slice-grade", {
			slices: [out(".rpiv/artifacts/slices/s.md")],
			goal: [out(".rpiv/artifacts/goal/goal.md")],
		});
		expect(slice.every((u) => !u.prompt.includes("--goal"))).toBe(true);
	});

	it("both grade gates declare the goal read", () => {
		expect(build().stages["plan-grade"]?.reads).toContain("goal");
		expect(build().stages["code-grade"]?.reads).toContain("goal");
	});

	it("validate dispatches the LATEST plan from the named channel plus --goal", () => {
		// Named-channel sourcing is load-bearing: after the code gate the
		// rolling primary is the last verdict JSON, not the plan.
		const dispatch = promptFnOf("validate")({
			cwd: "/repo",
			input: undefined,
			state: {
				named: {
					plans: [out(".rpiv/artifacts/plans/old.md"), out(".rpiv/artifacts/plans/p.md")],
					goal: [out(".rpiv/artifacts/goal/goal.md")],
				},
			} as unknown as RunView,
		});
		expect(dispatch).toBe("/skill:validate .rpiv/artifacts/plans/p.md --goal .rpiv/artifacts/goal/goal.md");
	});

	it("validate degrades to the bare plan path without a goal artifact", () => {
		const dispatch = promptFnOf("validate")({
			cwd: "/repo",
			input: undefined,
			state: { named: { plans: [out(".rpiv/artifacts/plans/p.md")] } } as unknown as RunView,
		});
		expect(dispatch).toBe("/skill:validate .rpiv/artifacts/plans/p.md");
	});
});

// ---------------------------------------------------------------------------
// acceptance channel — the goal-derived executable standard of completion,
// frozen between research and planning so it cannot inherit the plan's scope.
// Threading: the completeness grade unit (--acceptance, that dimension only)
// and validate's prompt (which EXECUTES the items' evidence commands). The
// generative stages stay acceptance-blind, the bounded-context doctrine that
// keeps `goal` out of them applied to its derived standard too.
// ---------------------------------------------------------------------------

describe("build validate + commit dispatch thread the run-start baseline", () => {
	const promptOf = (stage: string) => {
		const prompt = findWorkflow("build").stages[stage]?.prompt;
		if (typeof prompt !== "function") throw new Error(`build ${stage} stage has no prompt fn`);
		return prompt;
	};
	const out = (artifacts: unknown[]) => ({ artifacts, data: undefined, kind: "", meta: {} });
	const goalWithBaseline = out([
		{ handle: fsHandle(".rpiv/artifacts/goal/goal-t.md") },
		{ handle: fsHandle(".rpiv/artifacts/goal/baseline-t.json"), role: "baseline" },
	]);
	const goalAlone = out([{ handle: fsHandle(".rpiv/artifacts/goal/goal-t.md") }]);
	const plans = [out([{ handle: fsHandle(".rpiv/artifacts/plans/p.md") }])];

	it("validate appends --baseline with the goal channel's recorded snapshot path", async () => {
		const dispatch = await promptOf("validate")({
			cwd: "/repo",
			input: undefined,
			state: { named: { plans, goal: [goalWithBaseline] } } as unknown as RunView,
		});
		// Exact match doubles as the --scope OMISSION proof: no scope channel in
		// this state, so no --scope flag may appear.
		expect(dispatch).toBe(
			"/skill:validate .rpiv/artifacts/plans/p.md --goal .rpiv/artifacts/goal/goal-t.md --baseline .rpiv/artifacts/goal/baseline-t.json",
		);
	});

	it("validate appends --scope with the scope floor's recorded verdict path", async () => {
		// The demote-and-adjudicate tier rests on this thread: a tracked-excess
		// verdict reaches validate ONLY via --scope, so the flag must ride the
		// dispatch whenever the floor has published.
		const scopeVerdict = out([{ handle: fsHandle(".rpiv/artifacts/verdicts/implement-scope-check__p.json") }]);
		const dispatch = await promptOf("validate")({
			cwd: "/repo",
			input: undefined,
			state: {
				named: { plans, goal: [goalWithBaseline], "implement-scope-check": [scopeVerdict] },
			} as unknown as RunView,
		});
		expect(dispatch).toBe(
			"/skill:validate .rpiv/artifacts/plans/p.md --goal .rpiv/artifacts/goal/goal-t.md --baseline .rpiv/artifacts/goal/baseline-t.json --scope .rpiv/artifacts/verdicts/implement-scope-check__p.json",
		);
	});

	it("validate omits --baseline when the goal output carries no baseline artifact", async () => {
		const dispatch = await promptOf("validate")({
			cwd: "/repo",
			input: undefined,
			state: { named: { plans, goal: [goalAlone] } } as unknown as RunView,
		});
		expect(dispatch).toBe("/skill:validate .rpiv/artifacts/plans/p.md --goal .rpiv/artifacts/goal/goal-t.md");
	});

	it("the --goal flag still points at the goal md (baseline rides SECOND on the channel)", async () => {
		const dispatch = await promptOf("validate")({
			cwd: "/repo",
			input: undefined,
			state: { named: { plans, goal: [goalWithBaseline] } } as unknown as RunView,
		});
		expect(dispatch).toContain("--goal .rpiv/artifacts/goal/goal-t.md");
		expect(dispatch).not.toContain("--goal .rpiv/artifacts/goal/baseline-t.json");
	});

	it("commit dispatches /skill:commit --baseline with the recorded snapshot path", async () => {
		const dispatch = await promptOf("commit")({
			cwd: "/repo",
			input: undefined,
			state: { named: { goal: [goalWithBaseline] } } as unknown as RunView,
		});
		expect(dispatch).toBe("/skill:commit --baseline .rpiv/artifacts/goal/baseline-t.json");
	});

	it("commit dispatches bare /skill:commit when no baseline was captured", async () => {
		const dispatch = await promptOf("commit")({
			cwd: "/repo",
			input: undefined,
			state: { named: { goal: [goalAlone] } } as unknown as RunView,
		});
		expect(dispatch).toBe("/skill:commit");
	});
});

// ---------------------------------------------------------------------------
// build implement-scope-check (lane-level scope floor) — the deterministic
// structural backstop beneath the quality gates. Exercises scopeExcess through
// the implement-scope-check stage's published verdict (no direct helper import:
// the file exports only builtInWorkflows, as the suite does at line 42).
// ---------------------------------------------------------------------------
