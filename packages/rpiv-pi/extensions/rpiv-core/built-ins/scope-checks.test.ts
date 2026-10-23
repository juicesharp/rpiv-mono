/**
 * scope-checks.test.ts — lane-level implement scope floor, validate-report
 * scope acceptance, and the untracked-excess quarantine arm, moved verbatim
 * from built-in-workflows.test.ts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EdgeFn, RunView } from "@juicesharp/rpiv-workflow";
import { takeRouteNote } from "@juicesharp/rpiv-workflow/internal";
import { fs as fsHandle } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkflow } from "../workflow-test-harness.ts";

describe("build implement-scope-check (lane-level scope floor)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-build-scope-"));
		// The scope-check reads `git status --porcelain` against cwd, so make the
		// tmpDir a real git repo: an un-tracked file IS a dirty path git reports.
		// A non-repo cwd degrades to an empty dirty set (pass) — tested separately.
		execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const scopeRun = () => {
		const stage = findWorkflow("build").stages["implement-scope-check"];
		if (!stage?.run) throw new Error("build implement-scope-check stage has no run function");
		return stage.run as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			data: Record<string, unknown>;
		};
	};
	const out = (rel: string, role?: string) => ({
		artifacts: role ? [{ handle: fsHandle(rel), role }] : [{ handle: fsHandle(rel) }],
		data: undefined,
		kind: "",
		meta: {},
	});
	// Write the plan and the baseline JSON; return the RunView shape the stage reads.
	const seed = (planRel: string, planBody: string, baselineRel: string, baselinePaths: string[]) => {
		const parts = planRel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, planRel), planBody);
		const bparts = baselineRel.split("/");
		mkdirSync(join(tmpDir, ...bparts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, baselineRel), JSON.stringify({ paths: baselinePaths }, null, 2));
		return {
			named: {
				plans: [out(planRel)],
				goal: [out(".rpiv/artifacts/goal/goal-t.md"), out(baselineRel, "baseline")],
			},
		} as unknown as RunView;
	};
	const plan = (filesLines: string[], phaseCount: number) =>
		`---\nstatus: ready\nphase_count: ${phaseCount}\nphases:\n${filesLines
			.map((l) => `  - { n: ${phaseCount}, title: P, files: [${l}] }`)
			.join("\n")}\n---\n## Phase ${phaseCount}: P\n`;
	// Make `path` dirty so `git status --porcelain` reports it. `git add` keeps
	// these cases on the tracked-file report path; the untracked-directory shape
	// (git's default collapse to `?? dir/`, defused by -uall) is exercised by the
	// dedicated regression cases below via un-added writes.
	const dirty = (rel: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), "x\n");
		execFileSync("git", ["add", "--", rel], { cwd: tmpDir, stdio: "ignore" });
	};
	// Write WITHOUT `git add` — the file stays untracked, so without -uall git
	// collapses its brand-new parent directory to a single `?? dir/` entry.
	const dirtyUntracked = (rel: string) => {
		const parts = rel.split("/");
		mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), "x\n");
	};

	it("passes when every dirty path is declared in the plan's files: union", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/foo.ts");
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.dimension).toBe("scope");
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("fails on an undeclared dirty path (the stray write)", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/foo.ts"); // declared
		dirty("packages/a/stray.ts"); // undeclared, staged (tracked) → excess tier
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(false);
		expect(data.verdict).toBe("excess"); // tracked → demoted-and-adjudicated tier
		expect(data.severity).toBe("high");
		expect(String(data.feedback)).toMatch(/packages\/a\/stray\.ts/);
		expect(String(data.feedback)).toMatch(/Undeclared write/);
	});

	// Twin expansion (the 5de3 halt class): a declared production file carries its
	// co-located test twin — a signature change legitimately drags the twin's
	// assertions along, so the mechanical follow-up edit is not a stray write.
	it("passes a dirty co-located test twin of a declared production file", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/foo.ts"); // declared
		dirty("packages/a/foo.test.ts"); // twin of declared → within scope
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("twin expansion is asymmetric — declaring x.test.ts does not license writing x.ts", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.test.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/foo.test.ts"); // declared
		dirty("packages/a/foo.ts"); // production twin NOT licensed → excess
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/packages\/a\/foo\.ts/);
	});

	it("a dirty NON-twin test file still fails the floor", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/foo.ts"); // declared
		dirty("packages/a/bar.test.ts"); // not foo's twin → excess
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/packages\/a\/bar\.test\.ts/);
	});

	// Regression (post-a777 run halt at 2026-07-28T03:12Z): git's default status
	// collapses a wholly-untracked directory to one `?? dir/` entry, which can
	// never string-match a declared FILE path — a phase creating exactly its
	// declared files under a brand-new directory false-failed the floor. The
	// -uall flag enumerates untracked files individually.
	it("passes declared files created in a brand-new untracked directory (untracked-dir collapse)", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"pkgs/skills/x/_helpers/check.mjs", "pkgs/skills/x/_helpers/check.test.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirtyUntracked("pkgs/skills/x/_helpers/check.mjs");
		dirtyUntracked("pkgs/skills/x/_helpers/check.test.ts");
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("fails an UNDECLARED file in a new untracked directory, naming the full path (not the collapsed dir)", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"pkgs/skills/x/_helpers/check.mjs"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirtyUntracked("pkgs/skills/x/_helpers/check.mjs"); // declared
		dirtyUntracked("pkgs/skills/x/_helpers/stray.mjs"); // undeclared → excess
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(false);
		// All excess is untracked (`??`) → the deterministically-remediable tier.
		expect(data.verdict).toBe("untracked-only");
		expect(data.severity).toBe("medium");
		expect(String(data.feedback)).toMatch(/pkgs\/skills\/x\/_helpers\/stray\.mjs/);
	});

	// Regression: run 2026-08-20_18-10-39-17e7. A validate-fix round left two
	// scratch scripts in an untracked `.tmp/` and the floor's terminal fail killed
	// a functionally green 5-hour run. The tier now routes that shape to the
	// quarantine arm instead; ANY tracked excess still escalates the whole verdict
	// (one stomp taints the tree — quarantining the untracked remainder wouldn't
	// make it judgeable-clean).
	it("mixed tracked + untracked excess folds to the tracked tier (excess)", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/stray.ts"); // tracked excess
		dirtyUntracked(".tmp/check-c3r2.mjs"); // untracked excess
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.verdict).toBe("excess");
		expect(data.severity).toBe("high");
		const wheres = (data.findings as { where: string }[]).map((f) => f.where).sort();
		expect(wheres).toEqual([".tmp/check-c3r2.mjs", "packages/a/stray.ts"]);
	});

	it("subtracts run-start baseline paths (pre-existing dirt is not the run's fault)", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			["packages/a/pre-existing.ts"],
		);
		dirty("packages/a/pre-existing.ts"); // dirty AND in baseline → subtracted
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("subtracts .rpiv/ and thoughts/ bookkeeping paths", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty(".rpiv/artifacts/x.json"); // bookkeeping → subtracted
		dirty("thoughts/y.md"); // bookkeeping → subtracted
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("is inert (pass) for a files:-less plan — empty-declared degradation", () => {
		// No `files:` key on the phase ⇒ phaseFiles yields [] ⇒ declared=[] ⇒ scopeExcess([]).
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: P }\n---\n## Phase 1: P\n`,
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/anything.ts"); // would be excess, but declared=[] ⇒ inert
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(true);
		expect(data.findings).toEqual([]);
	});

	it("writes the verdict to a basename-keyed fs artifact (idempotent across the build loop)", () => {
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			plan(['"packages/a/foo.ts"'], 1),
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/stray.ts");
		const result = scopeRun()({ cwd: tmpDir, input: undefined, state });
		expect(result.data.artifact).toBe(".rpiv/artifacts/plans/p.md");
		// Basename-keyed off the plan: implement-scope-check__p.json
		const verdict = JSON.parse(
			readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/implement-scope-check__p.json"), "utf-8"),
		);
		expect(verdict.dimension).toBe("scope");
		expect(verdict.pass).toBe(false);
	});

	it("degrades to pass (empty dirty) when cwd is not a git repo — never throws", () => {
		const nonRepo = mkdtempSync(join(tmpdir(), "rpiv-build-scope-nongit-"));
		try {
			// Write the plan + baseline into the non-repo cwd.
			const planRel = ".rpiv/artifacts/plans/p.md";
			const parts = planRel.split("/");
			mkdirSync(join(nonRepo, ...parts.slice(0, -1)), { recursive: true });
			writeFileSync(join(nonRepo, planRel), plan(['"packages/a/foo.ts"'], 1));
			const baselineRel = ".rpiv/artifacts/goal/baseline-t.json";
			const bparts = baselineRel.split("/");
			mkdirSync(join(nonRepo, ...bparts.slice(0, -1)), { recursive: true });
			writeFileSync(join(nonRepo, baselineRel), JSON.stringify({ paths: [] }, null, 2));
			const state = {
				named: {
					plans: [out(planRel)],
					goal: [out(".rpiv/artifacts/goal/goal-t.md"), out(baselineRel, "baseline")],
				},
			} as unknown as RunView;
			const data = scopeRun()({ cwd: nonRepo, input: undefined, state }).data;
			expect(data.pass).toBe(true); // empty dirty ⇒ no excess ⇒ pass
			expect(data.findings).toEqual([]);
		} finally {
			rmSync(nonRepo, { recursive: true, force: true });
		}
	});

	it("reads the declared union across MULTIPLE phases (not just the first)", () => {
		// Two phases with disjoint files: unions both into the declared set.
		const state = seed(
			".rpiv/artifacts/plans/p.md",
			`---\nstatus: ready\nphase_count: 2\nphases:\n  - { n: 1, title: A, files: ["packages/a/x.ts"] }\n  - { n: 2, title: B, files: ["packages/b/y.ts"] }\n---\n## Phase 1: A\n## Phase 2: B\n`,
			".rpiv/artifacts/goal/baseline-t.json",
			[],
		);
		dirty("packages/a/x.ts"); // phase 1's declared write
		dirty("packages/b/y.ts"); // phase 2's declared write
		dirty("packages/c/stray.ts"); // declared by NEITHER → excess
		const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
		expect(data.pass).toBe(false);
		expect(String(data.feedback)).toMatch(/packages\/c\/stray\.ts/);
		expect(String(data.feedback)).not.toMatch(/packages\/a\/x\.ts/);
		expect(String(data.feedback)).not.toMatch(/packages\/b\/y\.ts/);
	});

	// Honest pass-through: the excess pick is a DEFERRAL, not a pass;
	// its note names the downstream adjudicator so the recap's routingNotes
	// surface it. takeRouteNote is read-and-clear, so each assertion drains
	// what the pick just attached.
	const edgeOf = (wf: string) => {
		const edge = findWorkflow(wf).edges["implement-scope-check"];
		if (typeof edge !== "function") throw new Error(`${wf} implement-scope-check edge is not an EdgeFn`);
		return edge;
	};
	const routeState = (verdict: string) =>
		({ named: { "implement-scope-check": [{ data: { verdict } }] } }) as unknown as RunView;

	it("excess pick attaches the pass-through note naming validate; the pass pick attaches none", () => {
		const edge = edgeOf("build");
		expect((edge as EdgeFn)({ state: routeState("excess"), output: undefined })).toBe("reconcile");
		expect(takeRouteNote(edge)).toBe("pass-through: implement-scope-check defers to validate");
		// A clean pass needs no explanation.
		expect((edge as EdgeFn)({ state: routeState("pass"), output: undefined })).toBe("reconcile");
		expect(takeRouteNote(edge)).toBeUndefined();
		// The quarantine arm and the integrity stop are unchanged: no note on
		// untracked-only (its verdict speaks via the quarantine manifest), and the
		// integrity stop keeps its own note.
		expect((edge as EdgeFn)({ state: routeState("untracked-only"), output: undefined })).toBe("scope-quarantine");
		expect(takeRouteNote(edge)).toBeUndefined();
	});

	it("vet twin: the excess pick names code-review (the review loop adjudicates, not validate)", () => {
		const edge = edgeOf("vet");
		expect((edge as EdgeFn)({ state: routeState("excess"), output: undefined })).toBe("reconcile");
		expect(takeRouteNote(edge)).toBe("pass-through: implement-scope-check defers to code-review");
	});

	describe("validate-report scope acceptance", () => {
		// Seed the two acceptance channels onto the floor's RunView: the latest
		// validation row (data.verdict + data.blockers) and, when given, the
		// latest remediation digest row whose meta.ts must STRICTLY postdate the
		// report — the publication-order discriminator of a validate-fix hop.
		const seedChannels = (opts: { validationTs: string; blockers?: unknown; remediationTs?: string }): RunView => {
			const state = seed(
				".rpiv/artifacts/plans/p.md",
				plan(['"packages/a/foo.ts"'], 1),
				".rpiv/artifacts/goal/baseline-t.json",
				[],
			) as { named: Record<string, unknown> };
			state.named.validation = [
				{
					...out(".rpiv/artifacts/validation/r1.md"),
					data: { verdict: "fail", blockers: opts.blockers },
					meta: { ts: opts.validationTs },
				},
			];
			if (opts.remediationTs !== undefined) {
				state.named.remediation = [
					{
						...out(".rpiv/artifacts/plans/p.md"),
						data: { changed: true },
						meta: { ts: opts.remediationTs },
					},
				];
			}
			return state as unknown as RunView;
		};
		const blocker = (file: string) => ({ id: "b1", command: "npm test", file });

		it("accepts a blocker-named dirty path on the validate-fix re-entry (verdict folds to pass, data + persisted JSON stamped)", () => {
			const state = seedChannels({
				validationTs: "2026-09-04T10:00:00-0400",
				// Named twice (deduped) and out of order (sorted) — the accepted set is a
				// deduped, sorted file list.
				blockers: [blocker("packages/z/late.ts"), blocker("packages/b/fix.ts"), blocker("packages/b/fix.ts")],
				remediationTs: "2026-09-04T11:00:00-0400",
			});
			dirty("packages/a/foo.ts"); // declared by the plan
			dirty("packages/b/fix.ts"); // named by a blockers entry → accepted
			dirty("packages/z/late.ts"); // named by a blockers entry → accepted
			const result = scopeRun()({ cwd: tmpDir, input: undefined, state });
			expect(result.data.pass).toBe(true);
			expect(result.data.findings).toEqual([]);
			expect(result.data.declaredBy).toBe("validate-report");
			expect(result.data.accepted).toEqual(["packages/b/fix.ts", "packages/z/late.ts"]);
			const persisted = JSON.parse(
				readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/implement-scope-check__p.json"), "utf-8"),
			);
			expect(persisted.declaredBy).toBe("validate-report");
			expect(persisted.accepted).toEqual(["packages/b/fix.ts", "packages/z/late.ts"]);
		});

		it("an UNNAMED dirty twin of the accepted hop stays the sole finding (the named path never rides --scope into validate)", () => {
			const state = seedChannels({
				validationTs: "2026-09-04T10:00:00-0400",
				blockers: [blocker("packages/b/fix.ts")],
				remediationTs: "2026-09-04T11:00:00-0400",
			});
			dirty("packages/a/foo.ts"); // declared
			dirty("packages/b/fix.ts"); // named → accepted
			dirty("packages/c/stray.ts"); // unnamed → the sole finding
			const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
			expect(data.pass).toBe(false);
			expect(data.verdict).toBe("excess");
			expect(String(data.feedback)).toMatch(/packages\/c\/stray\.ts/);
			expect(String(data.feedback)).not.toMatch(/packages\/b\/fix\.ts/);
			expect((data.findings as { where: string }[]).map((f) => f.where)).toEqual(["packages/c/stray.ts"]);
		});

		it("refuses when the validation report is NEWER than the remediation (the re-validation shape)", () => {
			const state = seedChannels({
				validationTs: "2026-09-04T12:00:00-0400",
				blockers: [blocker("packages/b/fix.ts")],
				remediationTs: "2026-09-04T11:00:00-0400",
			});
			dirty("packages/a/foo.ts");
			dirty("packages/b/fix.ts"); // named, but the newer report supersedes → finding
			const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
			expect(data.pass).toBe(false);
			expect(String(data.feedback)).toMatch(/packages\/b\/fix\.ts/);
			expect(data.declaredBy).toBeUndefined();
			expect(data.accepted).toBeUndefined();
		});

		it("refuses with no remediation row (the first entry / a quarantine re-entry)", () => {
			const state = seedChannels({
				validationTs: "2026-09-04T10:00:00-0400",
				blockers: [blocker("packages/b/fix.ts")],
			});
			dirty("packages/a/foo.ts");
			dirty("packages/b/fix.ts");
			const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
			expect(data.pass).toBe(false);
			expect(String(data.feedback)).toMatch(/packages\/b\/fix\.ts/);
			expect(data.declaredBy).toBeUndefined();
		});

		it("refuses non-array blockers and skips malformed entries (fail-closed)", () => {
			for (const malformed of ["oops", undefined, [{ no: "file" }]]) {
				const state = seedChannels({
					validationTs: "2026-09-04T10:00:00-0400",
					blockers: malformed,
					remediationTs: "2026-09-04T11:00:00-0400",
				});
				dirty("packages/a/foo.ts");
				dirty("packages/b/fix.ts");
				const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
				expect(data.pass, `blockers=${JSON.stringify(malformed)}`).toBe(false);
				expect(String(data.feedback), `blockers=${JSON.stringify(malformed)}`).toMatch(/packages\/b\/fix\.ts/);
			}
		});

		it("accepted paths match VERBATIM — no twin expansion (naming x.ts accepts x.ts, never x.test.ts)", () => {
			const state = seedChannels({
				validationTs: "2026-09-04T10:00:00-0400",
				blockers: [blocker("packages/b/fix.ts")],
				remediationTs: "2026-09-04T11:00:00-0400",
			});
			dirty("packages/a/foo.ts");
			dirty("packages/b/fix.ts"); // named → accepted
			dirty("packages/b/fix.test.ts"); // NOT named; acceptance is verbatim → finding
			const data = scopeRun()({ cwd: tmpDir, input: undefined, state }).data;
			expect(data.pass).toBe(false);
			expect((data.findings as { where: string }[]).map((f) => f.where)).toEqual(["packages/b/fix.test.ts"]);
			expect(data.accepted).toEqual(["packages/b/fix.ts"]);
		});

		it("the stage reads stay [plans, goal] — acceptance reads defensively off state.named, never halting the first entry", () => {
			// The acceptance reads `validation`/`remediation` off `state.named`
			// WITHOUT declaring them: a declared read halts the first, pre-validate
			// entry (channels still unfilled). Build and ship share the run function,
			// so both stay reads-verbatim.
			for (const name of ["build", "ship"]) {
				expect(findWorkflow(name).stages["implement-scope-check"]?.reads, name).toEqual(["plans", "goal"]);
			}
		});
	});
});

// ---------------------------------------------------------------------------
// Verdict envelope scores — the two deterministic verdict writers' tier arms,
// pinned directly on the WRITERS (not the stages). `score`/`severity` have zero
// routing consumers (gates key off `pass` + severity-floor folds); these pins
// freeze what the persisted JSON says so a tier change can never drift
// silently. Plain-findings emissions stay byte-identical to the pre-widening
// shape: no `advisory` key, no `declaredBy`/`accepted` (key-omission idiom).
// ---------------------------------------------------------------------------
describe("build scope-quarantine (untracked-excess remedy arm)", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-build-quarantine-"));
		execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	const quarantineRun = () => {
		const stage = findWorkflow("build").stages["scope-quarantine"];
		if (!stage?.run) throw new Error("build scope-quarantine stage has no run function");
		return stage.run as unknown as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			data: { moved: { from: string; to: string }[]; refused: { path: string; reason: string }[] };
			artifacts: { handle: { kind: string; path: string } }[];
		};
	};
	const out = (rel: string) => ({ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} });
	const verdictEntry = (wheres: string[]) => ({
		artifacts: [],
		data: { verdict: "untracked-only", findings: wheres.map((where) => ({ detail: "x", where })) },
		kind: "json",
		meta: {},
	});
	const stateOf = (wheres: string[]) =>
		({
			named: {
				plans: [out(".rpiv/artifacts/plans/p.md")],
				"implement-scope-check": [verdictEntry(wheres)],
			},
		}) as unknown as RunView;
	const untrackedFile = (rel: string, content = "x\n") => {
		const parts = rel.split("/");
		if (parts.length > 1) mkdirSync(join(tmpDir, ...parts.slice(0, -1)), { recursive: true });
		writeFileSync(join(tmpDir, rel), content);
	};

	// Mechanical proof of "at most one quarantine hop per gate entry": after the
	// move, the re-check's untracked-excess set is empty (the quarantined copies
	// live under the exempt .rpiv/ tree), so the second verdict can never be
	// "untracked-only" again — the loop converges to pass (or reveals tracked
	// drift), never ping-pongs.
	it("check → quarantine → re-check converges: the second verdict is pass, never untracked-only again", () => {
		const planRel = ".rpiv/artifacts/plans/p.md";
		mkdirSync(join(tmpDir, ".rpiv/artifacts/plans"), { recursive: true });
		writeFileSync(
			join(tmpDir, planRel),
			`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: P, files: ["packages/a/foo.ts"] }\n---\n## Phase 1: P\n`,
		);
		const baselineRel = ".rpiv/artifacts/goal/baseline-t.json";
		mkdirSync(join(tmpDir, ".rpiv/artifacts/goal"), { recursive: true });
		writeFileSync(join(tmpDir, baselineRel), JSON.stringify({ paths: [] }, null, 2));
		untrackedFile(".tmp/scratch.mjs");

		const checkStage = findWorkflow("build").stages["implement-scope-check"];
		if (!checkStage?.run) throw new Error("build implement-scope-check stage has no run function");
		const checkRun = checkStage.run as unknown as (ctx: { cwd: string; input?: undefined; state: RunView }) => {
			data: Record<string, unknown>;
		};
		const checkState = {
			named: {
				plans: [out(planRel)],
				goal: [
					out(".rpiv/artifacts/goal/goal-t.md"),
					{
						artifacts: [{ handle: fsHandle(baselineRel), role: "baseline" }],
						data: undefined,
						kind: "",
						meta: {},
					},
				],
			},
		} as unknown as RunView;

		const first = checkRun({ cwd: tmpDir, input: undefined, state: checkState });
		expect(first.data.verdict).toBe("untracked-only");

		const quarantineState = {
			named: {
				...(checkState as unknown as { named: Record<string, unknown> }).named,
				"implement-scope-check": [{ artifacts: [], data: first.data, kind: "json", meta: {} }],
			},
		} as unknown as RunView;
		quarantineRun()({ cwd: tmpDir, input: undefined, state: quarantineState });

		const second = checkRun({ cwd: tmpDir, input: undefined, state: checkState });
		expect(second.data.verdict).toBe("pass");
		expect(second.data.findings).toEqual([]);
	});

	it("moves listed untracked files under .rpiv/tmp/scope-quarantine/ and writes the manifest", () => {
		untrackedFile(".tmp/check-c3r2.mjs", "console.log(1)\n");
		untrackedFile(".tmp/check-c4r5.mjs", "console.log(2)\n");
		const result = quarantineRun()({
			cwd: tmpDir,
			input: undefined,
			state: stateOf([".tmp/check-c3r2.mjs", ".tmp/check-c4r5.mjs"]),
		});
		// Moved, not deleted: content survives at the quarantine path, source is gone.
		expect(existsSync(join(tmpDir, ".tmp/check-c3r2.mjs"))).toBe(false);
		expect(readFileSync(join(tmpDir, ".rpiv/tmp/scope-quarantine/.tmp/check-c3r2.mjs"), "utf-8")).toBe(
			"console.log(1)\n",
		);
		expect(result.data.moved).toEqual([
			{ from: ".tmp/check-c3r2.mjs", to: join(".rpiv/tmp/scope-quarantine", ".tmp/check-c3r2.mjs") },
			{ from: ".tmp/check-c4r5.mjs", to: join(".rpiv/tmp/scope-quarantine", ".tmp/check-c4r5.mjs") },
		]);
		// Manifest basename-keyed off the plan, beside the scope verdict.
		const manifest = JSON.parse(
			readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/scope-quarantine__p.json"), "utf-8"),
		);
		expect(manifest.moved).toHaveLength(2);
		expect(result.artifacts[0]?.handle.path).toBe(join(".rpiv/artifacts/verdicts", "scope-quarantine__p.json"));
	});

	it("never touches a listed path that is tracked (or otherwise not untracked) at move time — recorded as refused", () => {
		untrackedFile("packages/a/kept.ts", "v0\n");
		execFileSync("git", ["add", "--", "packages/a/kept.ts"], { cwd: tmpDir, stdio: "ignore" });
		const result = quarantineRun()({ cwd: tmpDir, input: undefined, state: stateOf(["packages/a/kept.ts"]) });
		expect(result.data.moved).toEqual([]);
		expect(result.data.refused).toEqual([{ path: "packages/a/kept.ts", reason: "not-untracked-at-move-time" }]);
		expect(readFileSync(join(tmpDir, "packages/a/kept.ts"), "utf-8")).toBe("v0\n");
	});

	it("refuses a cwd-escaping finding path (containedPath guard) without throwing — recorded as refused", () => {
		// Cannot arise from `git status` (which reports repo-relative paths only) —
		// belt-and-braces against a corrupt verdict JSON on the channel. The
		// escaping path is refused by the untracked check first; either way it
		// lands in `refused`, observable without re-running the floor.
		const result = quarantineRun()({ cwd: tmpDir, input: undefined, state: stateOf(["../escape.txt"]) });
		expect(result.data.moved).toEqual([]);
		expect((result.data.refused as { path: string }[]).map((r) => r.path)).toEqual(["../escape.txt"]);
	});

	it("is idempotent — a re-run finds nothing untracked, and the manifest KEEPS round 1's moves", () => {
		untrackedFile(".tmp/scratch.mjs");
		const state = stateOf([".tmp/scratch.mjs"]);
		quarantineRun()({ cwd: tmpDir, input: undefined, state });
		const second = quarantineRun()({ cwd: tmpDir, input: undefined, state });
		expect(second.data.moved).toEqual([]);
		expect(readFileSync(join(tmpDir, ".rpiv/tmp/scope-quarantine/.tmp/scratch.mjs"), "utf-8")).toBe("x\n");
		// Merge-on-write: the re-run's empty round must not erase the recorded move.
		const manifest = JSON.parse(
			readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/scope-quarantine__p.json"), "utf-8"),
		);
		expect(manifest.moved).toEqual([
			{ from: ".tmp/scratch.mjs", to: join(".rpiv/tmp/scope-quarantine", ".tmp/scratch.mjs") },
		]);
	});

	// The manifest is validate's cross-round adjudication record: a validate-fix
	// re-entry that quarantines AGAIN (round 2) must not erase round 1's moves —
	// a round-2 missing-file diagnosis on a round-1-moved file consults this file.
	it("merges across rounds — a second quarantine keeps the first round's move records", () => {
		untrackedFile(".tmp/round-one.mjs");
		quarantineRun()({ cwd: tmpDir, input: undefined, state: stateOf([".tmp/round-one.mjs"]) });
		untrackedFile(".tmp/round-two.mjs");
		quarantineRun()({ cwd: tmpDir, input: undefined, state: stateOf([".tmp/round-two.mjs"]) });
		const manifest = JSON.parse(
			readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/scope-quarantine__p.json"), "utf-8"),
		);
		expect(manifest.moved).toEqual([
			{ from: ".tmp/round-one.mjs", to: join(".rpiv/tmp/scope-quarantine", ".tmp/round-one.mjs") },
			{ from: ".tmp/round-two.mjs", to: join(".rpiv/tmp/scope-quarantine", ".tmp/round-two.mjs") },
		]);
	});

	// Failure injection: the second move's destination directory is blocked by a
	// pre-created FILE, so its mkdirSync throws mid-loop. The throw must
	// propagate (fail-loud STOP on a real fs error), but the finally-write must
	// land the FIRST move in the manifest — never moved-but-unrecorded files.
	it("a mid-loop move failure still records completed moves in the manifest before failing", () => {
		untrackedFile("a/one.mjs", "one\n");
		untrackedFile("b/two.mjs", "two\n");
		mkdirSync(join(tmpDir, ".rpiv/tmp/scope-quarantine"), { recursive: true });
		writeFileSync(join(tmpDir, ".rpiv/tmp/scope-quarantine/b"), "blocker"); // file where a dir must go
		expect(() =>
			quarantineRun()({ cwd: tmpDir, input: undefined, state: stateOf(["a/one.mjs", "b/two.mjs"]) }),
		).toThrow();
		// First move completed and is recorded; second stayed in place.
		expect(readFileSync(join(tmpDir, ".rpiv/tmp/scope-quarantine/a/one.mjs"), "utf-8")).toBe("one\n");
		expect(readFileSync(join(tmpDir, "b/two.mjs"), "utf-8")).toBe("two\n");
		const manifest = JSON.parse(
			readFileSync(join(tmpDir, ".rpiv/artifacts/verdicts/scope-quarantine__p.json"), "utf-8"),
		);
		expect(manifest.moved).toEqual([{ from: "a/one.mjs", to: join(".rpiv/tmp/scope-quarantine", "a/one.mjs") }]);
	});
});
