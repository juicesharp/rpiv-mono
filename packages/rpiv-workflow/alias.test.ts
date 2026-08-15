/**
 * Unit tests for the load-time skill-alias transform (`aliasSkills`).
 *
 * The transform is pure and never mutates its input: it returns the original
 * workflow by reference when nothing changed (so the shared built-in registry
 * is never mutated in place) and a new frozen copy when a remap applied.
 */

import { describe, expect, it } from "vitest";
import type { StageDef, Workflow } from "./api.js";
import { aliasSkills, applySkillAliases } from "./load/alias.js";
import type { LayerOutcome, LoadAccumulator } from "./load/merge.js";
import { fanout, iterate } from "./loop-constructors.js";

// Minimal stage builders — `aliasSkills` only reads `run`, `prompt`, `skill`.
const skillStage = (skill?: string): StageDef => ({
	kind: "side-effect",
	sessionPolicy: "fresh",
	...(skill ? { skill } : {}),
});
const runStage = (): StageDef => ({ kind: "side-effect", sessionPolicy: "fresh", run: (async () => {}) as never });
const promptStage = (): StageDef => ({ kind: "side-effect", sessionPolicy: "fresh", prompt: "do the thing" });
const fanoutStage = (): StageDef => ({ kind: "produces", sessionPolicy: "fresh", loop: fanout({ units: () => [] }) });
const iterateStage = (): StageDef => ({
	kind: "produces",
	sessionPolicy: "fresh",
	loop: iterate({ next: () => null }),
});

const wf = (stages: Record<string, StageDef>): Workflow => ({
	name: "w",
	start: Object.keys(stages)[0] ?? "x",
	stages,
	edges: {},
});

describe("aliasSkills", () => {
	it("materialises an implicit skill when the stage key is aliased", () => {
		const w = wf({ commit: skillStage() });
		const out = aliasSkills(w, { commit: "attributed-commit" });
		expect(out.stages.commit?.skill).toBe("attributed-commit");
		// Input untouched — the implicit skill stays implicit on the original.
		expect(w.stages.commit?.skill).toBeUndefined();
	});

	it("remaps an explicit skill keyed by the effective skill name (not the stage id)", () => {
		const w = wf({ release: skillStage("commit") });
		const out = aliasSkills(w, { commit: "attributed-commit" });
		expect(out.stages.release?.skill).toBe("attributed-commit");
	});

	it("skips prompt stages (no /skill: dispatch) — returns the same reference", () => {
		const w = wf({ p: promptStage() });
		expect(aliasSkills(w, { p: "x" })).toBe(w);
	});

	it("skips run (script) stages — returns the same reference", () => {
		const w = wf({ s: runStage() });
		expect(aliasSkills(w, { s: "x" })).toBe(w);
	});

	it("aliases fanout and iterate stages (they still dispatch a skill)", () => {
		const w = wf({ impl: fanoutStage(), gen: iterateStage() });
		const out = aliasSkills(w, { impl: "impl2", gen: "gen2" });
		expect(out.stages.impl?.skill).toBe("impl2");
		expect(out.stages.gen?.skill).toBe("gen2");
	});

	it("resolves one hop only — never follows the target as a new alias key", () => {
		const w = wf({ a: skillStage() });
		const out = aliasSkills(w, { a: "b", b: "c" });
		expect(out.stages.a?.skill).toBe("b");
	});

	it("returns the same reference for an empty alias map", () => {
		const w = wf({ commit: skillStage() });
		expect(aliasSkills(w, {})).toBe(w);
	});

	it("returns the same reference when no stage matches an alias key", () => {
		const w = wf({ commit: skillStage() });
		expect(aliasSkills(w, { nonexistent: "x" })).toBe(w);
	});

	it("treats an identity alias (target === effective) as a no-op", () => {
		const w = wf({ commit: skillStage() });
		expect(aliasSkills(w, { commit: "commit" })).toBe(w);
	});

	it("freezes the rewritten workflow", () => {
		const w = wf({ commit: skillStage() });
		const out = aliasSkills(w, { commit: "attributed-commit" });
		expect(Object.isFrozen(out)).toBe(true);
	});

	it("preserves untouched stages while remapping matched ones", () => {
		const w = wf({ research: skillStage(), commit: skillStage() });
		const out = aliasSkills(w, { commit: "attributed-commit" });
		expect(out.stages.research?.skill).toBeUndefined();
		expect(out.stages.commit?.skill).toBe("attributed-commit");
	});

	it("is reachable from the package barrel (locks the public-surface contract)", async () => {
		// Reference identity ratifies (a) the export exists on the main barrel and
		// (b) it points at the same function as the deep-path import — catches a
		// future barrel-clean PR that silently drops the export. Workspaces resolve
		// `@juicesharp/rpiv-workflow` via the `node_modules/@juicesharp/rpiv-workflow`
		// symlink back to this package; Node deduplicates by realpath, so both
		// imports land on the same module instance.
		const { aliasSkills: fromBarrel } = await import("@juicesharp/rpiv-workflow");
		expect(fromBarrel).toBe(aliasSkills);
	});
});

// ---------------------------------------------------------------------------
// applySkillAliases — orchestrator helper: merge + snapshot + remap + warn,
// with per-source-layer attribution on no-op warnings.
// ---------------------------------------------------------------------------

const makeAcc = (workflows: Workflow[]): LoadAccumulator => {
	const workflowMap = new Map<string, Workflow>();
	for (const w of workflows) workflowMap.set(w.name, w);
	return {
		issues: [],
		workflowMap,
		sources: new Map(),
		sourcePaths: new Map(),
	};
};

const layerOutcome = (skillAliases?: Record<string, string>): LayerOutcome => ({
	contributed: skillAliases != null,
	configDefault: undefined,
	skillAliases,
});

describe("applySkillAliases", () => {
	it("returns an empty merged map and emits no warnings when no layer declares aliases", () => {
		const acc = makeAcc([wf({ commit: skillStage() })]);
		const merged = applySkillAliases(acc, layerOutcome(), layerOutcome());
		expect(merged).toEqual({});
		expect(acc.issues).toEqual([]);
		// Workflow untouched — early-exit before the rewrite loop.
		expect(acc.workflowMap.get("w")?.stages.commit?.skill).toBeUndefined();
	});

	it("merges project over user per key", () => {
		const acc = makeAcc([wf({ impl: skillStage("implement") })]);
		const merged = applySkillAliases(
			acc,
			layerOutcome({ implement: "user-impl", extra: "user-extra" }),
			layerOutcome({ implement: "proj-impl" }),
		);
		expect(merged).toEqual({ implement: "proj-impl", extra: "user-extra" });
	});

	it("rewrites every workflow in the accumulator to use aliased skills", () => {
		const acc = makeAcc([wf({ commit: skillStage() })]);
		applySkillAliases(acc, layerOutcome(), layerOutcome({ commit: "attributed-commit" }));
		expect(acc.workflowMap.get("w")?.stages.commit?.skill).toBe("attributed-commit");
	});

	it("attributes a no-op warning to `user` when only the user layer declares the key", () => {
		const acc = makeAcc([wf({ commit: skillStage() })]);
		applySkillAliases(acc, layerOutcome({ nope: "x" }), layerOutcome());
		expect(acc.issues).toEqual([
			{
				kind: "load",
				layer: "user",
				severity: "warning",
				message: `skillAliases: "nope" matches no dispatched skill in any workflow (no-op).`,
			},
		]);
	});

	it("attributes a no-op warning to `project` when only the project layer declares the key", () => {
		const acc = makeAcc([wf({ commit: skillStage() })]);
		applySkillAliases(acc, layerOutcome(), layerOutcome({ nope: "x" }));
		expect(acc.issues).toEqual([
			{
				kind: "load",
				layer: "project",
				severity: "warning",
				message: `skillAliases: "nope" matches no dispatched skill in any workflow (no-op).`,
			},
		]);
	});

	it("emits TWO warnings — one per layer — when the same no-op key is declared by both layers", () => {
		const acc = makeAcc([wf({ commit: skillStage() })]);
		applySkillAliases(acc, layerOutcome({ nope: "u" }), layerOutcome({ nope: "p" }));
		const layers = acc.issues
			.filter((i) => i.kind === "load" && /matches no dispatched skill/.test(i.message))
			.map((i) => i.layer)
			.sort();
		expect(layers).toEqual(["project", "user"]);
	});

	it("snapshots dispatched skills BEFORE remap — alias targets freshly introduced by this remap are no-ops", () => {
		// Workflow dispatches `commit`. Alias `commit → fresh-target`. A second
		// alias `fresh-target → x` must be a no-op because the snapshot was
		// taken before the first remap took effect.
		const acc = makeAcc([wf({ commit: skillStage() })]);
		applySkillAliases(acc, layerOutcome(), layerOutcome({ commit: "fresh-target", "fresh-target": "x" }));
		const noOps = acc.issues.filter((i) => i.kind === "load" && /matches no dispatched skill/.test(i.message));
		expect(noOps).toHaveLength(1);
		expect(noOps[0]).toMatchObject({
			layer: "project",
			message: expect.stringMatching(/"fresh-target"/),
		});
	});
});
